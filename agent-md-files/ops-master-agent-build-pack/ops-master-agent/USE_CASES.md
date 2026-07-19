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

Minimum viable demo set: **UC-1, UC-2, UC-7, UC-8** (one repo family + governance story). Add UC-3/4 for variety, UC-5/6 if ahead of schedule.
