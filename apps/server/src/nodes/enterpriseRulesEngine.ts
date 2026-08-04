import type {
  ArchitectureAlternative,
  ArchitectureRecommendation,
  CapacityPlanOption,
  ComplianceTarget,
  ComponentNote,
  CriticalityBand,
  EnterpriseContext,
  ManagedControl,
  OrgScale,
  PlanRequest,
  PlatformArchetype,
  ServiceSpec,
  TaskGraphStep,
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

export const ARCHETYPE_REASONING: Record<PlatformArchetype, string> = {
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

/** ECS archetypes (solo/team) vs. EKS archetypes (scale_up/enterprise) — decides which concrete autoscaling/CI-CD mechanism the baseline controls below recommend. */
function computePlatform(archetype: PlatformArchetype): "ecs" | "eks" {
  return archetype === "solo_ecs_fargate" || archetype === "team_ecs_fargate_ha" ? "ecs" : "eks";
}

/**
 * Controls every archetype gets regardless of criticality/compliance — these were previously
 * missing entirely for solo/team (archetypeManagedControls returned []), which meant a plain
 * request with no compliance/criticality signal got zero load-balancing, encryption, monitoring,
 * auth, autoscaling, or CI/CD recommendation at all. Load balancing and baseline encryption are
 * priced at $0/null-bundle (already provisioned by the base compute module / included in the
 * underlying service's own cost) — they exist here for reasoning/cost-breakdown visibility, not
 * because they're a separate purchase.
 */
function baselineManagedControls(archetype: PlatformArchetype): ManagedControl[] {
  const platform = computePlatform(archetype);
  return [
    archetypeControl(
      "Application Load Balancer",
      "network",
      "Every internet-facing workload needs load-balanced, health-checked routing across replicas/AZs — rendered as part of the base compute layer's Terraform, priced here (base hourly rate + a modest LCU allowance) so it's visible in cost_breakdown instead of only implied.",
      null
    ),
    archetypeControl(
      "Amazon RDS/EBS/S3 Encryption at Rest (AWS-managed keys)",
      "data_protection",
      "Encryption at rest is enabled by default at every criticality level using AWS-managed keys; customer-managed keys (AWS KMS, priced separately) are only added once criticality crosses into the high band.",
      null
    ),
    archetypeControl(
      "Amazon CloudWatch (alarms + dashboards)",
      "monitoring",
      "Baseline observability (CPU/memory/error-rate alarms plus a dashboard) is required at every scale — the archetype's log group already exists; this adds alarms and a dashboard on top of it.",
      "tf-monitoring-v1"
    ),
    archetypeControl(
      "Amazon Cognito",
      "auth",
      "A real application needs end-user authentication/authorization (sign-up, sign-in, token issuance) — Cognito is the managed default so no team has to build and operate its own auth service.",
      "tf-auth-v1"
    ),
    platform === "ecs"
      ? archetypeControl(
          "ECS Service Auto Scaling (target tracking)",
          "autoscaling",
          "An ECS Fargate service should scale on a target-tracking policy (e.g. CPU or ALB request count per target) rather than a fixed task count, so a load spike above baseline is handled automatically instead of a human redeploying with a bigger desired_count.",
          "tf-autoscaling-v1"
        )
      : archetypeControl(
          "EKS Cluster Autoscaler",
          "autoscaling",
          "An EKS node group should scale via Cluster Autoscaler so pending pods trigger new worker nodes automatically instead of a human resizing the node group by hand.",
          "tf-autoscaling-v1"
        ),
    platform === "ecs"
      ? archetypeControl(
          "GitHub Actions CI/CD (OIDC deploy)",
          "cicd",
          "Even a solo/small team needs an automated build-test-deploy pipeline rather than manual `docker push`/`terraform apply` from a laptop — GitHub Actions with OIDC federation to AWS avoids storing long-lived AWS access keys in CI.",
          "tf-cicd-v1"
        )
      : archetypeControl(
          "ArgoCD (GitOps, self-hosted on EKS)",
          "cicd",
          "Once several teams are shipping independently onto shared EKS clusters, GitOps (declarative desired-state in git, continuously reconciled by ArgoCD) scales better than every team's own CI pipeline running `kubectl apply` directly.",
          "tf-cicd-v1"
        ),
  ];
}

function archetypeManagedControls(archetype: PlatformArchetype): ManagedControl[] {
  const baseline = baselineManagedControls(archetype);
  switch (archetype) {
    case "solo_ecs_fargate":
    case "team_ecs_fargate_ha":
      return baseline;
    case "scale_up_eks":
      return [
        ...baseline,
        archetypeControl(
          "AWS Config",
          "compliance",
          "Baseline configuration monitoring once multiple teams share AWS accounts.",
          "tf-security-baseline-v1"
        ),
      ];
    case "enterprise_eks_landing_zone":
      return [
        ...baseline,
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

/**
 * Cumulative by band: medium ⊂ high ⊂ very_high — a higher band never loses a lower band's controls.
 * `capAtHigh` treats a `very_high` band as `high` for control-selection purposes only — used to build
 * the "economy" priced tier's discretionary DR/HA posture (Shield Advanced / Aurora Global Database /
 * Route 53 failover are the only genuinely optional-for-cost controls; everything below `very_high`
 * is the same either way, and compliance-overlay/archetype controls are never affected by this flag).
 */
function criticalityControls(band: CriticalityBand, capAtHigh = false): ManagedControl[] {
  const effectiveBand = capAtHigh && band === "very_high" ? "high" : band;
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
    criticalityControl(
      "Amazon SQS (dead-letter queue)",
      "resilience",
      "Medium+ criticality requires a dead-letter queue and retry policy on asynchronous work so a downstream failure is captured and replayable instead of silently dropping the request.",
      "tf-resilience-v1"
    ),
  ];
  const high: ManagedControl[] = [
    ...medium,
    criticalityControl(
      "AWS X-Ray",
      "monitoring",
      "High criticality requires distributed tracing across services to diagnose latency/error incidents quickly, not just aggregate CloudWatch metrics.",
      "tf-monitoring-v1"
    ),
    criticalityControl(
      "Amazon Cognito Advanced Security Features",
      "auth",
      "High criticality requires adaptive MFA and compromised-credential detection on top of baseline Cognito authentication.",
      "tf-auth-v1"
    ),
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

  switch (effectiveBand) {
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
  "Amazon Cognito": [
    {
      option: "Amazon Cognito",
      pros: "Fully managed, native IAM/API Gateway integration, no separate vendor bill, scales to millions of users.",
      cons: "Less polished admin UI and fewer out-of-box social/enterprise-SSO connectors than dedicated identity vendors; deeper customization needs Lambda triggers.",
      rejected_because: null,
    },
    {
      option: "Auth0 / Okta",
      pros: "Very mature developer experience, extensive pre-built social/enterprise-SSO connectors, strong org-management tooling.",
      cons: "Per-MAU pricing gets expensive at scale; another vendor relationship and bill outside AWS.",
      rejected_because: "No stated multi-IdP/enterprise-SSO requirement in this request that would justify the extra cost over Cognito's native AWS integration.",
    },
    {
      option: "Custom-built auth service",
      pros: "Full control over the auth flow and data model.",
      cons: "Significant ongoing engineering and security burden (password storage, token rotation, MFA) that a managed service removes entirely.",
      rejected_because: "Building and operating auth in-house is never the reasonable default when a managed, compliant alternative exists.",
    },
  ],
  "GitHub Actions CI/CD (OIDC deploy)": [
    {
      option: "GitHub Actions (OIDC federation to AWS)",
      pros: "Already where the code lives, no separate CI vendor or bill, OIDC federation avoids storing long-lived AWS keys in CI.",
      cons: "Concurrency/minutes limits on the free tier once a team grows past a handful of engineers.",
      rejected_because: null,
    },
    {
      option: "AWS CodePipeline + CodeBuild",
      pros: "Fully AWS-native, integrates directly with IAM without OIDC federation, one fewer external dependency.",
      cons: "Weaker local-dev ergonomics and a smaller marketplace of pre-built actions than GitHub Actions.",
      rejected_because: "No stated requirement to keep the pipeline entirely inside the AWS console; GitHub Actions is simpler for a small team already hosting its code on GitHub.",
    },
    {
      option: "Jenkins (self-hosted)",
      pros: "Total control and a huge plugin ecosystem.",
      cons: "Requires standing up, patching, and securing a server yourself — real ongoing operational overhead.",
      rejected_because: "Self-hosting CI infrastructure isn't justified until a team is large enough to have someone own it.",
    },
  ],
  "ArgoCD (GitOps, self-hosted on EKS)": [
    {
      option: "ArgoCD (GitOps)",
      pros: "Declarative desired-state in git, automatic drift detection and reconciliation — scales well once many teams deploy onto shared clusters.",
      cons: "Another piece of infrastructure to operate on the cluster itself.",
      rejected_because: null,
    },
    {
      option: "AWS CodePipeline + CodeBuild driving kubectl/helm",
      pros: "Fully AWS-native, no extra in-cluster component to run.",
      cons: "Push-based deploys don't self-heal from manual cluster drift the way GitOps reconciliation does.",
      rejected_because: "At this org scale, several teams deploying independently benefit more from GitOps's drift-correction than from staying entirely inside CodePipeline.",
    },
  ],
  "EKS Cluster Autoscaler": [
    {
      option: "Cluster Autoscaler",
      pros: "Mature, widely used, works with standard EC2 Auto Scaling Groups.",
      cons: "Slower scale-out (waits on an ASG launch) and scales at the node-group level rather than matching pending pods' exact shape.",
      rejected_because: null,
    },
    {
      option: "Karpenter",
      pros: "Faster scale-out, more flexible bin-packing, provisions the exact instance shapes pending pods need.",
      cons: "Newer, smaller operational track record than Cluster Autoscaler.",
      rejected_because: "Cluster Autoscaler's maturity is the safer default absent a stated need for Karpenter's faster scale-out.",
    },
  ],
};

/**
 * Baseline (archetype-triggered, every-band) controls whose alternatives_considered entry is gated by
 * criticality — at "low" criticality the obviously-correct choice (Cognito / GitHub Actions / ArgoCD /
 * Cluster Autoscaler) isn't worth an LLM-style trade-off essay (confirmed against a real "2 developers
 * building an MVP" request generating a full 3-alternative comparison for an auth service nobody was
 * debating); once criticality is medium+ the choice can carry real cost/compliance weight and the
 * comparison earns its keep. The dr_ha/data_protection controls (Aurora Global Database, Shield Advanced,
 * Route 53 failover) need no equivalent gate — they're criticality-triggered, not archetype-triggered, so
 * they never appear below the band that already warrants the deeper reasoning.
 */
const BASELINE_ALTERNATIVES_GATED_BY_CRITICALITY = new Set([
  "Amazon Cognito",
  "GitHub Actions CI/CD (OIDC deploy)",
  "ArgoCD (GitOps, self-hosted on EKS)",
  "EKS Cluster Autoscaler",
]);

function alternativesForControls(controls: ManagedControl[], band: CriticalityBand): ArchitectureAlternative[] {
  const seen = new Set<string>();
  const result: ArchitectureAlternative[] = [];
  for (const c of controls) {
    if (band === "low" && BASELINE_ALTERNATIVES_GATED_BY_CRITICALITY.has(c.name)) continue;
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

/**
 * Combines all three axes into one deduplicated, priced list. A control required by more than one axis
 * appears once — compliance wins ties as the strictest justification, but tags/reasoning from every
 * contributing axis are preserved.
 *
 * `capAtHigh` (default false) is used internally by `buildEnterpriseOptions` to compute the "economy"
 * priced tier's own (lighter) control list — it never affects the single per-request
 * `CapacityPlan.architecture_recommendation`, which always reflects the full, uncapped recommendation
 * regardless of which tier a human ends up choosing.
 */
export function buildArchitectureRecommendation(ctx: EnterpriseContext, capAtHigh = false): ArchitectureRecommendation {
  const archetype = archetypeForOrgScale(ctx.org_scale);
  const { score, band, factors } = scoreCriticality(ctx);

  const combined = [
    ...archetypeManagedControls(archetype),
    ...criticalityControls(band, capAtHigh),
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
    alternatives_considered: alternativesForControls(priced, band),
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

/**
 * Builds one priced CapacityPlanOption for the Enterprise Architecture Advisor. `rec` carries whichever
 * (capped-for-economy or full-for-HA) managed_controls list applies to this tier — the caller
 * (buildEnterpriseOptions) decides that, this function just prices and narrates it.
 */
function buildOneEnterpriseOption(
  ctx: EnterpriseContext,
  computeSpec: { cpu: string; memory: string; replicas: number },
  archetype: PlatformArchetype,
  rec: ArchitectureRecommendation,
  tier: "economy" | "high_availability",
  dbMultiAz: boolean,
  droppedControls: ManagedControl[],
  availabilityNotes: string,
  humanFeedback?: string
): CapacityPlanOption {
  // Every real business workload needs a data store — previously missing
  // entirely from this estimate, which made the total look implausibly low
  // (compute + security/compliance add-ons, but no actual database or
  // networking cost). Sized by tier's dbMultiAz, same single-AZ vs. Multi-AZ
  // split every other tier in this codebase already uses.
  const services: ServiceSpec[] = [
    {
      name: "app",
      image: `illustrative ${archetype.replace(/_/g, "-")} workload — no concrete service topology was described in the request`,
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
  const dbCost = estimatePrimaryDatabaseMonthlyCost(dbMultiAz ? rec.criticality_band : "low");
  const networkCost = estimateNetworkingMonthlyCost(archetype);
  const controlsCost = estimateManagedControlsMonthlyCost(rec.managed_controls.map((c) => c.name));

  const feedbackSuffix = humanFeedback
    ? ` Reviewer feedback noted: "${humanFeedback}" — this recommendation is derived deterministically from org scale, criticality, and compliance signals in the business description; adjust the description (e.g. stated team size or compliance target) and resubmit to change it.`
    : "";

  const controlsSummary =
    rec.managed_controls.length > 0
      ? ` Managed controls in this tier: ${rec.managed_controls.map((c) => c.name).join(", ")}.`
      : " No additional managed controls required at this criticality/org-scale combination.";

  const dbSummary = ` Primary data store assumed (${dbMultiAz ? "Multi-AZ" : "single-AZ"} RDS/Aurora-compatible) since every real business workload needs one, plus baseline NAT Gateway networking.`;

  // Being explicit when this tier is cheaper because it doesn't meet a real stated requirement — same
  // honesty UC-9's economy tier already models for staging's lack of an uptime SLA.
  const complianceCaveat =
    tier === "economy" && droppedControls.length > 0
      ? ` This economy tier drops ${droppedControls.map((c) => c.name).join(", ")} to reduce cost` +
        (ctx.rpo_minutes !== null || ctx.rto_minutes !== null
          ? ` — it does NOT meet the stated ${ctx.rpo_minutes !== null ? `RPO < ${ctx.rpo_minutes}min` : ""}${ctx.rpo_minutes !== null && ctx.rto_minutes !== null ? "/" : ""}${ctx.rto_minutes !== null ? `RTO < ${ctx.rto_minutes}min` : ""} requirement; choose high_availability if that requirement is real.`
          : ", trading resilience for lower spend.")
      : "";

  const reasoning =
    `${ARCHETYPE_REASONING[archetype]} ${rec.criticality_reasoning}${dbSummary}${controlsSummary}${complianceCaveat}` +
    feedbackSuffix;

  const included_components: ComponentNote[] = [
    { component: "app", reason: `illustrative ${archetype.replace(/_/g, "-")} workload for this archetype, fronted by the Application Load Balancer below across its ${computeSpec.replicas} baseline replica(s)` },
    { component: "db", reason: "managed primary data store assumed for any real business workload" },
    ...rec.managed_controls.map((c) => ({ component: c.name, reason: c.reasoning })),
  ];
  const skipped_components: ComponentNote[] = [
    ...(dbMultiAz
      ? []
      : [
          {
            component: "Database Multi-AZ replication",
            reason:
              tier === "economy"
                ? "economy tier — traded off for lower monthly cost, see high_availability tier"
                : `criticality band "${rec.criticality_band}" does not require multi-AZ failover`,
          },
        ]),
    ...droppedControls.map((c) => ({
      component: c.name,
      reason: "economy tier — discretionary DR/HA control dropped to reduce cost; see high_availability tier",
    })),
  ];

  const task_graph: TaskGraphStep[] = [
    { step: 1, task: "Provision network + IAM landing zone", component: "Terraform" },
    { step: 2, task: "Deploy app workload", component: archetype },
    { step: 3, task: "Provision primary database (RDS/Aurora-compatible)", component: "RDS" },
    ...rec.managed_controls.map((c, i) => ({ step: 4 + i, task: `Apply managed control: ${c.name}`, component: c.category })),
    { step: 4 + rec.managed_controls.length, task: "Validate terraform plan", component: "Validation" },
  ];

  return {
    tier,
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
    availability_notes: availabilityNotes,
    included_components,
    skipped_components,
    task_graph,
    // Enterprise landing-zone work (IAM, compliance controls, managed data stores) is the heaviest tier in this codebase — illustrative figures, same basis as the cost estimates above.
    manual_estimate_person_days: 8 + rec.managed_controls.length * 1.5,
    agent_estimate_minutes: Math.min(60, 25 + rec.managed_controls.length * 3),
    scaling_strategy: {
      min_replicas: computeSpec.replicas,
      max_replicas: computeSpec.replicas * 2,
      trigger_description: `scale from the ${archetype} archetype's ${computeSpec.replicas}-replica baseline up to ${computeSpec.replicas * 2} if sustained load exceeds it — no live autoscaler configured in this sandbox, a human would provision the additional capacity manually`,
    },
  };
}

/**
 * Two priced tiers — "economy" and "high_availability" — mirroring UC-9's AWS pattern instead of a
 * single recommendation. Confirmed via real usage (see compliance-and-dr-reasoning.md's revision note)
 * that a single-option output reads as broken to a human reviewer expecting the same cost/capacity
 * comparison every other request type gets. Compliance-overlay and archetype controls never vary by
 * tier (not cost levers); only the very-high-band-exclusive DR/HA controls and DB Multi-AZ do.
 */
export function buildEnterpriseOptions(planRequest: PlanRequest, humanFeedback?: string): CapacityPlanOption[] {
  const ctx = planRequest.enterprise_context;
  if (!ctx) {
    throw new Error(
      "buildEnterpriseOptions called without enterprise_context — planner.ts must only reach this branch when enterprise_mode is true."
    );
  }
  const archetype = archetypeForOrgScale(ctx.org_scale);
  const computeSpec = COMPUTE_SPEC_BY_ARCHETYPE[archetype];

  // Uncapped — this exact object also becomes CapacityPlan.architecture_recommendation (planner.ts),
  // so it always reflects the full recommendation regardless of which tier a human picks.
  const fullRecommendation = buildArchitectureRecommendation(ctx);
  // Capped at "high" band for control selection — used only to price/narrate the economy tier's own
  // CapacityPlanOption, never exposed as a separate architecture_recommendation.
  const economyRecommendation = buildArchitectureRecommendation(ctx, true);

  const droppedControls = fullRecommendation.managed_controls.filter(
    (c) => !economyRecommendation.managed_controls.some((ec) => ec.name === c.name)
  );
  const haDbMultiAz = fullRecommendation.criticality_band === "high" || fullRecommendation.criticality_band === "very_high";

  const economyAvailabilityNotes =
    droppedControls.length > 0
      ? `Single-AZ database, no cross-region failover — does NOT survive a regional outage despite this workload being assessed as "${fullRecommendation.criticality_band}" criticality; the dropped controls (${droppedControls.map((c) => c.name).join(", ")}) are what provide that resilience in the high_availability tier.`
      : AVAILABILITY_NOTES_BY_BAND.low;

  const economy = buildOneEnterpriseOption(
    ctx,
    computeSpec,
    archetype,
    economyRecommendation,
    "economy",
    false,
    droppedControls,
    economyAvailabilityNotes,
    humanFeedback
  );
  const highAvailability = buildOneEnterpriseOption(
    ctx,
    computeSpec,
    archetype,
    fullRecommendation,
    "high_availability",
    haDbMultiAz,
    [],
    AVAILABILITY_NOTES_BY_BAND[fullRecommendation.criticality_band],
    humanFeedback
  );

  return [economy, highAvailability];
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
/**
 * Bare "payment"/"health" (the previous versions of these two regexes) false-triggered enterprise_mode —
 * and the expensive real 2-pass Enterprise Architecture Advisor LLM flow along with it — on completely
 * ordinary requests like "add a health check endpoint" or "a payment retry queue worker", both of which
 * are common phrasing in this exact domain, not a signal of an actual payments/healthcare business.
 * Require a real business-domain phrase instead — this is strictly a precision fix (fewer false
 * positives); every existing use case's text (see USE_CASES.md/smoke.ts) still matches ("payment
 * platform", "HIPAA healthcare startup").
 */
const PAYMENTS_RE = /\b(payments?\s+(platform|company|processor|gateway|system)|fintech|banking)\b/i;
// "hipaa" kept (unlike bare "health") — it's a specific, unambiguous acronym in the same precision class
// as PCI_RE/SOC2_RE, and a request stating only "HIPAA compliant" with no other health-related word still
// needs industry_domain="healthcare" for scoreCriticality's domain bonus (HIPAA implies healthcare by
// definition) — see mockExtractEnterpriseContext's industry_domain branch below.
const HEALTHCARE_RE = /\b(healthcare|medical|patient|hipaa)\b/i;

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
