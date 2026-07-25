# Skill — Sizing Workloads

Runtime copy of the fenced block in `agent-md-files/skills/sizing-workloads.md`. Edit that file to change
this skill's content — no code change needed, see `llm/skillLoader.ts`.

```text
Sizing rules (do not deviate — cite the rule you used in "reasoning"):
- Node.js/Express CRUD API: ~250 rps per instance sustained → replicas = ceil(rps/250), min 1, max 4.
  Memory 512Mi, CPU 1.0 per replica.
- Python/Flask or FastAPI sync: ~150 rps per instance → same formula. Memory 512Mi.
- JVM (Spring Boot): memory MINIMUM 1Gi per instance (heap + metaspace); set JAVA_OPTS -Xmx768m.
  ~200 rps per instance.
- PostgreSQL/MySQL: 1 instance, 1Gi memory, always a named volume for data. Never replicated in sandbox.
- Redis: 1 instance, 256Mi, no volume unless persistence requested.
- Nginx LB: add automatically when replicas > 1 for an HTTP service. 128Mi.
- Static site: nginx:alpine, 128Mi, 1 replica.
- Generic demo request with no repo/build given (e.g. "simple todo app", "hello world", UC-2-style
  warm-up): the app container must actually serve traffic on the stated port. A bare language runtime
  base image (node:*, python:*, etc.) has no server process and will fail its health check — use
  docker/welcome-to-docker instead (serves HTTP on port 80 out of the box). 128Mi, 1 replica floor.
- Node.js API + PostgreSQL request with no repo/build given (UC-1 flagship): same "no real app code"
  problem, but this scenario is meant to prove capacity planning against a credible reference API, not
  a placeholder. Set the app service's image to the literal sentinel "__BUILD__:realworld-node-express"
  (nothing else — never invent a different "__BUILD__:*" key, a real image, or a repo URL yourself; the
  backend resolves this one exact string to a real, pinned build). Do not use this for a request that
  already gives its own repo_url.

Tier rules:
- economy: headroom_pct=0, size to the exact stated load (replica floor 1, min 1 max 4).
- balanced: headroom_pct=0.2 → replicas = ceil(rps*1.2/per_instance); environment floor of 2
  replicas if environment is prod-like, else 1; min 1 max 4.
- high_availability: same as balanced, plus +1 replica on every stateless service (still max 4).
  Stateful services (db/cache) stay single-instance in this sandbox (can't be replicated here) —
  say so explicitly in availability_notes rather than implying real failover exists.
- An explicit replica count stated in the request (e.g. "3 replicas") is an instruction, not a
  sizing input — use it for every tier equally instead of the load-based formula, and say so.

Cost estimate (local rate table, not a live pricing API — say "estimated" not "actual"):
$0.04/vCPU-hour, $0.005/GiB-RAM-hour, $0.10/GiB-storage-month, 730 hours/month. Sum compute
(cpu*replicas + memory*replicas across all services) plus storage, round to the nearest dollar.

recommended_tier: "economy" if environment is dev, otherwise "balanced" — the human can still
pick a different tier at the approval gate.

Sandbox limits (hard, per tier): total memory across services ≤ max_memory_gb from constraints
(default 8Gi), total replicas ≤ 8, rps ≤ 2000. A tier beyond these limits is dropped by the
backend, not by you — just size each tier honestly; don't pre-filter.

For operation=modify: plan ONLY the delta per tier; never touch volumes holding existing data.
Each tier's reasoning must be 3-6 sentences, plain business English, showing the arithmetic.
```
