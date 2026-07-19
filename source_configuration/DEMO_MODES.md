# Demo Modes — What Runs Where, and What You Need Locally

Companion to [REPOS.md](REPOS.md) and [DEMO_PLAN.md](DEMO_PLAN.md). This answers one question
precisely: **what has to exist on the demo machine** (repos, Docker, API keys) for each level of
demo — and what the pipeline actually does at each level.

**Short answer: you clone ZERO repos for today's demo.** The GitHub repos in REPOS.md are
*narrative references* for the use cases, not inputs to the pipeline. The agent never checks out
code — it works entirely from the natural-language request and public Docker Hub images.

---

## The pipeline flow, and where each mode differs

Every mode runs the **same** seven stages — only the shaded ones change behavior:

```
 natural-language request
          │
          ▼
   ┌─────────────┐   parses text → structured PlanRequest
   │   INTAKE    │   [Mode 1: rule-based mock · Mode 2/3: same · real LLM optional]
   └─────────────┘
          │
          ▼
   ┌─────────────┐   sizing arithmetic → CapacityPlan + reasoning
   │   PLANNER   │   picks IMAGES here: generic (node:18-alpine…) or your built image (Mode 3)
   └─────────────┘
          │
          ▼
   ┌─────────────┐   chooses a vetted template + variables → renders compose files
   │ IaC GENERATOR│  identical in every mode — never writes YAML/commands itself
   └─────────────┘
          │
          ▼
   ┌─────────────┐   ⏸ pipeline STOPS — human approves / rejects / edits
   │ APPROVAL GATE│  identical in every mode — nothing deploys without a decision
   └─────────────┘
          │ approve
          ▼
   ┌─────────────┐   allow-listed `docker compose up -d --wait`
   │   DEPLOY    │   Mode 1: SIMULATED spawn · Mode 2/3: real containers start
   └─────────────┘
          │
          ▼
   ┌─────────────┐   health checks (+ optional load test)
   │   VERIFY    │   Mode 1: simulated, clearly labeled · Mode 2/3: real HTTP probes
   └─────────────┘   red verdict → automatic rollback (all modes)
          │
          ▼
   ┌─────────────┐   markdown report + full audit trail
   │   REPORT    │   identical in every mode
   └─────────────┘
```

The safety story is **identical in all three modes**: command allow-list, human gate, secrets
never through the LLM, everything audited. That's a talking point — mock mode isn't a different
system, it's the same system with two seams stubbed.

---

## Mode 1 — Offline mock demo (TODAY — nothing to install, nothing to clone)

**Needs:** Node 18+ only. No repos, no Docker, no API key, no internet beyond `npm install`.

| Question | Answer |
|---|---|
| Clone the REPOS.md repos? | **No** |
| Docker Desktop? | **No** |
| ANTHROPIC_API_KEY? | **No** — deterministic mocks implement the same prompt rules |
| What's real? | Pipeline logic, sizing rules, template rendering, approval gate, rework/edit loops, rollback semantics, audit trail, reports |
| What's simulated? | The LLM calls and the `docker compose` process spawn + health probes — every simulated step is stamped `SIMULATED` in logs, audit, and report |

**Start:** `npm start` → http://localhost:5173 → run the 10 ready use cases from
[DEMO_PLAN.md](DEMO_PLAN.md). This is the mode the machine is configured for right now
(`MOCK_LLM=true`, `MOCK_DEPLOY=auto`).

**Demo line to say:** *"Everything you see — the plan, the IaC, the gate, the audit — is the
production code path; only the container runtime and the model call are stubbed, and the system
labels every stub honestly."*

---

## Mode 2 — Real containers, generic images (after installing Docker — still zero clones)

**Needs:** WSL2 + Docker Desktop. Still no repos, still no API key.

```powershell
wsl --install                                   # admin PowerShell, then REBOOT
winget install -e --id Docker.DockerDesktop     # after reboot; launch once, accept license
npm stop; npm start                             # MOCK_DEPLOY=auto flips to real automatically
```

What changes: `docker compose up -d --wait` **really runs** — compose pulls the public images
from Docker Hub itself (that's the only "checkout" that ever happens, and Docker does it for
you). Containers really start; health checks really probe them; a red verdict really tears down.

**Caveat to know before promising anything:** the app containers are *generic runtime images*
(plain `node:18-alpine` with no app in it), so the app's own health check won't return 200 — a
plain runtime image serves nothing. Expect deploy/verify to exercise the **failure + rollback
path** honestly rather than a green handoff. Two exceptions that go fully green with zero extra
work, because they're published ready-to-run products:

- **UC-10 monitoring** — `louislam/uptime-kuma:1` is a complete app; a real dashboard appears on
  :3001 seconds after approval. Best Mode-2 crowd moment.
- The **db/cache/nginx side services** (postgres, mysql, redis) are always real and healthy.

**Demo line:** *"Same build, no config change — the agent detected Docker and switched from
simulated to live on its own."*

---

## Mode 3 — Real product demo (clone 1–2 repos, night-before prep)

**Needs:** Mode 2 + clone and build **only the repos for the use cases you'll actually show**.
This is the only mode where checking out a repo matters, and it's per-use-case, not all 13.

Example for UC-1 (RealWorld API):

```powershell
git clone https://github.com/gothinkster/node-express-realworld-example-app
cd node-express-realworld-example-app
docker build -t realworld-api .        # do this the night before — first build is slow
```

Then make the planner choose `realworld-api` instead of `node:18-alpine` — either:
- **With a real LLM** (`ANTHROPIC_API_KEY` set, `MOCK_LLM=false`): include the repo URL in the
  request text; the intake/planner prompts read it and pick the built image, or
- **Staying in mock LLM mode:** add one line to the image table in
  `apps/server/src/nodes/planner.ts` (`mockPlanner`) mapping a keyword to `realworld-api`.

Now UC-1 deploys a genuine API: verify's health check hits `/api/tags` and returns real JSON,
and (with `SKIP_LOAD_TEST=false`) the load test measures a real app at 500 rps.

**Worth cloning, in priority order** (skip the rest):

| Priority | Repo | Use case | Why this one |
|---|---|---|---|
| 1 | `gothinkster/node-express-realworld-example-app` | UC-1 flagship | the headline demo goes fully green |
| 2 | `thedevs-network/kutt` | UC-9 | genuinely uses all three tiers (pg + redis) |
| skip | everything else | — | generic images or Mode-1 simulation already tell the story |

---

## Decision table — "do I need to clone repos?"

| You want to show… | Clone repos? | Docker? | API key? |
|---|---|---|---|
| Full pipeline, gate, audit, refusal, rollback (today's demo) | **No** | No | No |
| Real containers starting/stopping, real rollback teardown | **No** | Yes | No |
| A real dashboard appearing live (UC-10) | **No** | Yes | No |
| Flagship UC-1 with a real API answering requests | **1 repo** | Yes | Optional |
| Real Claude doing intake/planning instead of rules | No | — | Yes |

---

## Suggested demo narrative (works in every mode)

1. **Open** with UC-2: request → deployed in seconds. "This used to be a 2–3 day ticket chain."
2. **Flagship** UC-1: pause at the gate — show the reasoning, the rendered compose, the
   command that *will* run. Click Approve. "No human approval, no deployment — by construction."
3. **Modify** UC-7: show the file **diff** at the gate. "Change management with a real diff."
4. **Safety** UC-8a + adversarial prompt: two refusals, both audited. "It knows what it can't do."
5. **Close** UC-8b: deploy green → verify red → automatic rollback → audit timeline on screen.
   "When it fails, it cleans up after itself, and the trail shows everything."
