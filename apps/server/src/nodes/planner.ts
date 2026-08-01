import {
  ArchitectureRecommendationSchema,
  CapacityPlanOptionSchema,
  CapacityPlanSchema,
  type ArchitectureRecommendation,
  type CapacityPlan,
  type CapacityPlanOption,
  type ComponentNote,
  type PlanRequest,
  type ScalingStrategy,
  type ServiceSpec,
  type StorageSpec,
  type TaskGraphStep,
  type Tier,
} from "@ops-master/shared";
import { z } from "zod";
import { isMockMode } from "../llm/client.js";
import { loadPrompt } from "../llm/promptLoader.js";
import { loadSkill } from "../llm/skillLoader.js";
import { runLLMJson } from "../llm/runLLMJson.js";
import { estimateEcsFargateMonthlyCost, estimateEksMonthlyCost } from "../pricing/awsRateTable.js";
import { estimateMonthlyCost } from "../pricing/rateTable.js";
import { checkSandboxLimits, mergeCapacityPlan } from "./planMerge.js";
import {
  ARCHETYPE_REASONING,
  archetypeForOrgScale,
  buildArchitectureRecommendation,
  buildEnterpriseOptions,
  classifyOrgScale,
} from "./enterpriseRulesEngine.js";
import { BUILD_REGISTRY, BUILD_SENTINEL_PREFIX } from "./buildRegistry.js";

// sizing-workloads is needed on every planner call regardless of request
// type; managed-service-substitution/compliance-and-dr-reasoning are
// conditional (AWS worked-example vs. enterprise mode) so they're loaded
// separately and spliced into the per-request user turn (see buildUserPrompt).
const SYSTEM_PROMPT = [loadPrompt("02-planner.md"), loadSkill("sizing-workloads")].join("\n\n");

/** One priced tier's JSON grammar — reused verbatim across the generic schema shape and both enterprise passes so they never drift apart. */
const CAPACITY_PLAN_OPTION_SHAPE = `{
    "tier": "economy" | "balanced" | "high_availability",
    "services": [{ "name": "string", "image": "string", "cpu": "string e.g. 1.0", "memory": "string e.g. 512Mi", "replicas": number, "ports": [number], "managed_service": "rds" | "dynamodb" | "elasticache" | null, "multi_az": boolean }],
    "storage": [{ "name": "string", "type": "volume", "size": "string e.g. 1Gi", "attached_to": "string, a service name" }],
    "network": { "expose": [{ "service": "string", "host_port": number }], "internal": ["string, service names with no host port"] },
    "reasoning": "3-6 sentences, plain business English, showing the arithmetic",
    "feasible": boolean,
    "infeasibility_reason": "string | null",
    "estimated_cost_usd_monthly": number,
    "headroom_pct": number,
    "availability_notes": "string, one sentence on what does/doesn't survive a failure at this tier",
    "included_components": [{ "component": "string", "reason": "string, why this is in scope for this tier" }],
    "skipped_components": [{ "component": "string", "reason": "string -- only genuine tradeoffs a reviewer would want called out, not an exhaustive list of every unused service" }],
    "task_graph": [{ "step": number, "task": "string, one concrete provisioning step", "component": "string" }],
    "manual_estimate_person_days": "number, see sizing-workloads.md formula",
    "agent_estimate_minutes": "number, see sizing-workloads.md formula",
    "scaling_strategy": { "min_replicas": number, "max_replicas": number, "trigger_description": "string, the specific condition a human would scale on -- narrative only, no live autoscaler exists" } | null
  }`;

/** Fixes the "tier" line of CAPACITY_PLAN_OPTION_SHAPE to a single literal value — used by the enterprise passes, each of which only ever produces one specific tier. */
function optionShapeForTier(tier: "economy" | "high_availability"): string {
  return CAPACITY_PLAN_OPTION_SHAPE.replace(
    `"tier": "economy" | "balanced" | "high_availability",`,
    `"tier": "${tier}" (fixed — this pass produces ONLY the ${tier} tier),`
  );
}

/** Extracted so both the generic schema shape and enterprise Pass 1 can reference the same grammar. */
const ARCHITECTURE_RECOMMENDATION_SHAPE = `{"archetype": "solo_ecs_fargate" | "team_ecs_fargate_ha" | "scale_up_eks" | "enterprise_eks_landing_zone", "archetype_reasoning": "string", "criticality_score": number, "criticality_band": "low" | "medium" | "high" | "very_high", "criticality_reasoning": "string", "managed_controls": [{"name": "string", "category": "network" | "identity" | "detection" | "data_protection" | "dr_ha" | "compliance" | "cost_governance", "triggered_by": "archetype" | "criticality" | "compliance_overlay", "reasoning": "string", "compliance_tags": ["string"], "estimated_cost_usd_monthly": number, "terraform_bundle_template_id": "string | null"}], "compliance_overlay": ["pci_dss" | "hipaa" | "soc2" | "none", "... one entry per compliance_targets value in enterprise_context, NOT objects"], "total_controls_cost_usd_monthly": number, "alternatives_considered": [{"option": "string", "pros": "string", "cons": "string", "rejected_because": "string | null"}], "client_classification": "string", "enterprise_context": "<copy of the input PlanRequest.enterprise_context, verbatim>"}`;

const SCHEMA_SHAPE = `{
  "request_id": "string",
  "options": [${CAPACITY_PLAN_OPTION_SHAPE}],
  "recommended_tier": "economy" | "balanced" | "high_availability",
  "feasible": boolean,
  "infeasibility_reason": "string | null",
  "architecture_recommendation": "ALWAYS OMIT this field — enterprise_mode requests never use this schema shape (they go through a separate two-pass flow, see runEnterprisePlanner)."
}`;

const AWS_TARGET_NOTE = "\n\n" + loadSkill("managed-service-substitution");
const ENTERPRISE_SKILL = loadSkill("compliance-and-dr-reasoning");

const ENTERPRISE_PASS1_NOTE =
  '\n\nTHIS IS PASS 1 of 2 for this enterprise_mode request. Produce the full-posture "high_availability" ' +
  "option plus the complete architecture_recommendation — architecture_recommendation is computed once and " +
  "reused as-is for pass 2, so get it right here; it will not be asked for again.\n\n" +
  ENTERPRISE_SKILL;

const ENTERPRISE_PASS2_NOTE =
  '\n\nTHIS IS PASS 2 of 2 for this enterprise_mode request. Pass 1\'s "high_availability" option and its ' +
  "architecture_recommendation are given to you below as ground truth — do not recompute or restate them. " +
  'Produce ONLY the cost-reduced "economy" option.\n\n' +
  ENTERPRISE_SKILL;

const ENTERPRISE_PASS1_SCHEMA_SHAPE = `{
  "option": ${optionShapeForTier("high_availability")},
  "architecture_recommendation": ${ARCHITECTURE_RECOMMENDATION_SHAPE}
}`;

const ENTERPRISE_PASS2_SCHEMA_SHAPE = `{
  "option": ${optionShapeForTier("economy")}
}`;

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
  // Never enterprise_mode here — runPlanner routes those to runEnterprisePlanner before this is called.
  const awsNote = planRequest.constraints.target === "aws" ? AWS_TARGET_NOTE : "";
  return [
    `PlanRequest:\n${JSON.stringify(planRequest, null, 2)}${modifyNote}${feedbackNote}${awsNote}`,
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

function componentNote(component: string, reason: string): ComponentNote {
  return { component, reason };
}

/**
 * Ordered provisioning steps a tier's plan implies, restating the
 * services/storage/network already decided above rather than deciding
 * anything new — mirrors the JSON worked example in USE_CASES.md UC-10.
 */
function buildTaskGraph(
  services: ServiceSpec[],
  storage: StorageSpec[],
  addNginx: boolean,
  format: "compose" | "terraform" = "compose"
): TaskGraphStep[] {
  const componentLabel = format === "compose" ? "Docker Compose" : "Terraform";
  const steps: TaskGraphStep[] = [];
  let step = 1;
  for (const s of services) {
    steps.push({ step: step++, task: `Render ${format} definition for service "${s.name}"`, component: componentLabel });
  }
  for (const st of storage) {
    steps.push({ step: step++, task: `Provision volume "${st.name}"`, component: componentLabel });
  }
  if (addNginx) {
    steps.push({ step: step++, task: "Configure nginx load balancer in front of the scaled service", component: "Nginx" });
  }
  steps.push({
    step: step++,
    task: format === "compose" ? "Validate compose config" : "Validate terraform plan",
    component: "Validation",
  });
  return steps;
}

/** Manual-vs-agent turnaround estimate — formula documented in skills/sizing-workloads.md. */
function estimateManualPersonDays(numServices: number, tier: Tier): number {
  const raw = 1 + 0.5 * Math.max(0, numServices - 1) + (tier === "high_availability" ? 1 : 0);
  return Math.round(raw * 2) / 2; // nearest half-day
}

function estimateAgentMinutes(numServices: number): number {
  return Math.min(30, 10 + 3 * numServices);
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

/** Compute + managed-service provisioning steps for the fixed UC-9 retail-store-sample-app topology. */
function buildAwsTaskGraph(computeLabel: string): TaskGraphStep[] {
  const steps: TaskGraphStep[] = [];
  let step = 1;
  steps.push({ step: step++, task: "Provision VPC, ALB, and NAT Gateway(s)", component: "Terraform / AWS networking" });
  for (const s of RETAIL_APP_SERVICES) {
    steps.push({ step: step++, task: `Deploy ${computeLabel} workload for "${s.name}"`, component: computeLabel });
    if (s.managed) {
      steps.push({ step: step++, task: `Provision ${s.managed.toUpperCase()} for "${s.name}"`, component: s.managed.toUpperCase() });
    }
  }
  steps.push({ step: step++, task: "Validate terraform plan", component: "Validation" });
  return steps;
}

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
    included_components: [
      ...RETAIL_APP_SERVICES.map((s) =>
        componentNote(s.name, s.managed ? `containerized service backed by managed ${s.managed.toUpperCase()}` : "containerized service, no managed data dependency")
      ),
      componentNote("Application Load Balancer (round-robin)", "fronts all 5 services across their single Fargate task each"),
    ],
    skipped_components: [
      componentNote("Multi-AZ compute (EKS)", "cost-sensitive economy tier — single ECS Fargate task per service; see availability_notes"),
      componentNote("Multi-AZ managed data stores", "single-AZ RDS / single-node ElastiCache chosen for cost; Multi-AZ is the high_availability tier's tradeoff"),
    ],
    task_graph: buildAwsTaskGraph("ECS Fargate"),
    // AWS/Terraform work (VPC, IAM, managed services) is heavier than the compose path's formula accounts for — illustrative figures, same basis as the cost estimates above.
    manual_estimate_person_days: 6,
    agent_estimate_minutes: 25,
    scaling_strategy: {
      min_replicas: 1,
      max_replicas: 1,
      trigger_description: "no autoscaling — economy tier is cost-optimized for a fixed single-task-per-service footprint; scale to high_availability instead of scaling this tier",
    },
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
    included_components: [
      ...RETAIL_APP_SERVICES.map((s) =>
        componentNote(s.name, s.managed ? `containerized service backed by Multi-AZ managed ${s.managed.toUpperCase()}` : "containerized service, 2 pod replicas across 2 AZs")
      ),
      componentNote("Application Load Balancer (round-robin)", "fronts all 5 services across 2 pod replicas each, spread over 2 AZs"),
    ],
    skipped_components: [],
    task_graph: buildAwsTaskGraph("EKS"),
    manual_estimate_person_days: 8,
    agent_estimate_minutes: 35,
    scaling_strategy: {
      min_replicas: 2,
      max_replicas: 4,
      trigger_description: "EKS's node group has headroom for up to 4 pod replicas per service if sustained load exceeds the 2-replica baseline — no live HPA configured in this sandbox, a human would scale manually",
    },
  };

  void planRequest; // topology is fixed per the worked example; request only selects the AWS branch itself
  return [economy, highAvailability];
}

/**
 * At low enough load, balanced's 20% headroom (and, outside a prod-like
 * environment, its replica floor too) never crosses a replica-count
 * threshold above economy's — so the two tiers can render with identical
 * services/cost. That's mathematically correct, not a bug, but silently
 * showing two "different" tiers at the same price reads as broken. Appends
 * a one-sentence note to the higher tier's reasoning when this happens,
 * checked adjacently (economy vs balanced, then balanced vs
 * high_availability — high_availability's unconditional +1 replica makes
 * this rare for that pair, but still checked for consistency).
 */
function noteConvergedTiers(options: CapacityPlanOption[]): void {
  const byTier = new Map(options.map((o) => [o.tier, o]));
  const adjacentPairs: [Tier, Tier][] = [
    ["economy", "balanced"],
    ["balanced", "high_availability"],
  ];
  for (const [lowerTier, higherTier] of adjacentPairs) {
    const lower = byTier.get(lowerTier);
    const higher = byTier.get(higherTier);
    if (lower && higher && higher.estimated_cost_usd_monthly === lower.estimated_cost_usd_monthly) {
      higher.reasoning += ` ${higher.tier} offers no improvement over ${lower.tier} at this load level — the extra headroom/replica-floor rules didn't push replicas (or cost) any higher than ${lower.tier}'s.`;
    }
  }
}

function mockPlanner(planRequest: PlanRequest, humanFeedback?: string): CapacityPlan {
  // Enterprise Architecture Advisor: checked before constraints.target==="aws"
  // so it never collides with UC-9's fixed retail-store-sample-app worked
  // example on that same target value — enterprise_mode is a separate signal
  // set by intake.ts.
  if (planRequest.enterprise_mode && planRequest.enterprise_context) {
    const architecture_recommendation = buildArchitectureRecommendation(planRequest.enterprise_context);
    // The DR spend (high_availability tier) is only worth defaulting to when criticality actually
    // warrants it — mirrors the dev/prod-based recommendation logic in the generic compose branch below.
    const recommended_tier: Tier =
      architecture_recommendation.criticality_band === "high" || architecture_recommendation.criticality_band === "very_high"
        ? "high_availability"
        : "economy";
    return {
      request_id: planRequest.request_id,
      options: buildEnterpriseOptions(planRequest, humanFeedback),
      recommended_tier,
      feasible: true,
      infeasibility_reason: null,
      architecture_recommendation,
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
      included_components: [],
      skipped_components: [],
      task_graph: [],
      manual_estimate_person_days: 0,
      agent_estimate_minutes: 0,
      scaling_strategy: null,
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
  // Merged UC-1 + UC-2 default: any Node.js request with no repo/build given
  // and no deliberate-failure marker now gets the real RealWorld Conduit
  // pair (backend + a browser-rendered frontend with a real login page)
  // instead of a placeholder — whether or not the request happened to
  // mention postgresql/a specific app. This is now the flagship demo AND the
  // generic warm-up path; "postgresql" is forced into effect below via
  // effectiveDependencies even when unstated, since the flagship app needs
  // it. Set once here and consumed further down when building services.
  let isRealworldFullstackDefault = false;
  let frontendEntry: (typeof BUILD_REGISTRY)[string] | null = null;
  // "dashboard" alone used to be in this alternation, but it's too generic — it false-matched
  // "voting application with a vote frontend, results dashboard, ..." (req-2026-ab8c477f) into
  // an unrelated monitoring-tool placeholder. "monitoring"/"uptime"/"status page" are specific
  // enough on their own to still catch real monitoring-tool requests, including ones that also
  // happen to say "dashboard" (e.g. "monitoring dashboard" already matches on "monitoring").
  if (/\b(monitoring|uptime|status page)\b/.test(rawLower) && !planRequest.repo_url) {
    image = "louislam/uptime-kuma:1";
    appPort = 3001;
    appVolume = true;
    runtimeNote = "Uptime Kuma monitoring dashboard (single instance)";
  } else if (
    planRequest.runtime === "nodejs18" &&
    !planRequest.repo_url &&
    !/\b(demo-fail|wrong (db )?password)\b/i.test(rawLower)
  ) {
    // Same "no real app code" problem UC-1/UC-2 both hit, but this scenario
    // is meant to prove capacity planning against a credible, fully real
    // app (backend + login page), not a placeholder — emit both build
    // sentinels (nodes/buildRegistry.ts) so iac_generator clones and builds
    // the real pair instead of picking an off-the-shelf substitute. The
    // demo-fail/wrong-password guard keeps UC-8b's fast offline rollback
    // demo from being silently rerouted into a multi-minute real build.
    const realworldEntry = BUILD_REGISTRY["realworld-node-express"];
    frontendEntry = BUILD_REGISTRY["realworld-react-frontend"];
    isRealworldFullstackDefault = true;
    image = BUILD_SENTINEL_PREFIX + "realworld-node-express";
    appPort = realworldEntry.containerPort;
    runtimeNote = `${realworldEntry.displayName} + ${frontendEntry.displayName} (built from source, no repo/build given so the known flagship reference pair is used)`;
  } else if (planRequest.runtime !== "nodejs18" && !planRequest.repo_url) {
    // Generic demo request with no repo/build given, non-Node runtime — the
    // RealWorld pair above is Node-specific, so this remains the fallback
    // for python/java/static/multi requests with no real app code to run: a
    // bare language runtime base image (python:*, eclipse-temurin:*, etc.)
    // has no server process and will always fail its health check. Use a
    // well-known image that actually serves HTTP out of the box instead
    // (sizing-workloads.md skill rule).
    image = "docker/welcome-to-docker";
    appPort = 80;
    runtimeNote = "Demo warm-up for a non-Node runtime with no repo/build given — docker/welcome-to-docker serves real HTTP traffic";
  }

  // Forces postgresql into effect for the RealWorld fullstack default even
  // when the request never mentioned a database — the flagship pair needs
  // it — without mutating the audited PlanRequest itself. Every downstream
  // db/cache check in buildOption reads this instead of
  // planRequest.dependencies directly.
  const effectiveDependencies = isRealworldFullstackDefault
    ? [...new Set([...planRequest.dependencies, "postgresql" as const])]
    : planRequest.dependencies;

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
  const hasDb = effectiveDependencies.includes("postgresql") || effectiveDependencies.includes("mysql");
  const hasRedis = effectiveDependencies.includes("redis");

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

    if (effectiveDependencies.includes("postgresql")) {
      services.push({ name: "db", image: "postgres:16-alpine", cpu: "1.0", memory: "1Gi", replicas: 1, ports: [5432] });
      storage.push({ name: "dbdata", type: "volume", size: "1Gi", attached_to: "db" });
      internal.push("db");
      reasons.push("PostgreSQL sized at 1 instance / 1Gi with a named volume for data, never replicated in sandbox.");
      if (image.startsWith(BUILD_SENTINEL_PREFIX)) {
        // The build-sentinel path's migration step runs prisma as a host
        // process (the prisma CLI only exists in the cloned repo's own
        // node_modules, never in the production image) — it needs to reach
        // Postgres directly, so publish its port. No other use case does
        // this (network.expose has no db entry, catalog.ts leaves it
        // unpublished, matching every existing template's output).
        expose.push({ service: "db", host_port: 5432 });
        reasons.push("Postgres port published to the host so the build pipeline's migration step can reach it directly.");
      }
    } else if (effectiveDependencies.includes("mysql")) {
      services.push({ name: "db", image: "mysql:8", cpu: "1.0", memory: "1Gi", replicas: 1, ports: [3306] });
      storage.push({ name: "dbdata", type: "volume", size: "1Gi", attached_to: "db" });
      internal.push("db");
      reasons.push("MySQL sized at 1 instance / 1Gi with a named volume for data, never replicated in sandbox.");
    }
    if (hasDb) {
      availabilityNotes += cfg.tier === "economy" ? ", single-instance DB (no failover)" : ", single-instance DB (sandbox can't replicate stateful services — would be Multi-AZ on a real cloud target)";
    }

    if (effectiveDependencies.includes("redis")) {
      services.push({ name: "cache", image: "redis:7-alpine", cpu: "0.5", memory: "256Mi", replicas: 1, ports: [6379] });
      internal.push("cache");
      reasons.push("Redis sized at 1 instance / 256Mi, no volume (no persistence requested).");
    }
    if (hasRedis) availabilityNotes += ", single-instance cache";

    if (isRealworldFullstackDefault && frontendEntry) {
      // Browser-rendered login page, paired with the "app" backend above —
      // needs its own host-published port since a real browser must reach
      // it directly (unlike the db-in-build-sentinel-case exposure above,
      // which exists only for the host-side migration step).
      services.push({ name: "web", image: BUILD_SENTINEL_PREFIX + "realworld-react-frontend", cpu: "0.25", memory: "128Mi", replicas: 1, ports: [frontendEntry.containerPort] });
      expose.push({ service: "web", host_port: frontendEntry.containerPort });
      reasons.push(`${frontendEntry.displayName} added as the browser-facing frontend, calling the backend above over its published host port.`);
    }

    if (replicas > 1) {
      reasons.push("Nginx load balancer added automatically because replicas > 1 for an HTTP service.");
    }

    const cost = estimateMonthlyCost(services, storage);

    // Restates decisions already made above as a reviewable scoping
    // narrative — no new sizing logic, see skills/sizing-workloads.md.
    const serviceReason = (s: ServiceSpec): string => {
      if (s.name === "app") return `${runtimeNote}, primary application service (${s.replicas} replica(s))`;
      if (s.name === "db") return "data dependency required by the request, sized 1 instance / 1Gi with a named volume";
      if (s.name === "cache") return "data dependency required by the request, sized 1 instance / 256Mi, no persistence";
      if (s.name === "web") return "browser-facing frontend paired with the app backend";
      return "service required by the request";
    };
    const included_components: ComponentNote[] = services.map((s) => componentNote(s.name, serviceReason(s)));
    if (replicas > 1) {
      included_components.push(componentNote("Nginx load balancer (round-robin)", "fronts >1 replica since compose can't bind one host port across multiple containers of the same service"));
    }
    const skipped_components: ComponentNote[] = [];
    if (cfg.tier === "economy") {
      skipped_components.push(componentNote("Extra replica / multi-AZ redundancy", "cost-sensitive economy tier — traded off for lower monthly cost, see availability_notes"));
    }
    if (hasDb) {
      skipped_components.push(componentNote("Database Multi-AZ replication", "sandbox can't replicate stateful services locally — would be Multi-AZ on a real cloud target"));
    }

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
      included_components,
      skipped_components,
      task_graph: buildTaskGraph(services, storage, replicas > 1),
      manual_estimate_person_days: estimateManualPersonDays(services.length, cfg.tier),
      agent_estimate_minutes: estimateAgentMinutes(services.length),
      scaling_strategy: {
        min_replicas: cfg.replicaFloor,
        max_replicas: 4,
        trigger_description:
          explicitReplicas !== null
            ? "replica count was explicitly requested and fixed — not sized by load, so no scaling trigger applies"
            : `scale from ${cfg.replicaFloor} up to the sandbox ceiling of 4 replicas if sustained rps exceeds this tier's headroom-adjusted per-instance capacity (${perInstance} rps/instance) — no live autoscaler in this sandbox, replicas are fixed at plan time`,
      },
    };
  }

  const options = tierConfigs(isProd).map(buildOption);
  noteConvergedTiers(options);
  const recommended_tier: Tier = environmentLower.includes("dev") ? "economy" : "balanced";

  return {
    request_id: planRequest.request_id,
    options,
    recommended_tier,
    feasible: true,
    infeasibility_reason: null,
  };
}

/** 3 by default, 2 for the AWS worked-example note — enterprise_mode never reaches this (see runEnterprisePlanner). */
function expectedTierCount(planRequest: PlanRequest): number {
  if (planRequest.constraints.target === "aws") return 2;
  return 3;
}

function buildEnterprisePass1UserPrompt(planRequest: PlanRequest, humanFeedback?: string): string {
  const feedbackNote = humanFeedback
    ? `\n\nA human reviewer rejected the previous plan with this feedback — address it directly:\n"${humanFeedback}"`
    : "";
  return [
    `PlanRequest:\n${JSON.stringify(planRequest, null, 2)}${feedbackNote}`,
    ENTERPRISE_PASS1_NOTE,
    `Respond with ONLY a JSON object matching exactly this shape:\n${ENTERPRISE_PASS1_SCHEMA_SHAPE}`,
  ].join("\n\n");
}

function buildEnterprisePass2UserPrompt(
  planRequest: PlanRequest,
  pass1Option: CapacityPlanOption,
  pass1Recommendation: ArchitectureRecommendation,
  humanFeedback?: string
): string {
  const feedbackNote = humanFeedback
    ? `\n\nA human reviewer rejected the previous plan with this feedback — address it directly:\n"${humanFeedback}"`
    : "";
  return [
    `PlanRequest:\n${JSON.stringify(planRequest, null, 2)}${feedbackNote}`,
    `Pass 1's "high_availability" option (ground truth, do not restate):\n${JSON.stringify(pass1Option, null, 2)}`,
    `Pass 1's architecture_recommendation (ground truth, do not restate or recompute):\n${JSON.stringify(pass1Recommendation, null, 2)}`,
    ENTERPRISE_PASS2_NOTE,
    `Respond with ONLY a JSON object matching exactly this shape:\n${ENTERPRISE_PASS2_SCHEMA_SHAPE}`,
  ].join("\n\n");
}

/**
 * Two smaller LLM calls instead of one large one — a single call asking for both priced tiers plus the
 * full architecture_recommendation proved unreliable against real Bedrock (confirmed live: a timeout and
 * a hard failure where the model returned only one tier even after the validation retry). Pass 1 produces
 * the full-posture "high_availability" option + architecture_recommendation (same size/shape the original
 * single-tier design already handled reliably); Pass 2 is given Pass 1's output as ground truth and
 * produces only a narrower "economy" variant. See skills/compliance-and-dr-reasoning.md.
 */
async function runEnterprisePlanner(
  planRequest: PlanRequest,
  humanFeedback?: string
): Promise<{ value: CapacityPlan; rawResponse: string; mocked: boolean }> {
  if (isMockMode()) {
    const value = mockPlanner(planRequest, humanFeedback);
    return { value, rawResponse: JSON.stringify(value, null, 2), mocked: true };
  }

  const Pass1Schema = z.object({
    option: CapacityPlanOptionSchema.refine((o) => o.tier === "high_availability", {
      message: 'pass 1 option.tier must be "high_availability"',
    }),
    architecture_recommendation: ArchitectureRecommendationSchema,
  });
  const Pass2Schema = z.object({
    option: CapacityPlanOptionSchema.refine((o) => o.tier === "economy", {
      message: 'pass 2 option.tier must be "economy"',
    }),
  });

  const pass1 = await runLLMJson({
    schema: Pass1Schema,
    system: SYSTEM_PROMPT,
    user: buildEnterprisePass1UserPrompt(planRequest, humanFeedback),
    mock: (): never => {
      throw new Error("unreachable — isMockMode() already handled above");
    },
    node: "planner-enterprise-pass1",
  });

  const pass2 = await runLLMJson({
    schema: Pass2Schema,
    system: SYSTEM_PROMPT,
    user: buildEnterprisePass2UserPrompt(planRequest, pass1.value.option, pass1.value.architecture_recommendation, humanFeedback),
    mock: (): never => {
      throw new Error("unreachable — isMockMode() already handled above");
    },
    node: "planner-enterprise-pass2",
  });

  const rec = pass1.value.architecture_recommendation;
  const recommended_tier: Tier =
    rec.criticality_band === "high" || rec.criticality_band === "very_high" ? "high_availability" : "economy";

  const value: CapacityPlan = {
    request_id: planRequest.request_id,
    options: [pass2.value.option, pass1.value.option],
    recommended_tier,
    feasible: true,
    infeasibility_reason: null,
    architecture_recommendation: rec,
  };

  return {
    value,
    rawResponse: JSON.stringify({ pass1: pass1.rawResponse, pass2: pass2.rawResponse }, null, 2),
    mocked: false,
  };
}

export async function runPlanner(
  planRequest: PlanRequest,
  existingPlan: CapacityPlan | null,
  humanFeedback?: string
): Promise<{ value: CapacityPlan; rawResponse: string; mocked: boolean }> {
  let result: { value: CapacityPlan; rawResponse: string; mocked: boolean };

  if (planRequest.enterprise_mode && planRequest.enterprise_context) {
    result = await runEnterprisePlanner(planRequest, humanFeedback);
  } else {
    // A real LLM call proved unreliable at reliably emitting the exact tier
    // count the prompt asks for (observed: silently dropping one tier from a
    // 3-tier request) even after tightening the prompt's wording — wording
    // alone isn't a structural guarantee. This refine turns a wrong count into
    // a schema validation failure so runLLMJson's existing one-retry-with-error
    // path (runLLMJson.ts) actually fires instead of silently accepting a
    // short options array.
    const expectedCount = expectedTierCount(planRequest);
    const schemaWithTierCheck = CapacityPlanSchema.refine(
      (plan) => plan.options.length === expectedCount,
      (plan) => ({
        message: `options must contain exactly ${expectedCount} entries for this request (tier rule: 3 default / 2 AWS) — got ${plan.options.length}`,
      })
    );

    result = await runLLMJson({
      schema: schemaWithTierCheck,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(planRequest, existingPlan, humanFeedback),
      mock: () => mockPlanner(planRequest, humanFeedback),
      node: "planner",
    });
  }

  let plan = result.value;

  // Real LLM calls proved unreliable at reproducing enterprise_context
  // verbatim inside architecture_recommendation (esp. the free-text
  // signal_reasoning field) even when explicitly instructed to — the
  // schema allows the model to omit it, and this backfills it from
  // PlanRequest (already validated at intake) so it's always correct
  // regardless of what the model did or didn't include.
  if (plan.architecture_recommendation && planRequest.enterprise_context) {
    // Same reliability gap, one axis over: org_scale/archetype must be a pure
    // function of team_size (independent of expected_users/criticality — see
    // compliance-and-dr-reasoning.md's "FLOOR... do not deviate" rule and
    // enterpriseRulesEngine.ts's own "org_scale and criticality are
    // independent axes" framing), but a real LLM call proved it will still
    // infer a larger org_scale from a large *user* count when team_size is
    // unstated (e.g. "8 million users, team_size unstated" -> incorrectly
    // "enterprise" instead of the schema-mandated "solo" default) — directly
    // contradicting the SCHEMA_SHAPE instruction it was given ("solo if
    // team_size not stated"). Recomputing both the archetype AND its
    // matching fixed reasoning text deterministically (not just the archetype
    // enum) keeps the two consistent — leaving the old reasoning prose next
    // to a corrected archetype would describe the wrong scale.
    const correctedArchetype = archetypeForOrgScale(classifyOrgScale(planRequest.enterprise_context.team_size));
    plan = {
      ...plan,
      architecture_recommendation: {
        ...plan.architecture_recommendation,
        enterprise_context: planRequest.enterprise_context,
        archetype: correctedArchetype,
        archetype_reasoning: ARCHETYPE_REASONING[correctedArchetype],
      },
    };
  }

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
