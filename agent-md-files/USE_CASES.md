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

**Default safety boundary:** `commandAllowList.ts` permits `terraform init`/`validate`/`plan` unconditionally — `apply`/`destroy` only match when `ALLOW_AWS_APPLY=true` (off everywhere except an explicitly configured demo machine, see the root README's eleventh addition), so by default there is no code path from this UC to a real AWS account. "Deploy" resolves to a plan-only outcome (labeled `SIMULATED` whenever the `terraform` CLI, network access, or AWS credentials aren't available), matching the existing no-docker `SIMULATED` pattern for the compose path.

**Live-apply demo option:** with `ALLOW_AWS_APPLY=true` and AWS credentials configured (a named CLI profile via `AWS_PROFILE` is the recommended path — `aws configure --profile ...`), a human-approved plan is actually applied to a real AWS account, using the ECS Fargate economy tier (`tf-ecs-fargate-v1`) specifically — it stands up/tears down in minutes, unlike the EKS tier (~15–20 min each way). `verify` then health-checks the real endpoint from `terraform output` (no load test against it — unnecessary risk for a short live demo). Cost-safety: immediately after a successful apply, run the rendered `.\schedule-auto-destroy.ps1` (defaults to 10 min) so the environment is torn down even if the demo forgets to. A failed deploy/verify still triggers a real `terraform destroy` automatically via the normal rollback path.

**Full step-by-step worked example (captured `task_graph` for both tiers, pricing breakdown, wiki/slide-ready):** [`EXAMPLE-AWS-RETAIL-STORE.md`](EXAMPLE-AWS-RETAIL-STORE.md) (`request_id: req-2026-92a7ff79`).

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

## UC-14 — AWS LIVE-APPLY: single-container Fargate + ALB — aws-copilot-sample-service (fastest real-cloud demo)

| | |
|---|---|
| **Repo** | https://github.com/aws-samples/aws-copilot-sample-service (pinned commit `2f5a45e5561f0d99e4328eac02d93358d2489d63`) |
| **Maintainer** | AWS official (`aws-samples` org), MIT-0 license |
| **Stack** | Static nginx page (`public.ecr.aws/nginx/nginx:1.19` base image, `COPY index.html` only) — AWS's own reference app for its Copilot CLI "Load Balanced Web Service" tutorial. No database, no build tooling, no env vars — only 3 files in the whole repo (`Dockerfile`, `index.html`, `README.md`) |
| **NL request** | *"Deploy a simple static web service to AWS behind a load balancer for a demo environment."* |
| **Deploy target** | Terraform → AWS (ECS Fargate, single task, single AZ) + ALB — `IaCPayload.format: "terraform"`, same family as UC-9's economy tier |
| **What it proves** | The **fastest possible real-AWS path** through the pipeline: one container, no RDS/DynamoDB/ElastiCache, no application build step beyond `docker build` (the Dockerfile only copies a static file) — stands up and tears down in a couple of minutes, faster than either of UC-9's tiers (5 services + RDS for economy; ~15–20 min each way for the EKS tier). Also the first use case where the IaC agent would need to **hand-roll** VPC/ECS/ALB resources directly, because unlike `retail-store-sample-app` (UC-9) this repo ships no Terraform module of its own to wrap — `templates/terraformCatalog.ts`'s "LLM picks a template, backend renders" discipline has to generate the AWS resources itself instead of filling a bundled module |
| **Verify** | `curl -I <alb-dns-name>` → expect `HTTP/1.1 200 OK` on `/` |

**Why this repo (from the source review):** of the AWS sample apps considered, this is the only one that
is (a) AWS-maintained, (b) MIT-0 licensed with zero licensing ambiguity, (c) needs no build-tool dependency
beyond Docker itself, and (d) pulls its base image from `public.ecr.aws` instead of Docker Hub — removing
the Docker Hub anonymous-pull rate-limit as a class of demo-day flakiness. Full source review, two manual
provisioning paths (Copilot CLI vs. raw AWS CLI written to match UC-9's `tf-ecs-fargate-v1` conventions),
the `BUILD_REGISTRY` wiring, and the cost-safety auto-teardown script live in
[`source_configuration/new-use-case/03-fargate-demo-aws-copilot-sample-service.md`](../source_configuration/new-use-case/03-fargate-demo-aws-copilot-sample-service.md).

**Status: `BUILD_REGISTRY` wiring done; AWS/Terraform path still manual.** `apps/server/src/nodes/buildRegistry.ts`
now has an `"aws-copilot-sample"` entry (`pairedWith: null`, `needsDatabase: false`), which is enough for the
agent to clone/build/deploy this app through its normal **docker-compose** path (e.g. `compose-single-v1`) —
that gap from the original review is closed. One gap remains, and it's the one that actually matters for
this UC's "real AWS Fargate + ALB" framing:

1. **A new Terraform template** (e.g. `tf-ecs-fargate-single-v1` in `templates/terraformCatalog.ts`) that
   hand-rolls VPC/subnets/security group/ECS cluster/task definition/service/ALB for one image — unlike
   `retail-store-sample-app` (UC-9), this repo has no bundled Terraform module for a template to wrap. This
   is a materially bigger lift than the `BUILD_REGISTRY` entry (UC-9's own `tf-ecs-fargate-v1`/`tf-eks-v1`
   only had to *fill* an existing module, never author raw AWS resources from scratch).

Until that template exists, an actual Fargate+ALB endpoint for this app still comes from the manually-run
Copilot CLI or raw AWS CLI path (source file §2/§3) rather than an NL request the pipeline can
plan/generate/deploy end-to-end — those sections now include a scheduled, timeout-based auto-teardown step
(`schedule-ecs-auto-teardown.ps1`, same idea as UC-9's `schedule-auto-destroy.ps1` but for `aws ecs stop-task`
instead of `terraform destroy`, since this path never goes through Terraform) so a forgotten demo task
doesn't keep billing.

**Safety, same boundary as UC-9:** once the Terraform template exists, `commandAllowList.ts`'s `apply`/`destroy`
gating (`ALLOW_AWS_APPLY=true`, off by default) applies unchanged — `init`/`validate`/`plan` run
unconditionally, nothing touches a real AWS account by default.

---

## UC-15 — STATIC FRONTEND, DEV: Vite/React app with no backend or database

| | |
|---|---|
| **Repo** | https://github.com/mattburrell/vite-react-docker (pinned commit `5d96169e8712659f60fc47f671cc54f6c4fe9d47`) |
| **Maintainer** | Individual dev (Matt Burrell), MIT license |
| **Stack** | Vite + React, two-stage Dockerfile (Vite build in a `node:18-alpine3.17` stage, static `dist/` served by `nginx` on an `ubuntu` runtime stage) — no backend calls, no env vars, no database |
| **NL request** | *"Spin up a dev environment for a static React frontend, no backend needed."* |
| **Deploy target** | docker-compose (`compose-single-v1`) — a `BUILD_REGISTRY` build-sentinel service, not an off-the-shelf image |
| **What it proves** | The build-sentinel path (previously only exercised by the RealWorld pair, UC-1/UC-2) generalizes to a **standalone** app with no db and no host-side build steps — the whole build happens inside the repo's own Dockerfile. First real exercise of `iac_generator.ts`'s standalone build-sentinel branch (`needsDatabase: false`, `pairedWith: null`) |
| **Verify** | `GET http://localhost:<host_port>/` = 200 (static `index.html`) |

**Status: wired into `buildRegistry.ts` (`"vite-react-frontend"` entry).** Full source review and the
optional real-AWS-CLI manual path live in
[`source_configuration/new-use-case/01-fargate-demo-vite-react-docker.md`](../source_configuration/new-use-case/01-fargate-demo-vite-react-docker.md)
— its `run-task` step now arms a 15-minute auto-teardown automatically (`schedule-ecs-auto-teardown.ps1`,
no separate step to remember), cancelable if you want the demo to run longer.

---

## UC-16 — LIVE HOSTNAME DEMO: nginx-hello (visible proof of a live, non-cached container)

| | |
|---|---|
| **Repo** | https://github.com/nginxinc/NGINX-Demos, subfolder `nginx-hello` (pinned commit `611fa05748a4031841e5607cd3069288b0aa9973`) |
| **Maintainer** | NGINX Inc. — no `LICENSE` file in the repo (low-risk here since nothing is redistributed, only built for an internal demo) |
| **Stack** | `nginx:mainline-alpine` + `sub_filter`-injected page showing the container's live hostname, address, request URI, timestamp, and per-request ID |
| **NL request** | *"Give me a quick live demo endpoint that visibly proves it's a real running container, not a cached page."* |
| **Deploy target** | docker-compose (`compose-single-v1`) — a `BUILD_REGISTRY` build-sentinel service |
| **What it proves** | The build-sentinel path handles a repo whose **Dockerfile isn't at the repo root** — `nginx-hello/Dockerfile` inside the `NGINX-Demos` monorepo checkout. New `BuildRegistryEntry.dockerfileSubdir` field + `build.ts`'s `isKnownCwd()` support for it generalize the pipeline beyond "every registry entry is a root-level Dockerfile," a real constraint hit while wiring this app in |
| **Verify** | `curl http://localhost:<host_port>/` = 200, body shows a live hostname/IP/request-id — good demo moment (visible proof, not just a status code) |

**Status: wired into `buildRegistry.ts` (`"nginx-hello"` entry, `dockerfileSubdir: "nginx-hello"`).** Full
source review and the optional real-AWS-CLI manual path live in
[`source_configuration/new-use-case/02-fargate-demo-nginx-hello.md`](../source_configuration/new-use-case/02-fargate-demo-nginx-hello.md)
— its `run-task` step now arms a 15-minute auto-teardown automatically (`schedule-ecs-auto-teardown.ps1`,
no separate step to remember), cancelable if you want the demo to run longer.

---

## Self-hosting — deploying the Ops Master Agent platform itself to AWS

*Different in kind from UC-1..UC-13 above: those are natural-language requests a user types into the*
*running app, which the pipeline then plans/generates IaC for. This entry instead documents how the*
*app itself is hosted — there is no NL request or planner/iac_generator run involved.*

| | |
|---|---|
| **What** | Ops Master Agent (Express + WebSocket API, React UI, Supabase-backed audit store) running on AWS ECS Fargate behind an ALB, built and deployed by GitHub Actions on every push to `main` |
| **Where** | `infra/aws/` (Terraform: ECR, ALB, ECS cluster/task/service, IAM roles, Secrets Manager, GitHub OIDC deploy role), `Dockerfile` (multi-stage build), `.github/workflows/{ci,deploy}.yml` |
| **Why it's separate from `templates/terraformCatalog.ts`** | `tf-ecs-fargate-v1` there is IaC *the product generates for an end user's request* (fills the retail-store-sample-app's own bundled Terraform module, per UC-9). `infra/aws/` is hand-authored IaC for hosting the *product itself* — conflating the two would mean editing the customer-facing template catalogue every time the platform's own hosting needs changed, and vice versa |
| **Architecture** | One Fargate task (0.5 vCPU/1GB) runs a single container serving both the API/WebSocket and the built React static files (one origin, no CORS) — see the root `README.md`'s "Deploying to AWS" section for the full diagram |
| **Cost** | ~$41-45/mo always-on (`us-east-1`); `desired_count=0` between demos drops it to ~$20/mo (ALB only), `terraform destroy` drops it to $0 |
| **Credentials** | GitHub authenticates to AWS via OIDC (no stored AWS keys in GitHub); `ANTHROPIC_API_KEY`/Bedrock token/Supabase service-role key live in AWS Secrets Manager, injected into the ECS task as `secrets`, never in the image |
| **Safety** | `ALLOW_AWS_APPLY` is hardcoded `false` on the hosted task — it can never `terraform apply`/`destroy` against the AWS account it runs in. The docker-compose deploy track (most UCs above) auto-simulates on this instance since Fargate has no Docker daemon — `MOCK_DEPLOY=auto` already handles that, identical to a judge's laptop without Docker Desktop |

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
| 14 | AWS single container + ALB (aws-copilot-sample) | Medium | ★★★★ (`BUILD_REGISTRY` wired; real AWS Fargate+ALB still a manual CLI path pending a hand-rolled Terraform template) |
| 15 | Static frontend, no backend/DB (vite-react-docker) | Low | ★★★ (proves the build-sentinel path generalizes beyond RealWorld — runnable via docker-compose) |
| 16 | Live hostname demo, subfolder Dockerfile (nginx-hello) | Low | ★★★ (visible live-container proof; runnable via docker-compose) |

Minimum viable demo set: **UC-1, UC-2, UC-7, UC-8** (one repo family + governance story). Add UC-3/4 for variety, UC-5/6 if ahead of schedule, UC-9 to show the multi-tier capacity planning + Terraform/AWS path (plan-only, never applies to a real account), UC-13 to show the included/skipped/task_graph/turnaround scoping narrative, UC-15/UC-16 as low-effort docker-compose variety (both runnable today), UC-14 for a real-AWS Fargate+ALB deploy once its Terraform template lands (today it's `BUILD_REGISTRY`-wired for compose but still a manual CLI path for actual AWS).
