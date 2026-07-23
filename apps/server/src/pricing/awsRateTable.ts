/**
 * Illustrative us-east-1-shaped AWS rates for the UC-9 worked example
 * (agent-md-files/USE_CASES.md) — NOT a live pricing API call, same
 * "local rate table now, real API later" scoping as pricing/rateTable.ts.
 * Figures are the ones already published in USE_CASES.md so the planner's
 * output lands close to that worked example.
 */
const FARGATE_USD_PER_VCPU_HOUR = 0.04048;
const FARGATE_USD_PER_GIB_HOUR = 0.004445;
const RDS_T3_MICRO_USD_PER_HOUR = 0.017;
const RDS_T3_SMALL_USD_PER_HOUR = 0.034;
const ELASTICACHE_T3_MICRO_USD_PER_HOUR = 0.017;
const ELASTICACHE_T3_SMALL_USD_PER_HOUR = 0.034;
const DYNAMODB_ON_DEMAND_USD_MONTHLY_BASELINE = 5; // light on-demand usage baseline for a demo-scale table
const EKS_CONTROL_PLANE_USD_PER_HOUR = 0.1;
const EKS_NODE_T3_MEDIUM_USD_PER_HOUR = 0.0416;
const NAT_GATEWAY_USD_PER_HOUR = 0.045;
const HOURS_PER_MONTH = 730;

export interface AwsFargateService {
  vcpu: number;
  gib: number;
  taskCount: number;
}

export interface CostEstimate {
  totalUsdMonthly: number;
  breakdown: { label: string; usd_monthly: number }[];
}

/** Rounds a line item the same way the total is rounded, so displayed parts always sum to the displayed total. */
function roundedBreakdown(parts: { label: string; usd: number }[]): CostEstimate {
  const breakdown = parts.map((p) => ({ label: p.label, usd_monthly: Math.round(p.usd) }));
  return { totalUsdMonthly: breakdown.reduce((sum, p) => sum + p.usd_monthly, 0), breakdown };
}

export function estimateEcsFargateMonthlyCost(services: AwsFargateService[], natGateways: number): CostEstimate {
  const computeUsd = services.reduce(
    (sum, s) => sum + (s.vcpu * FARGATE_USD_PER_VCPU_HOUR + s.gib * FARGATE_USD_PER_GIB_HOUR) * s.taskCount * HOURS_PER_MONTH,
    0
  );
  const rdsUsd = 2 * RDS_T3_MICRO_USD_PER_HOUR * HOURS_PER_MONTH; // catalog + orders, single-AZ
  const dynamoUsd = DYNAMODB_ON_DEMAND_USD_MONTHLY_BASELINE; // cart, on-demand
  const cacheUsd = ELASTICACHE_T3_MICRO_USD_PER_HOUR * HOURS_PER_MONTH; // checkout, single node
  const natUsd = natGateways * NAT_GATEWAY_USD_PER_HOUR * HOURS_PER_MONTH;
  return roundedBreakdown([
    { label: "Compute (ECS Fargate, 5 services)", usd: computeUsd },
    { label: "RDS (catalog + orders, single-AZ)", usd: rdsUsd },
    { label: "DynamoDB (cart, on-demand)", usd: dynamoUsd },
    { label: "ElastiCache (checkout, single node)", usd: cacheUsd },
    { label: `NAT Gateway (${natGateways})`, usd: natUsd },
  ]);
}

/**
 * Illustrative flat monthly rates for the Enterprise Architecture Advisor's
 * managed controls (nodes/enterpriseRulesEngine.ts) — same "local rate table,
 * not a live pricing API" scoping as the rest of this file. Organizations,
 * Control Tower, and IAM Identity Center are real AWS control-plane services
 * with no incremental charge, so they're deliberately $0, not omitted.
 */
const MANAGED_CONTROL_USD_MONTHLY: Record<string, number> = {
  "AWS WAF": 15,
  "AWS Shield Advanced": 3000,
  "Amazon GuardDuty": 50,
  "AWS Security Hub": 30,
  "AWS Config": 40,
  "AWS CloudTrail": 20,
  "AWS Secrets Manager": 5,
  "AWS KMS": 3,
  "Amazon Route 53 (health-check failover)": 1.5,
  // Cost of the cross-region secondary specifically — the primary cluster's
  // own cost is priced separately via estimatePrimaryDatabaseMonthlyCost,
  // same as a normal RDS Multi-AZ standby isn't folded into this line either.
  "Aurora Global Database": 600,
  "Amazon OpenSearch Service": 65,
  "Amazon SQS": 10,
  "Amazon EventBridge": 5,
  "AWS Backup": 20,
  "AWS Transit Gateway": 40,
  "AWS Organizations": 0,
  "AWS Control Tower": 0,
  "AWS IAM Identity Center": 0,
};

/** Looks up each control's illustrative flat monthly rate; unrecognized names cost $0 rather than throwing, so a new control can be added to the rules engine before its rate is tabulated here. */
export function estimateManagedControlsMonthlyCost(controlNames: string[]): CostEstimate {
  return roundedBreakdown(
    controlNames.map((name) => ({ label: name, usd: MANAGED_CONTROL_USD_MONTHLY[name] ?? 0 }))
  );
}

/**
 * Primary managed-database cost for the Enterprise Architecture Advisor
 * (nodes/enterpriseRulesEngine.ts): every real business workload needs one,
 * regardless of criticality band, so this was previously missing entirely
 * from buildEnterpriseOptions's cost estimate — only the very_high band's
 * Aurora Global Database *cross-region replica* add-on was ever priced, with
 * no primary cluster underneath it. Sized by band, same low/medium
 * single-AZ vs. high/very_high Multi-AZ split every other tier in this
 * codebase already uses (see AVAILABILITY_NOTES_BY_BAND).
 */
export function estimatePrimaryDatabaseMonthlyCost(band: "low" | "medium" | "high" | "very_high"): CostEstimate {
  const multiAz = band === "high" || band === "very_high";
  const hourlyRate = multiAz ? RDS_T3_SMALL_USD_PER_HOUR * 2 : RDS_T3_MICRO_USD_PER_HOUR;
  const label = multiAz ? "RDS/Aurora-compatible primary (Multi-AZ)" : "RDS/Aurora-compatible primary (single-AZ)";
  return roundedBreakdown([{ label, usd: hourlyRate * HOURS_PER_MONTH }]);
}

/**
 * Baseline networking for the Enterprise Architecture Advisor — a NAT
 * Gateway per AZ the archetype spans, same reasoning UC-9's economy/HA
 * tiers already use ("1 NAT Gateway" vs. "2 NAT Gateways for multi-AZ
 * egress"). solo/team archetypes are single-AZ; scale_up/enterprise assume
 * 2 AZs for the landing-zone-grade baseline.
 */
export function estimateNetworkingMonthlyCost(archetype: string): CostEstimate {
  const natGateways = archetype === "scale_up_eks" || archetype === "enterprise_eks_landing_zone" ? 2 : 1;
  return roundedBreakdown([{ label: `NAT Gateway (${natGateways})`, usd: natGateways * NAT_GATEWAY_USD_PER_HOUR * HOURS_PER_MONTH }]);
}

export function estimateEksMonthlyCost(nodeCount: number, natGateways: number): CostEstimate {
  const controlPlaneUsd = EKS_CONTROL_PLANE_USD_PER_HOUR * HOURS_PER_MONTH;
  const nodesUsd = nodeCount * EKS_NODE_T3_MEDIUM_USD_PER_HOUR * HOURS_PER_MONTH;
  const rdsUsd = 2 * RDS_T3_SMALL_USD_PER_HOUR * HOURS_PER_MONTH; // catalog + orders, Multi-AZ (~2x single-AZ rate as a stand-in for the failover replica)
  const dynamoUsd = DYNAMODB_ON_DEMAND_USD_MONTHLY_BASELINE * 1.5; // + autoscaling headroom
  const cacheUsd = 2 * ELASTICACHE_T3_SMALL_USD_PER_HOUR * HOURS_PER_MONTH; // 2-node replication group
  const natUsd = natGateways * NAT_GATEWAY_USD_PER_HOUR * HOURS_PER_MONTH;
  return roundedBreakdown([
    { label: "EKS control plane", usd: controlPlaneUsd },
    { label: `Worker nodes (${nodeCount}x t3.medium)`, usd: nodesUsd },
    { label: "RDS (catalog + orders, Multi-AZ)", usd: rdsUsd },
    { label: "DynamoDB (cart, on-demand + headroom)", usd: dynamoUsd },
    { label: "ElastiCache (checkout, 2-node replica group)", usd: cacheUsd },
    { label: `NAT Gateway (${natGateways})`, usd: natUsd },
  ]);
}
