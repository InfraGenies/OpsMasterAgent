# Ops Master Agent — Demo Use Cases (7 Scenarios)

All repos verified live on GitHub (July 2026). Each scenario exercises a *different* part of the agent pipeline, so together they prove the platform generalises beyond one hard-coded demo.

Recommended demo order for judges: **UC-2 → UC-1 → UC-7 → UC-8** (simple → flagship → modify → responsible-AI refusal). UC-3/4/5/6 are backup variety.

---

## UC-1 — FLAGSHIP: Node.js API + PostgreSQL @ 500 req/s (staging)

| | |
|---|---|
| **Repo** | https://github.com/gothinkster/node-express-realworld-example-app |
| **Stack** | Node.js + Express + Prisma + PostgreSQL (RealWorld "Conduit" API) |
| **NL request** | *"Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second."* |
| **Deploy target** | docker-compose (app container + postgres container + volume) |
| **What it proves** | The exact sentence from the problem statement, end-to-end: capacity plan → compose file → approve → up → k6 smoke @ 500 rps → green report |
| **Verify** | `GET /api/tags` health, k6: 500 rps for 30s, p95 < 300ms, error rate < 1% |

**Why this repo:** RealWorld apps are a known-good reference API (real routes, real DB schema, seed data) — far more credible than a hello-world, but still comes up in <60s.

---

## UC-2 — SIMPLE: Single-container dev environment (warm-up / smoke path)

| | |
|---|---|
| **Repo** | https://github.com/docker/getting-started-app |
| **Stack** | Node.js todo app (official Docker sample, no external DB) |
| **NL request** | *"Spin up a dev environment for a simple Node.js todo app, low traffic, single instance."* |
| **Deploy target** | docker-compose (1 service) |
| **What it proves** | Fastest happy path (~45s). Use this to open the demo and to sanity-test the pipeline every morning |
| **Verify** | `GET /` returns 200, k6: 20 rps for 15s |

---

## UC-3 — MULTI-SERVICE: 5-container microservices app

| | |
|---|---|
| **Repo** | https://github.com/dockersamples/example-voting-app |
| **Stack** | Python (vote) + Redis + .NET (worker) + PostgreSQL + Node.js (results) |
| **NL request** | *"Provision a QA environment for a voting application with a vote frontend, results dashboard, Redis queue and Postgres, expecting 200 concurrent voters."* |
| **Deploy target** | docker-compose (5 services, 2 networks) |
| **What it proves** | Planner handles service dependency ordering, per-service sizing, and inter-service networking — not just one container |
| **Verify** | Health on ports 8080 (vote) & 8081 (results); k6 posts votes, then asserts results page reflects them (functional smoke, not just uptime) |

---

## UC-4 — SCALE-OUT: Load-balanced Node.js + Redis

| | |
|---|---|
| **Repo** | https://github.com/docker/awesome-compose (folder: `nginx-nodejs-redis`) |
| **Stack** | Nginx LB → N × Node.js replicas → Redis |
| **NL request** | *"I need a load-balanced Node.js web tier with Redis, 3 replicas behind Nginx, for performance testing."* |
| **Deploy target** | docker-compose with `deploy.replicas: 3` |
| **What it proves** | Planner reasons about **replicas + load balancing**, verify agent proves round-robin (response returns container hostname — visibly different per request) |
| **Verify** | k6 hits Nginx, assert ≥3 distinct upstream hostnames observed + p95 threshold |

---

## UC-5 — DIFFERENT RUNTIME: Java Spring Boot + MySQL

| | |
|---|---|
| **Repo** | https://github.com/spring-projects/spring-petclinic |
| **Stack** | Spring Boot (JVM) + MySQL |
| **NL request** | *"Set up a test environment for a Java Spring Boot application with MySQL, ~50 users."* |
| **Deploy target** | docker-compose (petclinic image + mysql) |
| **What it proves** | Capacity planner isn't Node-only: it must reason about **JVM heap sizing** (`-Xmx`, container memory ≥ 1 GB vs 256 MB for Node) — a great "the AI actually understands runtimes" judge moment |
| **Verify** | `GET /actuator/health` (Spring gives structured health for free), k6: 50 rps |
| **Note** | JVM build/start is slower — pre-pull the image; use only if demo time allows |

---

## UC-6 — KUBERNETES (STRETCH): 11-service Online Boutique on Minikube

| | |
|---|---|
| **Repo** | https://github.com/GoogleCloudPlatform/microservices-demo |
| **Stack** | 11 microservices (Go/Java/Node/Python/C#) + Redis, official K8s manifests |
| **NL request** | *"Deploy the Online Boutique storefront to a Kubernetes staging cluster with autoscaling on the frontend."* |
| **Deploy target** | Minikube (agent generates/patches K8s manifests + HPA) |
| **What it proves** | IaC agent emits Kubernetes YAML, not just compose → shows the platform is target-agnostic. **Only attempt after UC-1–4 are rock solid** (needs 8 GB+ free RAM) |
| **Verify** | `kubectl rollout status` per deployment + frontend HTTP check |

---

## UC-7 — MODIFY, NOT CREATE: Add Redis cache to a running environment

| | |
|---|---|
| **Repo** | (extends UC-1 — no new repo) |
| **NL request** | *"Add a Redis cache to the staging environment we just created and wire the app to it."* |
| **Deploy target** | docker-compose (diff/patch of the UC-1 compose file) |
| **What it proves** | The agent reads **current state** from its own audit/state store, plans a *delta* (add service + env var, keep data volume), and shows a diff for approval — lifecycle management, not one-shot provisioning. This is the differentiator most teams won't have |
| **Verify** | Redis PING + app health unchanged + existing Postgres data intact |

---

## UC-8 — RESPONSIBLE-AI DEMO: Refusal + rollback (no repo)

Two short failure scenarios — judges score governance heavily:

1. **Refusal with reasoning:** *"Provision production with 50,000 req/s and five-nines availability."* → Planner responds: infeasible on local sandbox, explains why, proposes a scaled-down alternative, **nothing is deployed**.
2. **Auto-rollback:** Deploy a deliberately broken variant (wrong DB password in a prepared request) → verify agent goes red → deploy agent rolls back → audit trail shows the full sequence.

---

## UC-9 — TARGET STATE: AWS/Terraform multi-tier costing — retail-store-sample-app

| | |
|---|---|
| **Repo** | https://github.com/aws-containers/retail-store-sample-app |
| **Stack** | 5 microservices — UI (Java), Catalog (Go + MySQL/RDS), Cart (Java + DynamoDB), Orders (Java + MySQL/RDS), Checkout (Node.js + Redis/ElastiCache) — AWS's own reference retail app, built specifically to demo ECS/EKS/App Runner deployment via its bundled `terraform/eks/default`, `terraform/eks/minimal`, `terraform/ecs/default`, and `terraform/apprunner` modules |
| **NL request** | *"Deploy the retail-store-sample-app to AWS for a staging environment — give me a cost-conscious option and a highly-available option, with pricing for each."* |
| **Deploy target** | Terraform → AWS (ECS Fargate for the economy tier, EKS for the HA tier) |
| **What it proves** | The planner reasoning about **real managed-service substitution** (containerized DB vs. RDS/DynamoDB/ElastiCache), producing genuinely different topologies per cost tier (not just replica-count scaling), and rendering **Terraform**, not compose — the first use case that exercises `IaCPayload.format: "terraform"` end-to-end |
| **Verify** | `terraform plan` clean (no live `apply` in the sandbox demo — cost and blast radius are real on AWS, unlike every other UC); health checks + smoke test against the ALB/ingress endpoint if actually applied in a scratch AWS account |

**Status: not runnable today.** This is a deliberately forward-looking use case — it names the two gaps that block it rather than pretending they're already closed:

1. **No multi-tier `CapacityPlanOption[]` output.** The planner today emits exactly one `CapacityPlan`. This UC is the worked example for the multi-tier planning proposal
   (`source_configuration/ops-master-agent-enhancements-proposal.md` §2) — see the two tiers below.
2. **No AWS/Terraform template family.** `templates/catalog.ts` only renders `compose-*` templates today; `IaCPayload.format` already allows `"terraform"` in the contract (`CONTRACTS.md` §3), but nothing implements it. Building this UC for real means adding `tf-ecs-fargate-v1` / `tf-eks-v1` template definitions that fill the repo's own bundled Terraform modules rather than hand-rolling AWS resources from scratch — same "LLM picks a template, backend renders" discipline as compose, extended to a second `format`.

**Worked example — the two costing tiers a multi-tier planner should produce for this request:**

| | **Tier X — Economy** (`estimated_cost_usd_monthly: ~150`) | **Tier Y — High-Availability** (`estimated_cost_usd_monthly: ~430`) |
|---|---|---|
| Compute | ECS Fargate, 1 task per service (5 services), 0.25 vCPU / 0.5 GB each, single AZ | EKS (managed control plane) + 3× `t3.medium` worker nodes across 2 AZs, 2–3 pod replicas per service |
| Catalog / Orders data | 1× RDS `db.t3.micro` MySQL per service, single-AZ | 1× RDS `db.t3.small` MySQL per service, **Multi-AZ** failover |
| Cart data | DynamoDB, on-demand capacity | DynamoDB, on-demand + auto-scaling headroom |
| Checkout data | ElastiCache Redis `cache.t3.micro`, single node | ElastiCache Redis `cache.t3.small`, 2-node replication group |
| Networking | 1× ALB, 1× NAT Gateway | 1× ALB, 2× NAT Gateway (multi-AZ egress) |
| Availability notes | No failover on compute or DB; fine for a demo/staging env that can tolerate a restart | Survives an AZ outage on every tier — DB, cache, and compute all have a standby |
| **Reasoning (planner-shown)** | "Staging traffic is low and this is cost-sensitive — one Fargate task per service and single-AZ managed data stores minimize spend; acceptable because staging has no uptime SLA." | "If this needs to survive an AZ failure (a prod-adjacent staging or pre-prod gate), EKS + Multi-AZ RDS + replicated ElastiCache costs ~2.9× more but removes every single point of failure." |

Figures are illustrative — rough, on-demand `us-east-1`-shaped estimates from public AWS pricing patterns (Fargate ~$0.04048/vCPU-hr + ~$0.004445/GB-hr, RDS/ElastiCache instance-hour pricing, EKS control plane at $0.10/hr, NAT Gateway ~$0.045/hr + data processing), **not** a live pricing API call — exactly the "local rate table now, Infracost/AWS Price List API later" scoping already called out in the enhancements proposal §2.

---

## Selection summary

| UC | Scenario axis | Effort | Demo value |
|----|---|---|---|
| 1 | Flagship Node+Postgres @ 500 rps | Medium | ★★★★★ |
| 2 | Simplest happy path | Low | ★★★ (opener) |
| 3 | Multi-service dependencies | Medium | ★★★★ |
| 4 | Replicas + load balancing | Medium | ★★★★ |
| 5 | JVM runtime sizing | Medium | ★★★ |
| 6 | Kubernetes target | High | ★★★★ (stretch only) |
| 7 | Modify existing env | Medium | ★★★★★ |
| 8 | Refusal + rollback | Low | ★★★★★ |
| 9 | AWS/Terraform multi-tier costing (target state) | High | ★★★★★ (once §2 + a Terraform template family exist) |

Minimum viable demo set: **UC-1, UC-2, UC-7, UC-8** (one repo family + governance story). Add UC-3/4 for variety, UC-5/6 if ahead of schedule. UC-9 is the roadmap use case for the multi-tier capacity planning + Terraform work — not part of the current runnable demo set.
