import type {
  ArchitectureAlternative,
  ArchitectureRecommendation,
  CapacityPlanOption,
  ComplianceTarget,
  CriticalityBand,
  EnterpriseContext,
  ManagedControl,
  OrgScale,
  PlanRequest,
  PlatformArchetype,
  ServiceSpec,
} from "@ops-master/shared";
import {
  estimateManagedControlsMonthlyCost,
  estimateNetworkingMonthlyCost,
  estimatePrimaryDatabaseMonthlyCost,
} from "../pricing/awsRateTable.js";
import { estimateMonthlyCost } from "../pricing/rateTable.js";

/**
 * The Enterprise Architecture Advisor's "brain": a deterministic rules engine
 * over two independent axes (organizational scale, workload criticality) plus
 * a compliance overlay, usable in mock mode with no LLM call. Two illustrative
 * scenarios anchored the design (a PCI-DSS payment platform; a 2-developer
 * MVP that rescales to 500 developers) but this must generalize to arbitrary
 * combinations, not just those two — see agent-md-files/02c-compliance-check.md
 * and CONTRACTS.md §2c for the worked examples and reasoning.
 */

// ---------------------------------------------------------------------------
// Axis 1: organizational scale -> platform archetype
// ---------------------------------------------------------------------------

/** Unstated team size defaults to "solo" — org_scale and criticality are deliberately independent axes, so a small team can still score very_high criticality (e.g. a 2-person shop running a PCI-DSS-critical workload for someone else). */
export function classifyOrgScale(teamSize: number | null): OrgScale {
  if (teamSize === null) return "solo";
  if (teamSize <= 3) return "solo";
  if (teamSize <= 49) return "team";
  if (teamSize <= 249) return "scale_up";
  return "enterprise";
}

const ARCHETYPE_BY_ORG_SCALE: Record<OrgScale, PlatformArchetype> = {
  solo: "solo_ecs_fargate",
  team: "team_ecs_fargate_ha",
  scale_up: "scale_up_eks",
  enterprise: "enterprise_eks_landing_zone",
};

export function archetypeForOrgScale(orgScale: OrgScale): PlatformArchetype {
  return ARCHETYPE_BY_ORG_SCALE[orgScale];
}

const ARCHETYPE_REASONING: Record<PlatformArchetype, string> = {
  solo_ecs_fargate:
    "1-3 person team: single ECS Fargate service, GitHub Actions deploying directly, CloudWatch logs — no platform team to operate anything heavier.",
  team_ecs_fargate_ha:
    "4-49 engineers: still ECS Fargate, but Multi-AZ task placement and a hardened CI/CD pipeline (protected branches, a real staging environment) — enough people to need HA, not yet enough to justify a Kubernetes platform team.",
  scale_up_eks:
    "50-249 engineers across multiple teams: EKS + ArgoCD (GitOps) becomes worth the operational overhead once several teams are shipping independently, with 2-3 AWS accounts (prod/non-prod) and baseline AWS Config.",
  enterprise_eks_landing_zone:
    "250+ engineers across many teams: a full multi-account landing zone (AWS Organizations + Control Tower + Transit Gateway + IAM Identity Center) is the governance baseline any organization this size needs regardless of what any single workload does; EKS + ArgoCD remains the paved-road compute platform.",
};

function control(
  name: string,
  category: ManagedControl["category"],
  triggeredBy: ManagedControl["triggered_by"],
  reasoning: string,
  terraformBundleTemplateId: string | null,
  complianceTags: string[] = []
): ManagedControl {
  return {
    name,
    category,
    triggered_by: triggeredBy,
    reasoning,
    compliance_tags: complianceTags,
    estimated_cost_usd_monthly: 0, // priced in a single pass once the final deduplicated list is known
    terraform_bundle_template_id: terraformBundleTemplateId,
  };
}

function archetypeControl(
  name: string,
  category: ManagedControl["category"],
  reasoning: string,
  terraformBundleTemplateId: string | null
): ManagedControl {
  return control(name, category, "archetype", reasoning, terraformBundleTemplateId);
}

function criticalityControl(
  name: string,
  category: ManagedControl["category"],
  reasoning: string,
  terraformBundleTemplateId: string | null
): ManagedControl {
  return control(name, category, "criticality", reasoning, terraformBundleTemplateId);
}

function complianceControl(
  name: string,
  category: ManagedControl["category"],
  reasoning: string,
  terraformBundleTemplateId: string | null,
  complianceTags: string[]
): ManagedControl {
  return control(name, category, "compliance_overlay", reasoning, terraformBundleTemplateId, complianceTags);
}

function archetypeManagedControls(archetype: PlatformArchetype): ManagedControl[] {
  switch (archetype) {
    case "solo_ecs_fargate":
    case "team_ecs_fargate_ha":
      return [];
    case "scale_up_eks":
      return [
        archetypeControl(
          "AWS Config",
          "compliance",
          "Baseline configuration monitoring once multiple teams share AWS accounts.",
          "tf-security-baseline-v1"
        ),
      ];
    case "enterprise_eks_landing_zone":
      return [
        archetypeControl(
          "AWS Organizations",
          "identity",
          "Multi-account governance baseline for 250+ engineers across many teams — control-plane, no incremental AWS charge.",
          "tf-landing-zone-v1"
        ),
        archetypeControl(
          "AWS Control Tower",
          "identity",
          "Automates landing-zone guardrails (SCPs, account vending) across the organization.",
          "tf-landing-zone-v1"
        ),
        archetypeControl(
          "AWS IAM Identity Center",
          "identity",
          "Federated single sign-on across every account instead of per-account IAM users.",
          "tf-landing-zone-v1"
        ),
        archetypeControl(
          "AWS Transit Gateway",
          "network",
          "Central hub for inter-account/VPC networking once there are multiple AWS accounts to connect.",
          "tf-network-transit-gateway-v1"
        ),
      ];
  }
}

// ---------------------------------------------------------------------------
// Axis 2: workload criticality (weighted score -> band -> cumulative controls)
// ---------------------------------------------------------------------------

export interface CriticalityFactor {
  factor: string;
  points: number;
}

export interface CriticalityScore {
  score: number;
  band: CriticalityBand;
  factors: CriticalityFactor[];
}

/** Weighted sum (max 14) over compliance/domain/scale/DR signals. Bands: low 0-2, medium 3-6, high 7-10, very_high 11-14. */
export function scoreCriticality(ctx: EnterpriseContext): CriticalityScore {
  const factors: CriticalityFactor[] = [];

  if (ctx.compliance_targets.some((t) => t !== "none")) {
    factors.push({ factor: `compliance target present (${ctx.compliance_targets.join(", ")})`, points: 3 });
  }
  if (ctx.industry_domain === "payments" || ctx.industry_domain === "healthcare") {
    factors.push({ factor: `${ctx.industry_domain} industry domain`, points: 3 });
  }
  if (ctx.expected_users !== null && ctx.expected_users >= 1_000_000) {
    factors.push({ factor: `expected users >= 1,000,000 (${ctx.expected_users.toLocaleString()})`, points: 2 });
  }
  if (ctx.rpo_minutes !== null && ctx.rpo_minutes <= 15) {
    factors.push({ factor: `RPO <= 15 min (${ctx.rpo_minutes}min)`, points: 2 });
  }
  if (ctx.rto_minutes !== null && ctx.rto_minutes <= 30) {
    factors.push({ factor: `RTO <= 30 min (${ctx.rto_minutes}min)`, points: 2 });
  }
  if (ctx.multi_region) {
    factors.push({ factor: "multi-region deployment", points: 2 });
  }

  const score = factors.reduce((sum, f) => sum + f.points, 0);
  const band: CriticalityBand = score >= 11 ? "very_high" : score >= 7 ? "high" : score >= 3 ? "medium" : "low";
  return { score, band, factors };
}

/** Cumulative by band: medium ⊂ high ⊂ very_high — a higher band never loses a lower band's controls. */
function criticalityControls(band: CriticalityBand): ManagedControl[] {
  const medium: ManagedControl[] = [
    criticalityControl(
      "AWS Backup",
      "dr_ha",
      "Medium+ criticality requires an automated backup plan, not ad-hoc snapshots.",
      "tf-backup-v1"
    ),
    criticalityControl(
      "Amazon GuardDuty",
      "detection",
      "Medium+ criticality requires continuous threat detection.",
      "tf-security-baseline-v1"
    ),
    criticalityControl(
      "AWS WAF",
      "network",
      "Medium+ criticality on an internet-facing workload requires a web application firewall.",
      "tf-security-baseline-v1"
    ),
  ];
  const high: ManagedControl[] = [
    ...medium,
    criticalityControl(
      "AWS Security Hub",
      "compliance",
      "High criticality requires centralized security-findings aggregation.",
      "tf-security-baseline-v1"
    ),
    criticalityControl(
      "AWS Config",
      "compliance",
      "High criticality requires continuous configuration-compliance monitoring.",
      "tf-security-baseline-v1"
    ),
    criticalityControl(
      "AWS CloudTrail",
      "detection",
      "High criticality requires an organization-wide audit trail.",
      "tf-security-baseline-v1"
    ),
    criticalityControl(
      "AWS KMS",
      "data_protection",
      "High criticality requires customer-managed encryption keys, not AWS-managed defaults.",
      "tf-security-baseline-v1"
    ),
    criticalityControl(
      "AWS Secrets Manager",
      "data_protection",
      "High criticality requires rotated, audited secret storage.",
      "tf-security-baseline-v1"
    ),
  ];
  const veryHigh: ManagedControl[] = [
    ...high,
    criticalityControl(
      "AWS Shield Advanced",
      "dr_ha",
      "Very-high criticality requires advanced DDoS protection beyond the Shield Standard default.",
      "tf-shield-advanced-v1"
    ),
    criticalityControl(
      "Aurora Global Database",
      "dr_ha",
      "Very-high criticality with tight RPO/RTO requires a cross-region-replicated primary data store.",
      "tf-data-aurora-global-v1"
    ),
    criticalityControl(
      "Amazon Route 53 (health-check failover)",
      "dr_ha",
      "Very-high criticality requires automated regional failover routing.",
      "tf-dns-failover-v1"
    ),
  ];

  switch (band) {
    case "low":
      return [];
    case "medium":
      return medium;
    case "high":
      return high;
    case "very_high":
      return veryHigh;
  }
}

// ---------------------------------------------------------------------------
// Compliance overlay: independent of the other two axes — a framework can
// mandate a control neither org-scale nor criticality alone would require yet.
// Illustrative control->service mapping, not audited against PCI-DSS
// v4/HIPAA Security Rule text verbatim (see 02c-compliance-check.md).
// ---------------------------------------------------------------------------

function complianceOverlayControls(targets: ComplianceTarget[]): ManagedControl[] {
  const controls: ManagedControl[] = [];
  if (targets.includes("pci_dss")) {
    controls.push(
      complianceControl(
        "AWS WAF",
        "network",
        "PCI-DSS 6.6 requires a web application firewall in front of any cardholder-data-adjacent application.",
        "tf-security-baseline-v1",
        ["PCI-DSS-6.6"]
      ),
      complianceControl(
        "AWS KMS",
        "data_protection",
        "PCI-DSS 3.4 requires strong cryptography for stored cardholder data.",
        "tf-security-baseline-v1",
        ["PCI-DSS-3.4"]
      ),
      complianceControl(
        "AWS Secrets Manager",
        "data_protection",
        "PCI-DSS 8.2 requires managed, rotated credentials rather than hardcoded secrets.",
        "tf-security-baseline-v1",
        ["PCI-DSS-8.2"]
      ),
      complianceControl(
        "AWS CloudTrail",
        "detection",
        "PCI-DSS 10.2 requires audit logging with log-file validation.",
        "tf-security-baseline-v1",
        ["PCI-DSS-10.2"]
      ),
      complianceControl(
        "AWS Config",
        "compliance",
        "PCI-DSS 2.2 requires enforced configuration standards.",
        "tf-security-baseline-v1",
        ["PCI-DSS-2.2"]
      )
    );
  }
  if (targets.includes("hipaa")) {
    controls.push(
      complianceControl(
        "AWS KMS",
        "data_protection",
        "HIPAA 164.312(a)(2)(iv) requires encryption of ePHI at rest.",
        "tf-security-baseline-v1",
        ["HIPAA-164.312(a)(2)(iv)"]
      ),
      complianceControl(
        "AWS CloudTrail",
        "detection",
        "HIPAA 164.312(b) requires audit controls over ePHI access.",
        "tf-security-baseline-v1",
        ["HIPAA-164.312(b)"]
      ),
      complianceControl(
        "AWS Config",
        "compliance",
        "HIPAA 164.308(a)(1) requires ongoing security-configuration review.",
        "tf-security-baseline-v1",
        ["HIPAA-164.308(a)(1)"]
      ),
      complianceControl(
        "AWS Backup",
        "dr_ha",
        "HIPAA 164.308(a)(7) requires a documented contingency/backup plan.",
        "tf-backup-v1",
        ["HIPAA-164.308(a)(7)"]
      ),
      complianceControl(
        "AWS IAM Identity Center",
        "identity",
        "HIPAA 164.312(a)(1) requires unique-user identification and access control.",
        null,
        ["HIPAA-164.312(a)(1)"]
      )
    );
  }
  return controls;
}

// ---------------------------------------------------------------------------
// Mock-mode parity for ArchitectureRecommendation.alternatives_considered: the
// real-LLM path (planner.ts's ENTERPRISE_MODE_NOTE) is asked to reason about
// named AWS alternatives it rejected for dr_ha/data_protection/network
// controls; this static table gives the deterministic mock path the same
// shape of output for the controls where a genuine alternative exists, so
// mock and real-LLM behavior stay consistent (per this repo's convention:
// mock functions must track prompt behavior, not just be stub placeholders).
// ---------------------------------------------------------------------------

const ALTERNATIVES_BY_CONTROL_NAME: Record<string, ArchitectureAlternative[]> = {
  "Aurora Global Database": [
    {
      option: "Aurora Global Database",
      pros: "Sub-second storage-based replication to a secondary region, promotable read replica for a fast regional failover, standard MySQL/Postgres compatibility with no app rewrite.",
      cons: "Aurora-specific pricing (replicated I/O + secondary cluster compute), failover to the secondary region is fast but not instant/automatic without Route 53 or a custom health check wired in.",
      rejected_because: null,
    },
    {
      option: "Cross-region read replicas (standard RDS)",
      pros: "Cheaper than Aurora Global Database, simpler mental model, works with any RDS engine.",
      cons: "Asynchronous replication lag is typically seconds-to-minutes, not sub-second; promoting a replica to primary is a manual/scripted operation, not push-button.",
      rejected_because: "Replication lag and manual promotion can't reliably meet an RPO under 5 minutes / RTO under 15 minutes at this criticality.",
    },
    {
      option: "DynamoDB Global Tables",
      pros: "Multi-region active-active out of the box, effectively meets any RPO/RTO target, fully managed.",
      cons: "Forces a NoSQL data model — any existing relational schema/queries need a rewrite, and multi-region write conflicts need application-level resolution.",
      rejected_because: "Requires a full data-model migration away from the relational schema this workload already assumes; not a drop-in replacement.",
    },
  ],
  "AWS Shield Advanced": [
    {
      option: "AWS Shield Advanced",
      pros: "24/7 DDoS Response Team access, cost protection against scaling charges incurred during an attack, deep integration with WAF/CloudFront/Route 53.",
      cons: "Meaningful fixed monthly cost plus a 1-year commitment, only pays for itself at this criticality/traffic level.",
      rejected_because: null,
    },
    {
      option: "AWS Shield Standard (default, free)",
      pros: "No additional cost, automatically active on every AWS account, covers common network-layer floods.",
      cons: "No response team access, no cost protection, materially less coverage against sophisticated/application-layer attacks.",
      rejected_because: "Very-high criticality on a payments-adjacent workload warrants the response-team SLA and cost protection Standard doesn't include.",
    },
  ],
  "Amazon Route 53 (health-check failover)": [
    {
      option: "Route 53 health-check failover routing",
      pros: "DNS-layer failover with health checks already integrated with most AWS origin types, low cost, no extra compute.",
      cons: "DNS TTL/caching means failover isn't instantaneous for every client — some clients may hold a stale record briefly.",
      rejected_because: null,
    },
    {
      option: "AWS Global Accelerator",
      pros: "Anycast IP means failover is effectively instant with no DNS caching delay, also improves baseline latency via the AWS backbone.",
      cons: "Higher fixed monthly cost, adds another piece of network infrastructure to operate.",
      rejected_because: "Route 53 failover meets the stated RTO at materially lower cost; Global Accelerator's instant-failover edge isn't needed to hit a 15-minute RTO.",
    },
  ],
};

function alternativesForControls(controls: ManagedControl[]): ArchitectureAlternative[] {
  const seen = new Set<string>();
  const result: ArchitectureAlternative[] = [];
  for (const c of controls) {
    const entries = ALTERNATIVES_BY_CONTROL_NAME[c.name];
    if (!entries || seen.has(c.name)) continue;
    seen.add(c.name);
    result.push(...entries);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Mock-mode parity for ArchitectureRecommendation.client_classification: the
// real-LLM path (compliance-and-dr-reasoning.md) is asked to describe the
// client freely in plain English, not from a fixed enum. This deterministic
// version composes the same idea from the axes already computed, so the
// mock path always populates the field too.
// ---------------------------------------------------------------------------

const ORG_SCALE_LABEL: Record<OrgScale, string> = {
  solo: "solo/small-team",
  team: "small-to-mid-team",
  scale_up: "scale-up-organization",
  enterprise: "large-enterprise",
};

const INDUSTRY_LABEL: Record<EnterpriseContext["industry_domain"], string> = {
  payments: "fintech/payments",
  healthcare: "healthcare",
  retail: "retail",
  generic: "general-purpose",
};

const CRITICALITY_LABEL: Record<CriticalityBand, string> = {
  very_high: "very high-stakes",
  high: "high-stakes",
  medium: "moderate-stakes",
  low: "low-stakes",
};

function deriveClientClassification(ctx: EnterpriseContext, band: CriticalityBand): string {
  return `${ORG_SCALE_LABEL[ctx.org_scale]} ${INDUSTRY_LABEL[ctx.industry_domain]} workload, ${CRITICALITY_LABEL[band]}`;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Combines all three axes into one deduplicated, priced list. A control required by more than one axis appears once — compliance wins ties as the strictest justification, but tags/reasoning from every contributing axis are preserved. */
export function buildArchitectureRecommendation(ctx: EnterpriseContext): ArchitectureRecommendation {
  const archetype = archetypeForOrgScale(ctx.org_scale);
  const { score, band, factors } = scoreCriticality(ctx);

  const combined = [
    ...archetypeManagedControls(archetype),
    ...criticalityControls(band),
    ...complianceOverlayControls(ctx.compliance_targets),
  ];

  const byName = new Map<string, ManagedControl>();
  for (const c of combined) {
    const existing = byName.get(c.name);
    if (!existing) {
      byName.set(c.name, c);
      continue;
    }
    const winner = c.triggered_by === "compliance_overlay" ? c : existing;
    const loser = winner === c ? existing : c;
    byName.set(c.name, {
      ...winner,
      compliance_tags: Array.from(new Set([...winner.compliance_tags, ...loser.compliance_tags])),
    });
  }
  const deduped = Array.from(byName.values());

  const cost = estimateManagedControlsMonthlyCost(deduped.map((c) => c.name));
  const priced = deduped.map((c, i) => ({ ...c, estimated_cost_usd_monthly: cost.breakdown[i].usd_monthly }));

  const criticalityReasoning =
    factors.length > 0
      ? `${factors.map((f) => `${f.factor} (+${f.points})`).join(", ")} = ${score}/14 -> ${band}.`
      : "No criticality signals detected -> 0/14 -> low.";

  return {
    enterprise_context: ctx,
    archetype,
    archetype_reasoning: ARCHETYPE_REASONING[archetype],
    criticality_score: score,
    criticality_band: band,
    criticality_reasoning: criticalityReasoning,
    managed_controls: priced,
    compliance_overlay: ctx.compliance_targets,
    total_controls_cost_usd_monthly: cost.totalUsdMonthly,
    alternatives_considered: alternativesForControls(priced),
    client_classification: deriveClientClassification(ctx, band),
  };
}

// ---------------------------------------------------------------------------
// planner.ts integration — returns a CapacityPlanOption[] shaped exactly like
// buildAwsOptions's output so every downstream node (readiness_check,
// iac_generator, policy_validator, approval-gate UI, deploy/rollback's
// existing plan-only terraform branch) works unmodified.
// ---------------------------------------------------------------------------

/** Illustrative compute footprint per archetype — Phase 1 has no concrete app topology to size against (the request describes a business, not a service list), so this is a single representative workload, clearly labeled as such. */
const COMPUTE_SPEC_BY_ARCHETYPE: Record<PlatformArchetype, { cpu: string; memory: string; replicas: number }> = {
  solo_ecs_fargate: { cpu: "0.25", memory: "512Mi", replicas: 1 },
  team_ecs_fargate_ha: { cpu: "0.5", memory: "1Gi", replicas: 2 },
  scale_up_eks: { cpu: "1.0", memory: "2Gi", replicas: 3 },
  enterprise_eks_landing_zone: { cpu: "2.0", memory: "4Gi", replicas: 5 },
};

const AVAILABILITY_NOTES_BY_BAND: Record<CriticalityBand, string> = {
  very_high:
    "Survives an AZ outage and a full regional outage — Shield Advanced, Aurora Global Database, and Route53 failover routing are all in the recommended controls.",
  high: "Survives an AZ outage; no cross-region failover recommended at this criticality.",
  medium: "Automated backups in place; no automatic failover recommended at this criticality.",
  low: "No redundancy beyond the platform archetype's own defaults — acceptable for this criticality level.",
};

export function buildEnterpriseOptions(planRequest: PlanRequest, humanFeedback?: string): CapacityPlanOption[] {
  const ctx = planRequest.enterprise_context;
  if (!ctx) {
    throw new Error(
      "buildEnterpriseOptions called without enterprise_context — planner.ts must only reach this branch when enterprise_mode is true."
    );
  }
  const recommendation = buildArchitectureRecommendation(ctx);
  const computeSpec = COMPUTE_SPEC_BY_ARCHETYPE[recommendation.archetype];
  const dbMultiAz = recommendation.criticality_band === "high" || recommendation.criticality_band === "very_high";

  // Every real business workload needs a data store — previously missing
  // entirely from this estimate, which made the total look implausibly low
  // (compute + security/compliance add-ons, but no actual database or
  // networking cost). Sized by criticality band, same single-AZ vs. Multi-AZ
  // split every other tier in this codebase already uses.
  const services: ServiceSpec[] = [
    {
      name: "app",
      image: `illustrative ${recommendation.archetype.replace(/_/g, "-")} workload — no concrete service topology was described in the request`,
      cpu: computeSpec.cpu,
      memory: computeSpec.memory,
      replicas: computeSpec.replicas,
      ports: [8080],
    },
    {
      name: "db",
      image: "illustrative managed primary data store (RDS/Aurora-compatible) — assumed for any real business workload",
      cpu: "n/a (managed service)",
      memory: "n/a (managed service)",
      replicas: 1,
      ports: [5432],
      managed_service: "rds",
      multi_az: dbMultiAz,
    },
  ];

  const computeCost = estimateMonthlyCost([services[0]], []);
  const dbCost = estimatePrimaryDatabaseMonthlyCost(recommendation.criticality_band);
  const networkCost = estimateNetworkingMonthlyCost(recommendation.archetype);
  const controlsCost = estimateManagedControlsMonthlyCost(recommendation.managed_controls.map((c) => c.name));

  const feedbackSuffix = humanFeedback
    ? ` Reviewer feedback noted: "${humanFeedback}" — this recommendation is derived deterministically from org scale, criticality, and compliance signals in the business description; adjust the description (e.g. stated team size or compliance target) and resubmit to change it.`
    : "";

  const controlsSummary =
    recommendation.managed_controls.length > 0
      ? ` Managed controls added: ${recommendation.managed_controls.map((c) => c.name).join(", ")}.`
      : " No additional managed controls required at this criticality/org-scale combination.";

  const dbSummary = ` Primary data store assumed (${dbMultiAz ? "Multi-AZ" : "single-AZ"} RDS/Aurora-compatible) since every real business workload needs one, plus baseline NAT Gateway networking.`;

  const reasoning =
    `${recommendation.archetype_reasoning} ${recommendation.criticality_reasoning}${dbSummary}${controlsSummary}` +
    feedbackSuffix;

  const option: CapacityPlanOption = {
    tier: "balanced",
    services,
    storage: [],
    network: { expose: [], internal: [] },
    reasoning,
    feasible: true,
    infeasibility_reason: null,
    estimated_cost_usd_monthly:
      computeCost.totalUsdMonthly + dbCost.totalUsdMonthly + networkCost.totalUsdMonthly + controlsCost.totalUsdMonthly,
    cost_breakdown: [...computeCost.breakdown, ...dbCost.breakdown, ...networkCost.breakdown, ...controlsCost.breakdown],
    cost_basis: "rate_table",
    headroom_pct: 0,
    availability_notes: AVAILABILITY_NOTES_BY_BAND[recommendation.criticality_band],
  };

  return [option];
}

// ---------------------------------------------------------------------------
// intake.ts integration — mock/deterministic business-signal extraction.
// ---------------------------------------------------------------------------

const TEAM_SIZE_RE = /(\d+)\s*(developers?|devs?|engineers?)\b/i;
const USERS_RE = /(\d[\d,.]*)\s*(million|m|k)?\s*users?\b/i;
const RPO_RE = /rpo\s*[<≤]\s*(\d+)\s*min/i;
const RTO_RE = /rto\s*[<≤]\s*(\d+)\s*min/i;
const MULTI_REGION_RE = /multi[\s-]?region|cross[\s-]?region|\bdr\b/i;
const PCI_RE = /pci[\s-]?dss/i;
const HIPAA_RE = /hipaa/i;
const SOC2_RE = /soc\s?2/i;
const PAYMENTS_RE = /\b(payment|fintech|banking)\b/i;
const HEALTHCARE_RE = /\b(health|medical|hipaa|patient)\b/i;

function parseExpectedUsers(rawText: string): number | null {
  const m = rawText.match(USERS_RE);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  const unit = m[2]?.toLowerCase();
  if (unit === "million" || unit === "m") return base * 1_000_000;
  if (unit === "k") return base * 1_000;
  return base;
}

/** True if raw_text contains any signal this mode is designed to reason about — checked against every existing use case's text to confirm none false-trigger (see agent-md-files/USE_CASES.md UC-1..UC-9). */
export function detectEnterpriseMode(rawText: string): boolean {
  return (
    TEAM_SIZE_RE.test(rawText) ||
    PCI_RE.test(rawText) ||
    HIPAA_RE.test(rawText) ||
    SOC2_RE.test(rawText) ||
    RPO_RE.test(rawText) ||
    RTO_RE.test(rawText) ||
    MULTI_REGION_RE.test(rawText) ||
    PAYMENTS_RE.test(rawText) ||
    HEALTHCARE_RE.test(rawText)
  );
}

export function mockExtractEnterpriseContext(rawText: string): EnterpriseContext {
  const teamMatch = rawText.match(TEAM_SIZE_RE);
  const team_size = teamMatch ? Number(teamMatch[1]) : null;
  const expected_users = parseExpectedUsers(rawText);
  const rpoMatch = rawText.match(RPO_RE);
  const rtoMatch = rawText.match(RTO_RE);
  const rpo_minutes = rpoMatch ? Number(rpoMatch[1]) : null;
  const rto_minutes = rtoMatch ? Number(rtoMatch[1]) : null;
  const multi_region = MULTI_REGION_RE.test(rawText);

  const compliance_targets: ComplianceTarget[] = [];
  if (PCI_RE.test(rawText)) compliance_targets.push("pci_dss");
  if (HIPAA_RE.test(rawText)) compliance_targets.push("hipaa");
  if (SOC2_RE.test(rawText)) compliance_targets.push("soc2");

  let industry_domain: EnterpriseContext["industry_domain"] = "generic";
  if (PAYMENTS_RE.test(rawText)) industry_domain = "payments";
  else if (HEALTHCARE_RE.test(rawText)) industry_domain = "healthcare";

  const org_scale = classifyOrgScale(team_size);

  const reasoningParts: string[] = [
    teamMatch
      ? `"${teamMatch[0].trim()}" -> team_size=${team_size} -> org_scale=${org_scale}`
      : `team size not stated -> org_scale defaults to "solo" (org-scale and criticality are independent axes)`,
  ];
  if (industry_domain !== "generic") reasoningParts.push(`industry_domain=${industry_domain} detected from wording`);
  if (compliance_targets.length > 0) reasoningParts.push(`compliance_targets=[${compliance_targets.join(", ")}] detected from wording`);
  if (expected_users !== null) reasoningParts.push(`expected_users=${expected_users.toLocaleString()} parsed from wording`);
  if (multi_region) reasoningParts.push("multi-region/DR phrasing detected");
  if (rpo_minutes !== null) reasoningParts.push(`RPO=${rpo_minutes}min parsed`);
  if (rto_minutes !== null) reasoningParts.push(`RTO=${rto_minutes}min parsed`);

  return {
    industry_domain,
    compliance_targets,
    expected_users,
    team_size,
    org_scale,
    multi_region,
    rpo_minutes,
    rto_minutes,
    signal_reasoning: `${reasoningParts.join("; ")}.`,
  };
}
