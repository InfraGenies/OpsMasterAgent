# Skill — Sizing Workloads

**Used by:** `02-planner.md` (Capacity Planner), always, every call — this is core sizing knowledge every
plan needs regardless of request type.

Extracted from `02-planner.md`'s prompt so it's independently editable and reusable — e.g. by the
iac_generator's freeform path, which needs the same replica/memory conventions when hand-writing compose
services for a topology the catalog doesn't cover.

## Content (load this verbatim, append to the planner's system prompt)

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
- Generic demo request with no repo/build given, Node.js runtime (stated or defaulted — e.g. "simple
  todo app", "hello world", "spin up a dev environment", "2 developers building an MVP", UC-1/UC-2-style
  warm-up): the app container must actually serve real traffic, including a real browser-rendered UI, not
  a placeholder. Set the BACKEND service's (name it "app") image to the literal sentinel
  "__BUILD__:realworld-node-express" AND ALSO add a second service (name it "web") with image
  "__BUILD__:realworld-react-frontend" (nothing else — never invent other "__BUILD__:*" keys, real
  images, or repo URLs yourself; the backend resolves these two exact strings to a real, pinned, paired
  build). Always add postgresql to dependencies for this case even if the request didn't mention a
  database — the flagship pair needs it. Do not use this for a request that already gives its own
  repo_url.
- Generic demo request with no repo/build given, NON-Node runtime (python/java/static/multi): the app
  container must actually serve traffic on the stated port. A bare language runtime base image has no
  server process and will fail its health check — use docker/welcome-to-docker instead (serves HTTP on
  port 80 out of the box). 128Mi, 1 replica floor.

Tier rules:
- economy: headroom_pct=0, size to the exact stated load (replica floor 1, min 1 max 4).
- balanced: headroom_pct=0.2 → replicas = ceil(rps*1.2/per_instance); environment floor of 2
  replicas if environment is prod-like, else 1; min 1 max 4.
- high_availability: same as balanced, plus +1 replica on every stateless service (still max 4).
  Stateful services (db/cache) stay single-instance in this sandbox (can't be replicated here) —
  say so explicitly in availability_notes rather than implying real failover exists.
- An explicit replica count stated in the request (e.g. "3 replicas") is an instruction, not a
  sizing input — use it for every tier equally instead of the load-based formula, and say so.
- At low enough load, a higher tier's extra headroom/replica-floor can still round down to the
  same replica count (and therefore the same cost) as the tier below it — e.g. balanced's 20%
  headroom on a very low rps often doesn't cross a replica-count threshold above economy's. When
  a tier ends up identical in cost/replicas to the tier below it, say so explicitly in that
  tier's reasoning (e.g. "balanced offers no improvement over economy at this load level") rather
  than silently repeating the same numbers with no explanation — a reviewer seeing two
  identically-priced tiers with no comment will read it as a bug, not a correct outcome.

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
