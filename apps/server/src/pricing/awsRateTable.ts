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

export function estimateEcsFargateMonthlyCost(services: AwsFargateService[], natGateways: number): number {
  const computeUsd = services.reduce(
    (sum, s) => sum + (s.vcpu * FARGATE_USD_PER_VCPU_HOUR + s.gib * FARGATE_USD_PER_GIB_HOUR) * s.taskCount * HOURS_PER_MONTH,
    0
  );
  const rdsUsd = 2 * RDS_T3_MICRO_USD_PER_HOUR * HOURS_PER_MONTH; // catalog + orders, single-AZ
  const dynamoUsd = DYNAMODB_ON_DEMAND_USD_MONTHLY_BASELINE; // cart, on-demand
  const cacheUsd = ELASTICACHE_T3_MICRO_USD_PER_HOUR * HOURS_PER_MONTH; // checkout, single node
  const natUsd = natGateways * NAT_GATEWAY_USD_PER_HOUR * HOURS_PER_MONTH;
  return Math.round(computeUsd + rdsUsd + dynamoUsd + cacheUsd + natUsd);
}

export function estimateEksMonthlyCost(nodeCount: number, natGateways: number): number {
  const controlPlaneUsd = EKS_CONTROL_PLANE_USD_PER_HOUR * HOURS_PER_MONTH;
  const nodesUsd = nodeCount * EKS_NODE_T3_MEDIUM_USD_PER_HOUR * HOURS_PER_MONTH;
  const rdsUsd = 2 * RDS_T3_SMALL_USD_PER_HOUR * HOURS_PER_MONTH; // catalog + orders, Multi-AZ (~2x single-AZ rate as a stand-in for the failover replica)
  const dynamoUsd = DYNAMODB_ON_DEMAND_USD_MONTHLY_BASELINE * 1.5; // + autoscaling headroom
  const cacheUsd = 2 * ELASTICACHE_T3_SMALL_USD_PER_HOUR * HOURS_PER_MONTH; // 2-node replication group
  const natUsd = natGateways * NAT_GATEWAY_USD_PER_HOUR * HOURS_PER_MONTH;
  return Math.round(controlPlaneUsd + nodesUsd + rdsUsd + dynamoUsd + cacheUsd + natUsd);
}
