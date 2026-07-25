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
// 0. Enterprise Architecture Advisor (business context -> architecture
// recommendation -> compliance gaps). Additive/parallel to the rest of the
// pipeline: every field here is absent/null for every existing use case
// (UC-1..UC-9) and only populated when intake detects enterprise-mode
// signals. See agent-md-files/02c-compliance-check.md and
// nodes/enterpriseRulesEngine.ts.
// ---------------------------------------------------------------------------
export const OrgScaleSchema = z.enum(["solo", "team", "scale_up", "enterprise"]);
export type OrgScale = z.infer<typeof OrgScaleSchema>;

export const PlatformArchetypeSchema = z.enum([
  "solo_ecs_fargate",
  "team_ecs_fargate_ha",
  "scale_up_eks",
  "enterprise_eks_landing_zone",
]);
export type PlatformArchetype = z.infer<typeof PlatformArchetypeSchema>;

export const ComplianceTargetSchema = z.enum(["pci_dss", "hipaa", "soc2", "none"]);
export type ComplianceTarget = z.infer<typeof ComplianceTargetSchema>;

export const CriticalityBandSchema = z.enum(["low", "medium", "high", "very_high"]);
export type CriticalityBand = z.infer<typeof CriticalityBandSchema>;

export const EnterpriseContextSchema = z.object({
  industry_domain: z.enum(["payments", "healthcare", "retail", "generic"]).default("generic"),
  compliance_targets: z.array(ComplianceTargetSchema).default([]),
  expected_users: z.number().nullable(),
  team_size: z.number().nullable(),
  org_scale: OrgScaleSchema,
  multi_region: z.boolean().default(false),
  rpo_minutes: z.number().nullable(),
  rto_minutes: z.number().nullable(),
  /** Which phrases in raw_text mapped to which fields above — shown in the UI so the extraction is auditable, not a black box. */
  signal_reasoning: z.string(),
});
export type EnterpriseContext = z.infer<typeof EnterpriseContextSchema>;

export const ManagedControlCategorySchema = z.enum([
  "network",
  "identity",
  "detection",
  "data_protection",
  "dr_ha",
  "compliance",
  "cost_governance",
]);
export type ManagedControlCategory = z.infer<typeof ManagedControlCategorySchema>;

/** Which axis of the rules engine (nodes/enterpriseRulesEngine.ts) added this control. */
export const ManagedControlTriggerSchema = z.enum(["archetype", "criticality", "compliance_overlay"]);
export type ManagedControlTrigger = z.infer<typeof ManagedControlTriggerSchema>;

export const ManagedControlSchema = z.object({
  name: z.string(),
  category: ManagedControlCategorySchema,
  triggered_by: ManagedControlTriggerSchema,
  reasoning: z.string(),
  compliance_tags: z.array(z.string()).default([]),
  estimated_cost_usd_monthly: z.number(),
  /**
   * Phase-2 bundle template id this control renders as, once
   * templates/enterpriseCatalog.ts exists. Deliberately a plain string, not
   * constrained to TemplateIdSchema (§3) below — these ids can be produced by
   * the rules engine (Phase 1) before the templates they name exist as real,
   * renderable catalog entries (Phase 2).
   */
  terraform_bundle_template_id: z.string().nullable(),
});
export type ManagedControl = z.infer<typeof ManagedControlSchema>;

/** One AWS alternative the model weighed before recommending a control — surfaces the "why not X" reasoning a real solutions architect would give, not just the winning choice. */
export const ArchitectureAlternativeSchema = z.object({
  option: z.string(),
  pros: z.string(),
  cons: z.string(),
  rejected_because: z.string().nullable(),
});
export type ArchitectureAlternative = z.infer<typeof ArchitectureAlternativeSchema>;

export const ArchitectureRecommendationSchema = z.object({
  /**
   * Optional here even though every consumer can rely on it always being
   * present by the time they see it: this is a verbatim duplicate of
   * PlanRequest.enterprise_context that real LLM calls proved unreliable
   * at reproducing (esp. the free-text signal_reasoning field), so
   * nodes/planner.ts backfills it deterministically from PlanRequest right
   * after parsing rather than trusting the model to copy it correctly.
   * Optional purely so a response omitting it still passes validation
   * instead of burning the one runLLMJson retry on a field the backend
   * was always going to overwrite anyway.
   */
  enterprise_context: EnterpriseContextSchema.optional(),
  archetype: PlatformArchetypeSchema,
  archetype_reasoning: z.string(),
  criticality_score: z.number(),
  criticality_band: CriticalityBandSchema,
  criticality_reasoning: z.string(),
  managed_controls: z.array(ManagedControlSchema),
  compliance_overlay: z.array(ComplianceTargetSchema),
  total_controls_cost_usd_monthly: z.number(),
  /** Alternatives considered and rejected for controls with a genuine real-world choice (e.g. Aurora Global Database vs. cross-region read replicas vs. DynamoDB Global Tables). Optional/empty for controls with no meaningful alternative. */
  alternatives_considered: z.array(ArchitectureAlternativeSchema).default([]),
  /** Free-form, plain-English description of who this client actually is (e.g. "seed-stage fintech startup") — NOT constrained to org_scale's four buckets; coexists with the structural enum fields rather than replacing them. */
  client_classification: z.string().default(""),
});
export type ArchitectureRecommendation = z.infer<typeof ArchitectureRecommendationSchema>;

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
  /** Pass-through UI flag from the request submission form ("Just plan this" vs "Plan + deploy") — intake echoes this back unchanged, it is never inferred from raw_text. */
  plan_only: z.boolean().default(false),
  notes: z.array(z.string()).optional(),
  feasible_input: z.boolean(),
  infeasibility_reason: z.string().nullable().optional(),
  /** Enterprise Architecture Advisor dispatch flag — set by intake when it detects business-context signals (compliance target, team size, RPO/RTO, etc.). Kept separate from constraints.target==="aws" (which means UC-9's fixed retail-store-sample-app worked example) so the two AWS paths don't collide. */
  enterprise_mode: z.boolean().default(false),
  enterprise_context: EnterpriseContextSchema.nullable().default(null),
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
  /** Enterprise Architecture Advisor output — null for every use case except enterprise_mode requests. Lives here (once per plan) rather than on CapacityPlanOption (once per tier) because org-scale/criticality/compliance are properties of the request, identical across every priced tier. */
  architecture_recommendation: ArchitectureRecommendationSchema.nullable().optional(),
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
  /** Fixed worked example pairing the two realworld-* build-sentinel entries (buildRegistry.ts) — postgres + backend API + browser-rendered frontend. Backend-forced when both sentinels are present in the plan, never picked by the LLM's own judgement (see iacGenerator.ts). */
  "compose-realworld-fullstack-v1",
  "tf-ecs-fargate-v1",
  "tf-eks-v1",
  /** Enterprise Architecture Advisor, Phase 2 (templates/enterpriseCatalog.ts) — solo_ecs_fargate/team_ecs_fargate_ha only. Backend-forced whenever CapacityPlan.architecture_recommendation.archetype is one of those two, never LLM-picked. Distinct from "tf-ecs-fargate-v1" (UC-9's unrelated retail-store-sample-app module) so the audit trail unambiguously shows which renderer actually produced a given plan's Terraform. */
  "tf-enterprise-ecs-fargate-v1",
  /** Not a catalog entry — the iac_generator wrote these files directly because nothing in the catalog covered the topology. See skills/novel-requirement-reasoning.md. */
  "freeform",
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
  /**
   * Pre-apply build pipeline (git clone -> npm ci -> build -> docker build ->
   * bring up a dependency -> run migrations), ordered. Null except on the
   * build-sentinel path (nodes/buildRegistry.ts) — every existing use case
   * leaves this null and is completely unaffected. Never produced by the
   * LLM; iac_generator derives it entirely from the hardcoded build registry.
   */
  build_steps: z
    .array(
      z.object({
        command: z.string(),
        /**
         * "deployment" is the shared deploy dir; any other value is a
         * per-build-sentinel clone directory of the shape "repo-<registry
         * key>" (nodes/buildRegistry.ts), one per resolved sentinel service
         * so cloning more than one repo in the same build doesn't collide.
         * The regex only constrains shape — `cwd` is produced exclusively by
         * iac_generator (never the LLM/user), and build.ts/commandAllowList.ts
         * both independently verify it resolves to an actual BUILD_REGISTRY
         * key before using it as a directory name, rather than trusting the
         * schema shape alone.
         */
        cwd: z.union([z.literal("deployment"), z.string().regex(/^repo-[a-z0-9][a-z0-9_-]*$/)]),
        env: z.record(z.string(), z.string()).optional(),
      })
    )
    .nullable()
    .default(null),
  /** service name -> locally-built image tag, populated only on the build-sentinel path so environment snapshots reflect what's actually running, not the __BUILD__:... sentinel string. */
  resolved_images: z.record(z.string(), z.string()).nullable().default(null),
  /**
   * Full Dockerfile content to write before the corresponding `docker build`
   * step, replacing the repo's own — only set when a service resolves to a
   * BuildRegistryEntry with a non-null dockerfileOverride. Keyed by the
   * build step's own `cwd` (its clone dir), NOT by service name — build.ts
   * only ever knows `cwd`, never a CapacityPlan service name, and a single
   * build can now involve more than one cloned repo (nodes/buildRegistry.ts's
   * `pairedWith` mechanism). Deliberately keyed differently from
   * `health_path` below (service-name-keyed) — two different consumers, two
   * different natural keys; don't "fix" this into false consistency.
   */
  dockerfile_override: z.record(z.string(), z.string()).nullable().default(null),
  /**
   * HTTP path verify checks against, keyed by CapacityPlan service name — was
   * previously a single scalar applied to every endpoint uniformly, which
   * only worked because every template rendered exactly one app service.
   * Every non-fullstack template still populates exactly one entry; only
   * compose-realworld-fullstack-v1 populates two (backend `/api/tags`,
   * frontend `/`).
   */
  health_path: z.record(z.string(), z.string()).default({}),
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
/**
 * Freeform variant: the LLM writes IaC file contents directly when nothing in
 * the catalogue fits (skills/novel-requirement-reasoning.md), rather than
 * picking a template_id + variables. apply_command/rollback_command are
 * still never produced by the LLM in this shape either — the backend derives
 * them generically from `format` + the project name, matching the exact
 * literal strings commandAllowList.ts already expects (see iacGenerator.ts:
 * genericCommandsFor).
 */
export const IaCGeneratorFreeformOutputSchema = z.object({
  format: z.enum(["compose", "terraform"]),
  files: z.array(IaCFileSchema),
});
export type IaCGeneratorFreeformOutput = z.infer<typeof IaCGeneratorFreeformOutputSchema>;

export const IaCGeneratorLLMOutputSchema = z.union([
  z.object({
    template_id: TemplateIdSchema,
    variables: z.record(z.string(), z.unknown()),
  }),
  IaCGeneratorFreeformOutputSchema,
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
// 3c. ComplianceReport (compliance_check -> approval gate). Enterprise-mode
// only — absent for every other use case. Mirrors PolicyReport/PolicyFinding's
// shape; unlike policy_validator, every finding here is non-auto-fixable (a
// gap is rooted in which managed controls the planner chose, which
// iac_generator has no lever over), so there is no retry loop.
// ---------------------------------------------------------------------------
export const ComplianceFindingStatusSchema = z.enum(["satisfied", "gap", "not_applicable"]);
export type ComplianceFindingStatus = z.infer<typeof ComplianceFindingStatusSchema>;

export const ComplianceControlFindingSchema = z.object({
  control_id: z.string(),
  framework: ComplianceTargetSchema,
  status: ComplianceFindingStatusSchema,
  severity: z.enum(["critical", "high", "medium", "low"]),
  message: z.string(),
  satisfied_by: z.string().nullable(),
});
export type ComplianceControlFinding = z.infer<typeof ComplianceControlFindingSchema>;

export const ComplianceReportSchema = z.object({
  request_id: z.string(),
  frameworks: z.array(ComplianceTargetSchema),
  findings: z.array(ComplianceControlFindingSchema),
  passed: z.boolean(),
  gap_count: z.number().int(),
});
export type ComplianceReport = z.infer<typeof ComplianceReportSchema>;

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
  "compliance_check",
  "iac_generator",
  "policy_validator",
  "approval_gate",
  "build",
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
  /** Deploy track Gate 1: paused for human approval of the capacity plan itself, before iac_generator ever runs. Distinct from "awaiting_plan_review" (the plan-only track's terminal, timeout-free review) — this gate leads to Gate 2 ("awaiting_approval") on approval, and keeps the 30-min timeout since deployment is the eventual intent. */
  "awaiting_plan_approval",
  /** Deploy track Gate 2: paused for human approval of the generated IaC + deploy commands, after iac_generator/policy_validator have run. */
  "awaiting_approval",
  /** Plan-only track: paused for human review of the plan itself, no IaC/deploy exists for this run and no auto-reject timeout applies. */
  "awaiting_plan_review",
  "deployed",
  "failed",
  "rolled_back",
  "refused",
  /** Plan-only track terminal state: human accepted the plan via "accept_plan" — no deployment ever happened. */
  "plan_ready",
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

export const DecisionActionSchema = z.enum(["approve_plan", "approve", "reject", "edit", "accept_plan"]);
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
  compliance_report?: ComplianceReport;
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
    "awaiting_plan_approval",
    "awaiting_approval",
    "awaiting_plan_review",
    "log_line",
    "run_finished",
  ]),
  request_id: z.string(),
  node: NodeNameSchema.optional(),
  ts: z.string(),
  payload: z.unknown().optional(),
});
export type WsEvent = z.infer<typeof WsEventSchema>;
