import { CapacityPlanSchema, type CapacityPlan, type PlanRequest } from "@ops-master/shared";
import { loadPrompt } from "../llm/promptLoader.js";
import { runLLMJson } from "../llm/runLLMJson.js";
import { checkSandboxLimits, mergeCapacityPlan } from "./planMerge.js";

const SYSTEM_PROMPT = loadPrompt("02-planner.md");

const SCHEMA_SHAPE = `{
  "request_id": "string",
  "services": [{ "name": "string", "image": "string", "cpu": "string e.g. 1.0", "memory": "string e.g. 512Mi", "replicas": number, "ports": [number] }],
  "storage": [{ "name": "string", "type": "volume", "size": "string e.g. 1Gi", "attached_to": "string, a service name" }],
  "network": { "expose": [{ "service": "string", "host_port": number }], "internal": ["string, service names with no host port"] },
  "reasoning": "3-6 sentences, plain business English, showing the arithmetic",
  "feasible": boolean,
  "infeasibility_reason": "string | null"
}`;

function buildUserPrompt(
  planRequest: PlanRequest,
  existingPlan: CapacityPlan | null,
  humanFeedback?: string
): string {
  const modifyNote =
    planRequest.operation === "modify" && existingPlan
      ? `\n\nThis is a MODIFY of an already-running environment. Existing services (do not repeat unless a value is actually changing):\n${JSON.stringify(existingPlan.services, null, 2)}\n\nReturn ONLY the new/changed services, storage, and network entries as the delta — the backend merges this onto the existing plan.`
      : "";
  const feedbackNote = humanFeedback
    ? `\n\nA human reviewer rejected the previous plan with this feedback — address it directly:\n"${humanFeedback}"`
    : "";
  return [
    `PlanRequest:\n${JSON.stringify(planRequest, null, 2)}${modifyNote}${feedbackNote}`,
    `Respond with ONLY a JSON object matching exactly this shape:\n${SCHEMA_SHAPE}`,
  ].join("\n\n");
}

function ceilReplicas(rps: number, perInstance: number): number {
  return Math.min(4, Math.max(1, Math.ceil(rps / perInstance)));
}

const HARD_CAP_RPS = 2000;

function mockPlanner(planRequest: PlanRequest): CapacityPlan {
  const rps = planRequest.expected_load.rps ?? 50;

  if (rps > HARD_CAP_RPS) {
    return {
      request_id: planRequest.request_id,
      services: [],
      storage: [],
      network: { expose: [], internal: [] },
      reasoning:
        `Requested ${rps} rps exceeds the sandbox hard limit of ${HARD_CAP_RPS} rps on a single laptop. ` +
        `Proposing a scaled-down alternative of ${HARD_CAP_RPS} rps with 4 replicas instead — the largest feasible footprint for a local sandbox.`,
      feasible: false,
      infeasibility_reason: `${rps} rps exceeds sandbox limit of ${HARD_CAP_RPS} rps`,
    };
  }

  let perInstance = 250;
  let memory = "512Mi";
  let cpu = "1.0";
  let image = "node:18-alpine";
  let runtimeNote = "Node.js/Express CRUD API";
  if (planRequest.runtime === "python3.11") {
    perInstance = 150;
    image = "python:3.11-slim";
    runtimeNote = "Python/FastAPI sync";
  } else if (planRequest.runtime === "java17") {
    perInstance = 200;
    memory = "1Gi";
    image = "eclipse-temurin:17-jre";
    runtimeNote = "JVM (Spring Boot, -Xmx768m)";
  } else if (planRequest.runtime === "static") {
    perInstance = 1000;
    memory = "128Mi";
    image = "nginx:alpine";
    runtimeNote = "static site";
  }

  const replicas = ceilReplicas(rps, perInstance);
  const reasons = [
    `${runtimeNote} at ~${perInstance} rps/instance sustained -> replicas = ceil(${rps}/${perInstance}) = ${replicas}.`,
  ];

  const services: CapacityPlan["services"] = [
    { name: "app", image, cpu, memory, replicas, ports: [3000] },
  ];
  const storage: CapacityPlan["storage"] = [];
  const expose: CapacityPlan["network"]["expose"] = [{ service: "app", host_port: 3000 }];
  const internal: string[] = [];

  if (planRequest.dependencies.includes("postgresql")) {
    services.push({ name: "db", image: "postgres:16-alpine", cpu: "1.0", memory: "1Gi", replicas: 1, ports: [5432] });
    storage.push({ name: "dbdata", type: "volume", size: "1Gi", attached_to: "db" });
    internal.push("db");
    reasons.push("PostgreSQL sized at 1 instance / 1Gi with a named volume for data, never replicated in sandbox.");
  } else if (planRequest.dependencies.includes("mysql")) {
    services.push({ name: "db", image: "mysql:8", cpu: "1.0", memory: "1Gi", replicas: 1, ports: [3306] });
    storage.push({ name: "dbdata", type: "volume", size: "1Gi", attached_to: "db" });
    internal.push("db");
    reasons.push("MySQL sized at 1 instance / 1Gi with a named volume for data, never replicated in sandbox.");
  }

  if (planRequest.dependencies.includes("redis")) {
    services.push({ name: "cache", image: "redis:7-alpine", cpu: "0.5", memory: "256Mi", replicas: 1, ports: [6379] });
    internal.push("cache");
    reasons.push("Redis sized at 1 instance / 256Mi, no volume (no persistence requested).");
  }

  if (replicas > 1) {
    reasons.push("Nginx load balancer added automatically because replicas > 1 for an HTTP service.");
  }

  return {
    request_id: planRequest.request_id,
    services,
    storage,
    network: { expose, internal },
    reasoning: reasons.join(" "),
    feasible: true,
    infeasibility_reason: null,
  };
}

export async function runPlanner(
  planRequest: PlanRequest,
  existingPlan: CapacityPlan | null,
  humanFeedback?: string
): Promise<{ value: CapacityPlan; rawResponse: string; mocked: boolean }> {
  const result = await runLLMJson({
    schema: CapacityPlanSchema,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(planRequest, existingPlan, humanFeedback),
    mock: () => mockPlanner(planRequest),
    node: "planner",
  });

  let plan = result.value;
  if (planRequest.operation === "modify" && existingPlan) {
    plan = mergeCapacityPlan(existingPlan, plan);
  }

  if (plan.feasible) {
    const limitCheck = checkSandboxLimits(plan, planRequest.constraints.max_memory_gb);
    if (!limitCheck.feasible) {
      plan = { ...plan, feasible: false, infeasibility_reason: limitCheck.reason };
    }
  }

  return { value: plan, rawResponse: result.rawResponse, mocked: result.mocked };
}
