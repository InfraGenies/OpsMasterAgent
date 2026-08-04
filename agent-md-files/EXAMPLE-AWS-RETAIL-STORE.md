# Worked Example — AWS Deployment: retail-store-sample-app

A fully worked, step-by-step capture of one real run through the pipeline, kept separate from
[`USE_CASES.md`](USE_CASES.md) so it can be linked directly from a wiki page or dropped into a slide without
pulling in the rest of the use-case catalogue. This is the detailed backing evidence for **UC-9** — read
that entry first for why this scenario exists (multi-tier `CapacityPlanOption[]`, `IaCPayload.format:
"terraform"`, real managed-service substitution).

**How to reference this doc:** link the whole page from a wiki "AWS deployment example" section, or lift
individual tables (provisioning steps, pricing) straight onto a slide — each section below is self-contained,
same convention as [`PRESENTATION.md`](PRESENTATION.md).

---

## Request

| Field | Value |
|---|---|
| `request_id` | `req-2026-92a7ff79` |
| `operation` | `create` |
| `environment` | `staging` |
| `repo_url` | https://github.com/aws-containers/retail-store-sample-app |
| `constraints.target` | `aws` |
| **NL request** | *"Deploy the retail-store-sample-app to AWS for a staging environment — give me a cost-conscious option and a highly-available option, with pricing for each."* |

An `aws`-target request produces exactly **two** `CapacityPlanOption`s (not the usual three) — `economy` and
`high_availability` — per `CONTRACTS.md`'s `CapacityPlan` shape. Both render `IaCPayload.format: "terraform"`
against the repo's own bundled Terraform modules (`terraform/ecs/default` for economy, `terraform/eks/default`
for high-availability) — see `templates/terraformCatalog.ts`.

---

## Tier comparison

| | **Economy** (cost-conscious) | **High-Availability** |
|---|---|---|
| Compute | ECS Fargate, 1 task per service (5 services), 0.25 vCPU / 0.5 GB each, single AZ | EKS (managed control plane) + 3× `t3.medium` worker nodes across 2 AZs, 2–3 pod replicas per service |
| Catalog / Orders data | 1× RDS `db.t3.micro` MySQL per service, single-AZ | 1× RDS `db.t3.small` MySQL per service, **Multi-AZ** failover |
| Cart data | DynamoDB, on-demand capacity | DynamoDB, on-demand + auto-scaling headroom |
| Checkout data | ElastiCache Redis `cache.t3.micro`, single node | ElastiCache Redis `cache.t3.small`, 2-node replication group |
| Networking | 1× ALB, 1× NAT Gateway, single AZ | 1× ALB, 2× NAT Gateway (multi-AZ egress) |
| Availability notes | No failover on compute or DB; fine for a demo/staging env that can tolerate a restart | Survives an AZ outage on every tier — DB, cache, and compute all have a standby |
| **Estimated cost** | **~$141/mo** | **~$428/mo** |

**Reasoning shown to the approver:**
- *Economy:* "Staging traffic is low and this is cost-sensitive — one Fargate task per service and single-AZ
  managed data stores minimize spend; acceptable because staging has no uptime SLA."
- *High-availability:* "If this needs to survive an AZ failure (a prod-adjacent staging or pre-prod gate),
  EKS + Multi-AZ RDS + replicated ElastiCache costs ~2.9× more but removes every single point of failure."

---

## Provisioning steps — Economy tier (`task_graph`)

Captured from the actual planner output for `req-2026-92a7ff79`. Component IDs in parentheses match the
resource names used in the rendered Terraform (`tf-ecs-fargate-v1`) and the audit trail.

| Step | Task | Component |
|---|---|---|
| 1 | Provision VPC with public and private subnets (single AZ) | `networking` |
| 2 | Provision RDS MySQL instance for catalog-db (`db.t3.micro`, single-AZ) | `catalog-db` |
| 3 | Provision RDS MySQL instance for orders-db (`db.t3.micro`, single-AZ) | `orders-db` |
| 4 | Provision DynamoDB table for carts (on-demand) | `carts-dynamodb` |
| 5 | Provision ECS cluster and task definitions for all application services | `ecs-cluster` |
| 6 | Render ECS Fargate service for `ui` (1 replica) | `ui` |
| 7 | Render ECS Fargate service for `catalog` (1 replica) | `catalog` |
| 8 | Render ECS Fargate service for `cart` (1 replica) | `cart` |
| 9 | Render ECS Fargate service for `orders` (1 replica) | `orders` |
| 10 | Render ECS Fargate service for `checkout` (1 replica) | `checkout` |
| 11 | Configure Application Load Balancer with target groups and health checks | `alb` |
| 12 | Configure CloudWatch alarms and dashboards | `monitoring` |
| 13 | Validate all services healthy and responding to ALB health checks | `validation` |

---

## Provisioning steps — High-Availability tier (`task_graph`)

Derived analogously from the economy tier's captured run and the tier-comparison architecture above (not a
separate captured run) — the same 13-step shape, substituting the HA-tier resources: EKS instead of ECS,
Multi-AZ RDS, a 2-node ElastiCache replication group, and dual NAT Gateways.

| Step | Task | Component |
|---|---|---|
| 1 | Provision VPC with public and private subnets across **2 AZs** | `networking` |
| 2 | Provision RDS MySQL instance for catalog-db (`db.t3.small`, **Multi-AZ**) | `catalog-db` |
| 3 | Provision RDS MySQL instance for orders-db (`db.t3.small`, **Multi-AZ**) | `orders-db` |
| 4 | Provision DynamoDB table for carts (on-demand + auto-scaling headroom) | `carts-dynamodb` |
| 5 | Provision ElastiCache Redis replication group for checkout (`cache.t3.small`, 2-node) | `checkout-cache` |
| 6 | Provision EKS cluster (managed control plane) + 3× `t3.medium` worker nodes across 2 AZs | `eks-cluster` |
| 7 | Render EKS deployment + service for `ui` (2–3 replicas) | `ui` |
| 8 | Render EKS deployment + service for `catalog` (2–3 replicas) | `catalog` |
| 9 | Render EKS deployment + service for `cart` (2–3 replicas) | `cart` |
| 10 | Render EKS deployment + service for `orders` (2–3 replicas) | `orders` |
| 11 | Render EKS deployment + service for `checkout` (2–3 replicas) | `checkout` |
| 12 | Configure Application Load Balancer (ALB ingress controller) with target groups and health checks across 2× NAT Gateways | `alb` |
| 13 | Configure CloudWatch alarms and dashboards | `monitoring` |
| 14 | Validate all services healthy and responding to ALB health checks | `validation` |

---

## Pricing breakdown

Illustrative, rough, on-demand `us-east-1`-shaped estimates from public AWS pricing patterns — **not** a live
pricing API call (same "local rate table now, Infracost/AWS Price List API later" scoping as UC-9). Rate
basis: Fargate ~$0.04048/vCPU-hr + ~$0.004445/GB-hr, RDS/ElastiCache instance-hour pricing, EKS control plane
at $0.10/hr, NAT Gateway ~$0.045/hr + data processing.

| Line item | Economy | High-Availability |
|---|---|---|
| Compute (Fargate / EKS + nodes) | ~$45/mo (5 services × 0.25 vCPU/0.5 GB) | ~$164/mo (EKS control plane $73 + 3× `t3.medium` $91) |
| RDS (catalog-db + orders-db) | ~$25/mo (2× `db.t3.micro`, single-AZ) | ~$100/mo (2× `db.t3.small`, Multi-AZ) |
| DynamoDB (carts) | ~$10/mo (on-demand, staging traffic) | ~$15/mo (on-demand + headroom) |
| ElastiCache (checkout) | ~$12/mo (`cache.t3.micro`, single node) | ~$50/mo (`cache.t3.small`, 2-node replication) |
| ALB + NAT Gateway | ~$35/mo (1× ALB, 1× NAT) | ~$70/mo (1× ALB, 2× NAT, multi-AZ egress) |
| CloudWatch (alarms + dashboards) | ~$5/mo | ~$8/mo |
| **Total** | **~$141/mo** | **~$428/mo** |

---

## Safety notes (inherited from UC-9)

- `commandAllowList.ts` permits `terraform init`/`validate`/`plan` unconditionally; `apply`/`destroy` only
  run when `ALLOW_AWS_APPLY=true` (off by default everywhere except an explicitly configured demo machine).
  By default this scenario is **plan-only** — nothing is applied to a real AWS account.
- If actually applied (`ALLOW_AWS_APPLY=true` + AWS credentials configured), only the **economy** tier
  (`tf-ecs-fargate-v1`) is used for a live demo — it stands up/tears down in minutes, unlike the EKS tier
  (~15–20 min each way). Run `.\schedule-auto-destroy.ps1` immediately after a successful apply as a
  cost-safety net.

---

## Cross-references

- Full use-case catalogue entry: [`USE_CASES.md`](USE_CASES.md) — UC-9
- `CapacityPlanOption` / `task_graph` schema: [`CONTRACTS.md`](CONTRACTS.md) §2
- Slide-deck source (for pulling this example onto a slide): [`PRESENTATION.md`](PRESENTATION.md)
