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

## UC-2 — SIMPLE: RealWorld fullstack dev environment (warm-up / smoke path)

| | |
|---|---|
| **Repo** | https://github.com/gothinkster/node-express-realworld-example-app + https://github.com/gothinkster/react-redux-realworld-example-app (paired backend + frontend, same "Conduit" build-sentinel pair as UC-1) |
| **Stack** | Node.js + Express + Prisma + PostgreSQL backend, React/Redux/CRA frontend served by nginx (real browser-rendered login page) |
| **NL request** | *"Spin up a dev environment for a simple Node.js todo app, low traffic, single instance."* |
| **Deploy target** | docker-compose (postgres + backend + frontend, 3 services) |
| **What it proves** | Any generic "no repo, no named app" Node.js request gets a genuinely real, running fullstack app instead of a throwaway placeholder — not just a health-check-passing container |
| **Verify** | Backend `GET /api/tags` health; frontend `GET /` health (real Conduit login page, not a docker onboarding page) |

**Note:** this scenario used to deploy `docker/getting-started-app` (a single throwaway placeholder
container) as a fast warm-up path. It now reuses UC-1's exact build-sentinel pair by default for any
generic Node.js request with no repo/app named — no separate "simple" topology exists anymore, but the
NL request and demo purpose (fastest sanity-check path) are unchanged.

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

## UC-9 — AWS/Terraform multi-tier costing — retail-store-sample-app

| | |
|---|---|
| **Repo** | https://github.com/aws-containers/retail-store-sample-app |
| **Stack** | 5 microservices — UI (Java), Catalog (Go + MySQL/RDS), Cart (Java + DynamoDB), Orders (Java + MySQL/RDS), Checkout (Node.js + Redis/ElastiCache) — AWS's own reference retail app, built specifically to demo ECS/EKS/App Runner deployment via its bundled `terraform/eks/default`, `terraform/eks/minimal`, `terraform/ecs/default`, and `terraform/apprunner` modules |
| **NL request** | *"Deploy the retail-store-sample-app to AWS for a staging environment — give me a cost-conscious option and a highly-available option, with pricing for each."* |
| **Deploy target** | Terraform → AWS (ECS Fargate for the economy tier, EKS for the HA tier) |
| **What it proves** | The planner reasoning about **real managed-service substitution** (containerized DB vs. RDS/DynamoDB/ElastiCache), producing genuinely different topologies per cost tier (not just replica-count scaling), and rendering **Terraform**, not compose — the first use case that exercises `IaCPayload.format: "terraform"` end-to-end |
| **Verify** | `terraform plan` clean (no live `apply` in the sandbox demo — cost and blast radius are real on AWS, unlike every other UC); health checks + smoke test against the ALB/ingress endpoint if actually applied in a scratch AWS account |

**Status: runnable.** Both gaps that used to block this UC are closed:

1. **Multi-tier `CapacityPlanOption[]` output** — `nodes/planner.ts` now emits `{ options: CapacityPlanOption[], recommended_tier, ... }` instead of a single flat plan, per the multi-tier planning proposal (`source_configuration/ops-master-agent-enhancements-proposal.md` §2). Every non-AWS UC gets 3 tiers (economy/balanced/high_availability); an `aws`-target request like this one gets exactly the 2 tiers below.
2. **AWS/Terraform template family** — `templates/terraformCatalog.ts` adds `tf-ecs-fargate-v1` (economy) and `tf-eks-v1` (high_availability), each rendering a root module that fills the repo's own bundled `terraform/ecs/default` / `terraform/eks/default` modules (real input variable names, fetched from the live repo) rather than hand-rolling AWS resources — same "LLM picks a template, backend renders" discipline as compose, extended to `IaCPayload.format: "terraform"`.

**Hard safety boundary:** `commandAllowList.ts` permits `terraform init`/`validate`/`plan` only — `apply`/`destroy` are not in the allow-list at all, so there is no code path from this UC to a real AWS account. "Deploy" always resolves to a plan-only outcome (labeled `SIMULATED` whenever the `terraform` CLI, network access, or AWS credentials aren't available — none of which this app configures by default), matching the existing no-docker `SIMULATED` pattern for the compose path.

**Worked example — the two costing tiers the multi-tier planner produces for this request (confirmed live, real Anthropic LLM: $141/mo economy, $428/mo high_availability):**

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

## UC-13 — SCOPING NARRATIVE: 3-developer startup (included/skipped/task_graph/turnaround)

*(Numbered 13, not 10 — UC-10/11a/11b/12 already exist in `apps/server/src/smoke.ts` as Enterprise
Architecture Advisor scenarios, ahead of where this doc's numbering had gotten to; this avoids colliding
with them.)*

| | |
|---|---|
| **Origin** | Inspired by a captured run of a separate, standalone Python prototype (`source_configuration/otherr-config/`) that produces a single flat plan with a scoping narrative and a manual-vs-agent turnaround estimate; this UC reproduces the same idea against this codebase's real multi-tier contract instead of that prototype's single-plan/EKS shape. |
| **NL request** | *"We're a 3-developer startup team building a Node.js API with PostgreSQL and Redis for early customers, light traffic for now."* |
| **Deploy target** | docker-compose |
| **What it proves** | `CapacityPlanOption.included_components` / `skipped_components` / `task_graph` / `manual_estimate_person_days` / `agent_estimate_minutes` — the "what's in scope and why, and what would this cost a human team" narrative — populated per tier, not just services/cost. Also shows the existing RealWorld-fullstack-default rule (`sizing-workloads.md`) firing alongside genuine dependency-driven sizing (postgres + redis both explicitly requested): the "3 services" framing becomes 4 real services (`app`, `db`, `cache`, `web`) because the flagship reference pair always ships frontend + backend together. |
| **Verify** | `docker compose config -q` clean; confirmed live in mock mode (`MOCK_LLM` auto-on, no API key) — see the exact captured planner output below. |

**Worked example (confirmed live, mock planner — economy tier, the `recommended_tier` for this `dev` request):**

| Field | Value |
|---|---|
| Services | `app` (RealWorld Node/Express, 1 replica), `db` (Postgres, 1Gi volume), `cache` (Redis, 256Mi), `web` (RealWorld React frontend) |
| `estimated_cost_usd_monthly` | $88 (`cost_basis: "rate_table"`) |
| `included_components` | app — primary application service; db — data dependency required by the request; cache — data dependency required by the request; web — browser-facing frontend paired with the app backend |
| `skipped_components` | "Extra replica / multi-AZ redundancy" — cost-sensitive economy tier; "Database Multi-AZ replication" — sandbox can't replicate stateful services locally |
| `task_graph` | 6 steps: render compose definitions for app/db/cache/web, provision volume `dbdata`, validate compose config |
| `manual_estimate_person_days` | 2.5 |
| `agent_estimate_minutes` | 22 |

The `balanced` tier renders identically (0 rps stated → sizing floors out at 1 replica either way; `noteConvergedTiers` appends the "balanced offers no improvement over economy" sentence to its reasoning, same convergence behavior every other UC's tiers already show at low load). The `high_availability` tier adds a 2nd `app` replica + an nginx load-balancer task-graph step (7 steps total), costs $119/mo, and its `manual_estimate_person_days` rises to 3.5 (per the sizing-workloads.md formula: +1 day for the high_availability tier).

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
| 9 | AWS/Terraform multi-tier costing | High | ★★★★★ (runnable — plan-only, never applies to a real account) |
| 13 | Scoping narrative + turnaround estimate | Low | ★★★★ (shows the "why" and the ROI pitch, not just services/cost) |

Minimum viable demo set: **UC-1, UC-2, UC-7, UC-8** (one repo family + governance story). Add UC-3/4 for variety, UC-5/6 if ahead of schedule, UC-9 to show the multi-tier capacity planning + Terraform/AWS path (plan-only, never applies to a real account), UC-13 to show the included/skipped/task_graph/turnaround scoping narrative.
