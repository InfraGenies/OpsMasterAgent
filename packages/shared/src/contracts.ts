import { z } from "zod";

/**
 * Mirrors agent-md-files/CONTRACTS.md exactly. These schemas are the single
 * source of truth passed between orchestrator nodes and across the
 * server<->web wire. Do not diverge from CONTRACTS.md without updating both.
 */

export const OperationSchema = z.enum(["create", "modify", "destroy"]);
export type Operation = z.infer<typeof OperationSchema>;

export const RuntimeSchema = z.enum([
  "nodejs18",
  "python3.11",
  "java17",
  "static",
  "multi",
]);
export type Runtime = z.infer<typeof RuntimeSchema>;

export const DependencySchema = z.enum([
  "postgresql",
  "mysql",
  "redis",
  "mongodb",
  "none",
]);
export type Dependency = z.infer<typeof DependencySchema>;

export const TargetSchema = z.enum(["compose", "localstack", "minikube", "aws"]);
export type Target = z.infer<typeof TargetSchema>;

// ---------------------------------------------------------------------------
// 1. PlanRequest (intake -> planner)
// ---------------------------------------------------------------------------
export const PlanRequestSchema = z.object({
  request_id: z.string(),
  raw_text: z.string(),
  app_type: z.string(),
  runtime: RuntimeSchema,
  repo_url: z.string().nullable(),
  dependencies: z.array(DependencySchema),
  expected_load: z.object({
    rps: z.number().nullable(),
    concurrent_users: z.number().nullable(),
  }),
  environment: z.string(),
  operation: OperationSchema,
  constraints: z.object({
    target: TargetSchema,
    max_memory_gb: z.number(),
  }),
  existing_env_id: z.string().nullable().optional(),
  notes: z.array(z.string()).optional(),
  feasible_input: z.boolean(),
  infeasibility_reason: z.string().nullable().optional(),
});
export type PlanRequest = z.infer<typeof PlanRequestSchema>;

// ---------------------------------------------------------------------------
// 2. CapacityPlan (planner -> iac_generator, shown to human)
// ---------------------------------------------------------------------------
export const ServiceSpecSchema = z.object({
  name: z.string(),
  image: z.string(),
  cpu: z.string(),
  memory: z.string(),
  replicas: z.number().int().min(1),
  ports: z.array(z.number().int()),
  env: z.record(z.string(), z.string()).optional(),
  /** Set only on the AWS/Terraform planning path — a managed-service substitution for this service's data dependency (e.g. RDS instead of a containerized postgres). Absent/null for every compose tier. */
  managed_service: z.enum(["rds", "dynamodb", "elasticache"]).nullable().optional(),
  /** AWS/Terraform path only: whether this managed service has cross-AZ failover at this tier. */
  multi_az: z.boolean().optional(),
});
export type ServiceSpec = z.infer<typeof ServiceSpecSchema>;

export const StorageSpecSchema = z.object({
  name: z.string(),
  type: z.literal("volume"),
  size: z.string(),
  attached_to: z.string(),
});
export type StorageSpec = z.infer<typeof StorageSpecSchema>;

/**
 * One priced tier's worth of a plan — everything downstream of the planner
 * (readiness_check, iac_generator, policy_validator, templates, env
 * snapshots) consumes exactly this shape, unaware that the planner produced
 * more than one of them. Kept field-identical to the old single-plan
 * CapacityPlan on purpose so those nodes needed no rewrite, just a type
 * rename from CapacityPlan to CapacityPlanOption.
 */
export const TierSchema = z.enum(["economy", "balanced", "high_availability"]);
export type Tier = z.infer<typeof TierSchema>;

/** One dollar-figure component of a plan's total (e.g. "Compute (Fargate)", "RDS", "NAT Gateway"). */
export const CostLineItemSchema = z.object({
  label: z.string(),
  usd_monthly: z.number(),
});
export type CostLineItem = z.infer<typeof CostLineItemSchema>;

/**
 * Where estimated_cost_usd_monthly came from, surfaced to the UI so users
 * don't mistake either kind for a live cloud billing quote:
 * "rate_table" = summed deterministically from pricing/awsRateTable.ts or
 * pricing/rateTable.ts (mock-LLM planner paths) and cost_breakdown is always
 * populated and exactly sums to the total; "llm_estimate" = whatever number
 * the model returned in its JSON response (real-LLM planner paths), where
 * cost_breakdown is empty because the model isn't asked to itemize it.
 */
export const CostBasisSchema = z.enum(["rate_table", "llm_estimate"]);
export type CostBasis = z.infer<typeof CostBasisSchema>;

export const CapacityPlanOptionSchema = z.object({
  tier: TierSchema,
  services: z.array(ServiceSpecSchema),
  storage: z.array(StorageSpecSchema),
  network: z.object({
    expose: z.array(z.object({ service: z.string(), host_port: z.number().int() })),
    internal: z.array(z.string()),
  }),
  reasoning: z.string(),
  feasible: z.boolean(),
  infeasibility_reason: z.string().nullable(),
  estimated_cost_usd_monthly: z.number(),
  cost_breakdown: z.array(CostLineItemSchema).default([]),
  cost_basis: CostBasisSchema.default("llm_estimate"),
  headroom_pct: z.number(),
  availability_notes: z.string(),
});
export type CapacityPlanOption = z.infer<typeof CapacityPlanOptionSchema>;

export const CapacityPlanSchema = z.object({
  request_id: z.string(),
  options: z.array(CapacityPlanOptionSchema).min(1),
  recommended_tier: TierSchema,
  feasible: z.boolean(),
  infeasibility_reason: z.string().nullable(),
});
export type CapacityPlan = z.infer<typeof CapacityPlanSchema>;

// ---------------------------------------------------------------------------
// 3. IaCPayload (iac_generator -> approval gate -> deploy)
// ---------------------------------------------------------------------------
export const TemplateIdSchema = z.enum([
  "compose-single-v1",
  "compose-web-db-v1",
  "compose-web-db-cache-v1",
  "compose-lb-replicas-v1",
  "tf-ecs-fargate-v1",
  "tf-eks-v1",
]);
export type TemplateId = z.infer<typeof TemplateIdSchema>;

export const IaCFileSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type IaCFile = z.infer<typeof IaCFileSchema>;

export const IaCPayloadSchema = z.object({
  request_id: z.string(),
  format: z.enum(["compose", "terraform", "k8s"]),
  template_id: TemplateIdSchema,
  files: z.array(IaCFileSchema),
  apply_command: z.string(),
  rollback_command: z.string(),
  diff_from: z.array(IaCFileSchema).nullable(),
  validation: z.object({
    tool: z.string(),
    ok: z.boolean(),
    output: z.string(),
  }),
});
export type IaCPayload = z.infer<typeof IaCPayloadSchema>;

export const IaCGeneratorErrorSchema = z.object({
  error: z.literal("no_template"),
  needed: z.string(),
});
export type IaCGeneratorError = z.infer<typeof IaCGeneratorErrorSchema>;

/**
 * What the LLM itself is allowed to produce for the IaC step: a template
 * choice + fill-in variables, or a refusal. Rendering files, computing
 * apply_command/rollback_command, and validation all happen in backend code
 * (03-iac-generator.md: "the LLM never free-writes infrastructure code").
 */
export const IaCGeneratorLLMOutputSchema = z.union([
  z.object({
    template_id: TemplateIdSchema,
    variables: z.record(z.string(), z.unknown()),
  }),
  IaCGeneratorErrorSchema,
]);
export type IaCGeneratorLLMOutput = z.infer<typeof IaCGeneratorLLMOutputSchema>;

// ---------------------------------------------------------------------------
// 2b. ReadinessReport (planner -> readiness_check -> iac_generator)
// ---------------------------------------------------------------------------
export const ReadinessCheckResultSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail", "skipped"]),
  detail: z.string(),
  blocking: z.boolean(),
});
export type ReadinessCheckResult = z.infer<typeof ReadinessCheckResultSchema>;

export const ReadinessReportSchema = z.object({
  request_id: z.string(),
  checks: z.array(ReadinessCheckResultSchema),
  ready: z.boolean(),
  blockers: z.array(z.string()),
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

// ---------------------------------------------------------------------------
// 3b. PolicyReport (iac_generator <-> policy_validator self-correction loop,
// then policy_validator -> approval gate)
// ---------------------------------------------------------------------------
export const PolicyFindingSchema = z.object({
  rule_id: z.string(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  message: z.string(),
  file: z.string().nullable(),
  auto_fixable: z.boolean(),
});
export type PolicyFinding = z.infer<typeof PolicyFindingSchema>;

export const PolicyReportSchema = z.object({
  request_id: z.string(),
  findings: z.array(PolicyFindingSchema),
  passed: z.boolean(),
  attempts: z.number().int().min(1),
});
export type PolicyReport = z.infer<typeof PolicyReportSchema>;

// ---------------------------------------------------------------------------
// 4. VerifyReport (verify -> report)
// ---------------------------------------------------------------------------
export const CheckResultSchema = z.object({
  name: z.string(),
  status: z.enum(["pass", "fail"]),
  latency_ms: z.number(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const SmokeTestSchema = z.object({
  tool: z.string(),
  target_rps: z.number(),
  achieved_rps: z.number(),
  p95_ms: z.number(),
  error_rate: z.number(),
  duration_s: z.number(),
});
export type SmokeTest = z.infer<typeof SmokeTestSchema>;

export const VerifyReportSchema = z.object({
  request_id: z.string(),
  checks: z.array(CheckResultSchema),
  smoke_test: SmokeTestSchema.nullable(),
  verdict: z.enum(["green", "red"]),
  rolled_back: z.boolean(),
  endpoints: z.array(z.string()),
  summary: z.string(),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

// ---------------------------------------------------------------------------
// Audit event (every node writes one)
// ---------------------------------------------------------------------------
export const NodeNameSchema = z.enum([
  "intake",
  "planner",
  "readiness_check",
  "iac_generator",
  "policy_validator",
  "approval_gate",
  "deploy",
  "verify",
  "rollback",
  "report",
  "refuse",
]);
export type NodeName = z.infer<typeof NodeNameSchema>;

export const AuditEventSchema = z.object({
  event_id: z.number().optional(),
  request_id: z.string(),
  ts: z.string(),
  node: NodeNameSchema,
  actor: z.enum(["agent", "human"]),
  input_digest: z.string().nullable(),
  output_digest: z.string().nullable(),
  input_json: z.string().nullable().optional(),
  output_json: z.string().nullable().optional(),
  command_executed: z.string().nullable(),
  status: z.enum(["success", "failure", "pending"]),
  detail: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------
export const RunStatusSchema = z.enum([
  "running",
  "awaiting_approval",
  "deployed",
  "failed",
  "rolled_back",
  "refused",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  request_id: z.string(),
  raw_text: z.string(),
  operation: OperationSchema,
  status: RunStatusSchema,
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const EnvironmentSchema = z.object({
  env_id: z.string(),
  request_id: z.string(),
  name: z.string(),
  target: TargetSchema,
  files_json: z.string(),
  endpoints_json: z.string(),
  state: z.enum(["up", "down", "rolled_back"]),
});
export type EnvironmentRecord = z.infer<typeof EnvironmentSchema>;

export const DecisionActionSchema = z.enum(["approve", "reject", "edit"]);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

export const DecisionSchema = z.object({
  request_id: z.string(),
  action: DecisionActionSchema,
  comment: z.string().nullable(),
  actor: z.string(),
  ts: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// ---------------------------------------------------------------------------
// Pipeline state — what flows through the orchestrator graph
// ---------------------------------------------------------------------------
export interface PipelineState {
  request_id: string;
  plan_request?: PlanRequest;
  capacity_plan?: CapacityPlan;
  readiness_report?: ReadinessReport;
  iac_payload?: IaCPayload;
  policy_report?: PolicyReport;
  verify_report?: VerifyReport;
  decision?: Decision;
  deploy_ok?: boolean;
  deploy_detail?: string;
  endpoints?: string[];
  container_ids?: string[];
  rolled_back?: boolean;
  status: RunStatus;
  report_markdown?: string;
  planner_feedback?: string;
}

// ---------------------------------------------------------------------------
// WebSocket event envelope (server -> web live progress)
// ---------------------------------------------------------------------------
export const WsEventSchema = z.object({
  type: z.enum([
    "node_started",
    "node_finished",
    "awaiting_approval",
    "log_line",
    "run_finished",
  ]),
  request_id: z.string(),
  node: NodeNameSchema.optional(),
  ts: z.string(),
  payload: z.unknown().optional(),
});
export type WsEvent = z.infer<typeof WsEventSchema>;
