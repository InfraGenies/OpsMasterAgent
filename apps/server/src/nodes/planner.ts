import {
  CapacityPlanSchema,
  type CapacityPlan,
  type CapacityPlanOption,
  type PlanRequest,
  type ServiceSpec,
  type StorageSpec,
  type Tier,
} from "@ops-master/shared";
import { loadPrompt } from "../llm/promptLoader.js";
import { loadSkill } from "../llm/skillLoader.js";
import { runLLMJson } from "../llm/runLLMJson.js";
import { estimateEcsFargateMonthlyCost, estimateEksMonthlyCost } from "../pricing/awsRateTable.js";
import { estimateMonthlyCost } from "../pricing/rateTable.js";
import { checkSandboxLimits, mergeCapacityPlan } from "./planMerge.js";
import { buildArchitectureRecommendation, buildEnterpriseOptions } from "./enterpriseRulesEngine.js";

// sizing-workloads is needed on every planner call regardless of request
// type; managed-service-substitution/compliance-and-dr-reasoning are
// conditional (AWS worked-example vs. enterprise mode) so they're loaded
// separately and spliced into the per-request user turn (see buildUserPrompt).
const SYSTEM_PROMPT = [loadPrompt("02-planner.md"), loadSkill("sizing-workloads")].join("\n\n");

const SCHEMA_SHAPE = `{
  "request_id": "string",
  "options": [{
    "tier": "economy" | "balanced" | "high_availability",
    "services": [{ "name": "string", "image": "string", "cpu": "string e.g. 1.0", "memory": "string e.g. 512Mi", "replicas": number, "ports": [number], "managed_service": "rds" | "dynamodb" | "elasticache" | null, "multi_az": boolean }],
    "storage": [{ "name": "string", "type": "volume", "size": "string e.g. 1Gi", "attached_to": "string, a service name" }],
    "network": { "expose": [{ "service": "string", "host_port": number }], "internal": ["string, service names with no host port"] },
    "reasoning": "3-6 sentences, plain business English, showing the arithmetic",
    "feasible": boolean,
    "infeasibility_reason": "string | null",
    "estimated_cost_usd_monthly": number,
    "headroom_pct": number,
    "availability_notes": "string, one sentence on what does/doesn't survive a failure at this tier"
  }],
  "recommended_tier": "economy" | "balanced" | "high_availability",
  "feasible": boolean,
  "infeasibility_reason": "string | null",
  "architecture_recommendation": "OMIT this field entirely unless enterprise_mode=true (see ENTERPRISE MODE note below) — when present, include an alternatives_considered array (see note)"
}`;

const AWS_TARGET_NOTE = "\n\n" + loadSkill("managed-service-substitution");
const ENTERPRISE_MODE_NOTE = "\n\n" + loadSkill("compliance-and-dr-reasoning");

function buildUserPrompt(
  planRequest: PlanRequest,
  existingPlan: CapacityPlan | null,
  humanFeedback?: string
): string {
  const modifyNote =
    planRequest.operation === "modify" && existingPlan
      ? `\n\nThis is a MODIFY of an already-running environment. Existing plan (do not repeat unless a value is actually changing):\n${JSON.stringify(existingPlan.options, null, 2)}\n\nReturn ONLY the new/changed services, storage, and network entries as the delta per tier — the backend merges this onto the existing plan.`
      : "";
  const feedbackNote = humanFeedback
    ? `\n\nA human reviewer rejected the previous plan with this feedback — address it directly:\n"${humanFeedback}"`
    : "";
  const enterpriseNote = planRequest.enterprise_mode ? ENTERPRISE_MODE_NOTE : "";
  const awsNote = !planRequest.enterprise_mode && planRequest.constraints.target === "aws" ? AWS_TARGET_NOTE : "";
  return [
    `PlanRequest:\n${JSON.stringify(planRequest, null, 2)}${modifyNote}${feedbackNote}${awsNote}${enterpriseNote}`,
    `Respond with ONLY a JSON object matching exactly this shape:\n${SCHEMA_SHAPE}`,
  ].join("\n\n");
}

function ceilReplicas(rps: number, perInstance: number, headroomPct: number, floor: number): number {
  return Math.min(4, Math.max(floor, Math.ceil((rps * (1 + headroomPct)) / perInstance)));
}

const HARD_CAP_RPS = 2000;

interface TierConfig {
  tier: Tier;
  headroomPct: number;
  replicaFloor: number;
  extraReplica: number;
}

function tierConfigs(isProd: boolean): TierConfig[] {
  const haFloor = isProd ? 2 : 1;
  return [
    { tier: "economy", headroomPct: 0, replicaFloor: 1, extraReplica: 0 },
    { tier: "balanced", headroomPct: 0.2, replicaFloor: haFloor, extraReplica: 0 },
    { tier: "high_availability", headroomPct: 0.2, replicaFloor: haFloor, extraReplica: 1 },
  ];
}

/**
 * UC-9 worked example (agent-md-files/USE_CASES.md): AWS's own
 * retail-store-sample-app, 5 services, each data dependency substituted for
 * the AWS managed equivalent rather than a container. This is a deliberately
 * fixed topology matching that repo's real service set, not a generic
 * derivation from PlanRequest.dependencies — same "worked example" scope the
 * docs describe.
 */
const RETAIL_APP_SERVICES: { name: string; lang: string; managed?: "rds" | "dynamodb" | "elasticache" }[] = [
  { name: "ui", lang: "Java" },
  { name: "catalog", lang: "Go", managed: "rds" },
  { name: "cart", lang: "Java", managed: "dynamodb" },
  { name: "orders", lang: "Java", managed: "rds" },
  { name: "checkout", lang: "Node.js", managed: "elasticache" },
];

function buildAwsOptions(planRequest: PlanRequest, humanFeedback?: string): CapacityPlanOption[] {
  function services(taskCount: number, cpu: string, memory: string, multiAz: boolean): ServiceSpec[] {
    return RETAIL_APP_SERVICES.map((s) => ({
      name: s.name,
      image: `retail-store-sample-app/${s.name} (${s.lang}; image managed by the upstream terraform module)`,
      cpu,
      memory,
      replicas: taskCount,
      ports: [8080],
      managed_service: s.managed ?? null,
      multi_az: s.managed ? multiAz : undefined,
    }));
  }

  const economyCost = estimateEcsFargateMonthlyCost(
    RETAIL_APP_SERVICES.map(() => ({ vcpu: 0.25, gib: 0.5, taskCount: 1 })),
    1
  );
  const haCost = estimateEksMonthlyCost(3, 2);

  // Topology per tier is a fixed worked example (UC-9), not derived from the
  // request — so rejection feedback can't resize it the way the generic
  // sandbox path does. Still surface it rather than silently discarding it.
  const feedbackSuffix = humanFeedback
    ? ` Reviewer feedback noted: "${humanFeedback}" — this AWS worked example's topology is fixed per UC-9, so ` +
      `switching between the economy and high-availability tiers shown here is the available response to that feedback.`
    : "";

  const economy: CapacityPlanOption = {
    tier: "economy",
    services: services(1, "0.25", "512Mi", false),
    storage: [],
    network: { expose: [], internal: [] },
    reasoning:
      "Staging traffic is low and this is cost-sensitive: one ECS Fargate task per service (0.25 vCPU / 0.5GB each) " +
      "in a single AZ, RDS db.t3.micro for catalog and orders (single-AZ), DynamoDB on-demand for cart, ElastiCache " +
      "cache.t3.micro single node for checkout, 1 ALB + 1 NAT Gateway. Acceptable because staging carries no uptime SLA." +
      feedbackSuffix,
    feasible: true,
    infeasibility_reason: null,
    estimated_cost_usd_monthly: economyCost.totalUsdMonthly,
    cost_breakdown: economyCost.breakdown,
    cost_basis: "rate_table",
    headroom_pct: 0,
    availability_notes:
      "No failover on compute or any data store — a task, AZ, or instance restart causes a brief outage; fine for a demo/staging env.",
  };

  const highAvailability: CapacityPlanOption = {
    tier: "high_availability",
    services: services(2, "0.5", "1Gi", true),
    storage: [],
    network: { expose: [], internal: [] },
    reasoning:
      "If this needs to survive an AZ failure (a prod-adjacent staging or pre-prod gate): EKS with a managed control " +
      "plane + 3x t3.medium worker nodes across 2 AZs (2 pod replicas per service), RDS db.t3.small Multi-AZ for " +
      "catalog and orders, DynamoDB on-demand with autoscaling headroom for cart, ElastiCache cache.t3.small " +
      "2-node replication group for checkout, 1 ALB + 2 NAT Gateways for multi-AZ egress. Costs roughly 2.9x more " +
      "than the economy tier but removes every single point of failure." +
      feedbackSuffix,
    feasible: true,
    infeasibility_reason: null,
    estimated_cost_usd_monthly: haCost.totalUsdMonthly,
    cost_breakdown: haCost.breakdown,
    cost_basis: "rate_table",
    headroom_pct: 0.2,
    availability_notes: "Survives an AZ outage on every tier — DB, cache, and compute all have a standby.",
  };

  void planRequest; // topology is fixed per the worked example; request only selects the AWS branch itself
  return [economy, highAvailability];
}

function mockPlanner(planRequest: PlanRequest, humanFeedback?: string): CapacityPlan {
  // Enterprise Architecture Advisor: checked before constraints.target==="aws"
  // so it never collides with UC-9's fixed retail-store-sample-app worked
  // example on that same target value — enterprise_mode is a separate signal
  // set by intake.ts.
  if (planRequest.enterprise_mode && planRequest.enterprise_context) {
    return {
      request_id: planRequest.request_id,
      options: buildEnterpriseOptions(planRequest, humanFeedback),
      recommended_tier: "balanced",
      feasible: true,
      infeasibility_reason: null,
      architecture_recommendation: buildArchitectureRecommendation(planRequest.enterprise_context),
    };
  }
  if (planRequest.constraints.target === "aws") {
    return {
      request_id: planRequest.request_id,
      options: buildAwsOptions(planRequest, humanFeedback),
      recommended_tier: "economy",
      feasible: true,
      infeasibility_reason: null,
    };
  }

  const rawLower = planRequest.raw_text.toLowerCase();
  const environmentLower = planRequest.environment.toLowerCase();
  // "~200 concurrent users/voters" with no rps stated -> rough rule of thumb
  // of 1 rps per 10 concurrent users (stated in reasoning when applied).
  const users = planRequest.expected_load.concurrent_users;
  const rps = planRequest.expected_load.rps ?? (users ? Math.max(10, Math.ceil(users / 10)) : 50);

  if (rps > HARD_CAP_RPS) {
    const fallbackReplicas = 4;
    const infeasibleOption: CapacityPlanOption = {
      tier: "economy",
      services: [],
      storage: [],
      network: { expose: [], internal: [] },
      reasoning:
        `Requested ${rps} rps exceeds the sandbox hard limit of ${HARD_CAP_RPS} rps on a single laptop. ` +
        `Proposing a scaled-down alternative of ${HARD_CAP_RPS} rps with ${fallbackReplicas} replicas instead — the largest feasible footprint for a local sandbox.`,
      feasible: false,
      infeasibility_reason: `${rps} rps exceeds sandbox limit of ${HARD_CAP_RPS} rps`,
      estimated_cost_usd_monthly: 0,
      cost_breakdown: [],
      cost_basis: "rate_table",
      headroom_pct: 0,
      availability_notes: "not deployable in this sandbox",
    };
    return {
      request_id: planRequest.request_id,
      options: [infeasibleOption],
      recommended_tier: "economy",
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

  // UC-10: a well-known off-the-shelf tool named in the request wins over the
  // generic runtime image (mirrors the prompt's "prefer a purpose-built image").
  let appPort = 3000;
  let appVolume = false;
  if (/\b(monitoring|uptime|status page|dashboard)\b/.test(rawLower) && !planRequest.repo_url) {
    image = "louislam/uptime-kuma:1";
    appPort = 3001;
    appVolume = true;
    runtimeNote = "Uptime Kuma monitoring dashboard (single instance)";
  }

  // UC-4: an explicit replica count in the request is an instruction, not a
  // sizing input — it overrides load-based sizing for every tier equally.
  const replicasHint = planRequest.raw_text.match(/(\d+)\s*replicas?\b/i);
  const explicitReplicas = replicasHint ? Math.min(4, Math.max(1, Number(replicasHint[1]))) : null;

  // A human rejection comment is a fresh instruction from the same reviewer
  // about to see this plan again — it overrides both load-based sizing and
  // the original explicit-replica request for this rework. Mirrors what the
  // real LLM path already does by reading humanFeedback in its prompt; without
  // this, mock mode reproduced the exact same plan on every reject, which is
  // indistinguishable from "reject" doing nothing at all.
  const feedbackLower = (humanFeedback ?? "").toLowerCase();
  const feedbackNumberHint = humanFeedback?.match(/(\d+)\s*replicas?\b/i);
  const feedbackReplicas = feedbackNumberHint ? Math.min(4, Math.max(1, Number(feedbackNumberHint[1]))) : null;
  const feedbackWantsFewer = /\b(fewer|reduce|less|lower|scale[\s-]?down|smaller|cheaper|too many)\b/.test(feedbackLower);
  const feedbackWantsMore = /\b(more replicas|increase|scale[\s-]?up|add (a )?replica|higher availability|too few)\b/.test(
    feedbackLower
  );

  const isProd = environmentLower.includes("prod");
  const hasDb = planRequest.dependencies.includes("postgresql") || planRequest.dependencies.includes("mysql");
  const hasRedis = planRequest.dependencies.includes("redis");

  function buildOption(cfg: TierConfig): CapacityPlanOption {
    let replicas = explicitReplicas ?? Math.min(4, ceilReplicas(rps, perInstance, cfg.headroomPct, cfg.replicaFloor) + cfg.extraReplica);
    const reasons: string[] = [];
    if (planRequest.expected_load.rps === null && users) {
      reasons.push(`~${users} concurrent users at ~1 rps per 10 users -> sizing for ~${rps} rps.`);
    }
    if (explicitReplicas !== null) {
      reasons.push(`Replica count ${replicas} set explicitly by the request (overrides load-based sizing for every tier).`);
    } else {
      const headroomNote = cfg.headroomPct > 0 ? ` with ${Math.round(cfg.headroomPct * 100)}% burst headroom` : ", sized to exact stated load";
      reasons.push(
        `${runtimeNote} at ~${perInstance} rps/instance sustained${headroomNote} -> replicas = ${replicas} (${cfg.tier} tier).`
      );
      if (cfg.replicaFloor > 1) {
        reasons.push(`Environment floor of ${cfg.replicaFloor} replicas applied (prod-adjacent, no single point of failure on the app tier).`);
      }
      if (cfg.extraReplica > 0) {
        reasons.push(`+${cfg.extraReplica} replica over the balanced tier for high-availability headroom.`);
      }
    }

    if (humanFeedback) {
      if (feedbackReplicas !== null) {
        replicas = feedbackReplicas;
        reasons.push(`Reviewer feedback set replica count to ${replicas} explicitly: "${humanFeedback}".`);
      } else if (feedbackWantsFewer) {
        replicas = Math.max(1, replicas - 1);
        reasons.push(`Reviewer feedback addressed by reducing to ${replicas} replica(s): "${humanFeedback}".`);
      } else if (feedbackWantsMore) {
        replicas = Math.min(4, replicas + 1);
        reasons.push(`Reviewer feedback addressed by increasing to ${replicas} replica(s): "${humanFeedback}".`);
      } else {
        reasons.push(`Reviewer feedback noted: "${humanFeedback}" — no specific replica/cost instruction recognized in it.`);
      }
    }

    const services: ServiceSpec[] = [{ name: "app", image, cpu, memory, replicas, ports: [appPort] }];
    const storage: StorageSpec[] = [];
    if (appVolume) {
      storage.push({ name: "appdata", type: "volume", size: "1Gi", attached_to: "app" });
      reasons.push("Persistent 1Gi volume attached so monitor history survives restarts.");
    }
    const expose: CapacityPlanOption["network"]["expose"] = [{ service: "app", host_port: appPort }];
    const internal: string[] = [];

    let availabilityNotes = replicas > 1 ? `${replicas}x app replicas` : `${replicas}x app replica(s)`;

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
    if (hasDb) {
      availabilityNotes += cfg.tier === "economy" ? ", single-instance DB (no failover)" : ", single-instance DB (sandbox can't replicate stateful services — would be Multi-AZ on a real cloud target)";
    }

    if (planRequest.dependencies.includes("redis")) {
      services.push({ name: "cache", image: "redis:7-alpine", cpu: "0.5", memory: "256Mi", replicas: 1, ports: [6379] });
      internal.push("cache");
      reasons.push("Redis sized at 1 instance / 256Mi, no volume (no persistence requested).");
    }
    if (hasRedis) availabilityNotes += ", single-instance cache";

    if (replicas > 1) {
      reasons.push("Nginx load balancer added automatically because replicas > 1 for an HTTP service.");
    }

    const cost = estimateMonthlyCost(services, storage);
    return {
      tier: cfg.tier,
      services,
      storage,
      network: { expose, internal },
      reasoning: reasons.join(" "),
      feasible: true,
      infeasibility_reason: null,
      estimated_cost_usd_monthly: cost.totalUsdMonthly,
      cost_breakdown: cost.breakdown,
      cost_basis: "rate_table",
      headroom_pct: cfg.headroomPct,
      availability_notes: availabilityNotes,
    };
  }

  const options = tierConfigs(isProd).map(buildOption);
  const recommended_tier: Tier = environmentLower.includes("dev") ? "economy" : "balanced";

  return {
    request_id: planRequest.request_id,
    options,
    recommended_tier,
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
    mock: () => mockPlanner(planRequest, humanFeedback),
    node: "planner",
  });

  let plan = result.value;
  if (planRequest.operation === "modify" && existingPlan) {
    plan = mergeCapacityPlan(existingPlan, plan);
  }

  // Sandbox memory/replica caps model this laptop's resources — meaningless
  // for an AWS target, which is never actually applied here regardless.
  if (planRequest.constraints.target !== "aws") {
    plan = checkSandboxLimits(plan, planRequest.constraints.max_memory_gb);
  }

  return { value: plan, rawResponse: result.rawResponse, mocked: result.mocked };
}

/** Resolves which single tier's flat plan should flow through the rest of the pipeline. */
export function selectOption(plan: CapacityPlan, tier?: Tier): CapacityPlanOption {
  const wanted = tier ?? plan.recommended_tier;
  return plan.options.find((o) => o.tier === wanted) ?? plan.options[0];
}
