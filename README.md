# Ops Master Agent

Implementation of the **Hackathon Theme 4 — Ops Master Agent (Infra Lifecycle Automation)** brief in
[`agent-md-files/`](agent-md-files/): one sentence → capacity plan → IaC → human approval → live deployment →
verified report, fully audited.

The spec in `agent-md-files/` is written for a Python/LangGraph/SQLite stack. This build implements the same
architecture — same state machine, same 4 data contracts, same safety rules — in **Node.js/TypeScript**, with
**Supabase (Postgres)** as the audit/state store, per steer from the repo owner. See [Architecture decisions](#architecture-decisions)
for what changed and why.

## Repo layout

```
apps/
  server/    Express + WebSocket orchestrator (the pipeline itself)
  web/       React + Tailwind chat/approval/audit UI
packages/
  shared/    Zod contracts shared by both apps (mirrors agent-md-files/CONTRACTS.md)
supabase/
  schema.sql Run this once in your Supabase project's SQL editor
agent-md-files/  Original spec — source of truth for prompts, sizing rules, contracts
```

## Setup

### 1. Install

```bash
npm install
```

### 2. Configure the server

```bash
cd apps/server
cp .env.example .env
```

Fill in:
- `ANTHROPIC_API_KEY` — from console.anthropic.com. **Optional for now**: if left blank, the server
  auto-enables `MOCK_LLM` and every LLM call is replaced with a deterministic stand-in (see
  [Mock mode](#mock-mode-no-api-key-needed)), so you can run the whole pipeline before wiring a real key.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — create a free project at supabase.com, then
  **Project Settings → API**. Also **optional for now**: if left blank, the server falls back to a local
  JSON file (`apps/server/data/local-store.json`) so you can run and demo everything without a Supabase
  project. Fill these in when you want real, durable, shared persistence.

If you do set up Supabase, run [`supabase/schema.sql`](supabase/schema.sql) once in the SQL editor —
it creates `runs`, `audit_events`, `environments`, `decisions` with RLS enabled and no anon policies
(the server only ever talks to it with the service-role key, which bypasses RLS; nothing is reachable
from a browser).

### 3. Run

```bash
# terminal 1
npm run dev:server     # http://localhost:4000

# terminal 2
npm run dev:web         # http://localhost:5173
```

Open http://localhost:5173, type a request, submit, and watch the pipeline run.

### 4. Smoke test (no browser, no Docker required)

```bash
npm run smoke -w @ops-master/server
```

Runs UC-2, UC-8a (refusal), an adversarial prompt-injection attempt, and UC-1 end-to-end in-process, printing
the rendered `docker-compose.yml` and the audit trail. Deploy/rollback will legitimately fail here if
Docker Desktop isn't installed on the machine running the server — that's expected and still proves the
allow-list + rollback code path executes correctly; it just isn't a live container.

## What each demo scenario needs

| UC | Try it with | Needs Docker running? |
|---|---|---|
| UC-2 (simple) | "Spin up a dev environment for a simple Node.js todo app, low traffic, single instance." | for real deploy |
| UC-1 (flagship) | "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second." | for real deploy |
| UC-7 (modify) | Deploy UC-1 first, then: "Add a Redis cache to the staging environment we just created and wire the app to it." | for real deploy |
| UC-8 (refusal) | "Provision production with 50,000 req/s and five-nines availability." | no — refused before any template is rendered |
| UC-8 (rollback) | Approve any plan without Docker Desktop running | no — this **is** the rollback demo |

Install Docker Desktop per `agent-md-files/INSTALLATION.md` for the live-deploy demos; the pipeline logic
(intake → planner → IaC → approval → audit) runs and is fully demoable without it.

## Mock mode (no API key needed)

`MOCK_LLM=true`, or simply leaving `ANTHROPIC_API_KEY` blank, swaps every Claude call for a deterministic
stand-in that follows the same sizing rules and template-selection logic described in the prompts
(`apps/server/src/nodes/*.ts`, the `mock*` functions). This is what the smoke test runs under. It's meant
for offline development and CI, not the real demo — flip on a real `ANTHROPIC_API_KEY` for judges to see
the actual LLM reasoning (shown verbatim in the audit timeline either way).

## Architecture decisions

The brief's own docs (`agent-md-files/README.md`) describe a Python + LangGraph + FastAPI + SQLite stack.
Given the steer toward Node/TypeScript/React/Supabase, here's what this build does differently, and why:

| Spec says | This build does | Why |
|---|---|---|
| LangGraph (Python) state machine + `SqliteSaver` checkpointer | Hand-rolled TypeScript pipeline (`apps/server/src/orchestrator/pipeline.ts`) where **every cross-node handoff is read back from the audit trail**, not from in-memory state | Genuinely stronger for the "resume after restart" requirement in `04-approval-gate.md`: the approval-gate POST handler rehydrates `PlanRequest`/`CapacityPlan`/`IaCPayload` straight from `audit_events.output_json`, so a decision arriving after a server restart works with **zero** in-memory state to have lost. A suspended-Promise design (closer to literal LangGraph `interrupt()`) would have made that test case fragile instead of trivially true. |
| SQLite audit/state store | Supabase Postgres (`apps/server/src/store/supabaseStore.ts`), same 4 tables from `07-audit-store.md` plus `decisions` | Per your steer. RLS is enabled with no policies — the server's service-role key bypasses RLS, nothing is reachable from a browser. A local JSON-file store (`store/localStore.ts`) is the dev/offline fallback. |
| k6 in a container, `docker run --network host` | `autocannon` (pure Node, `nodes/verify.ts`) | `--network host` is a Linux-only Docker trick — Docker Desktop on Windows/Mac runs containers in a VM where it doesn't pass through, so the spec's own k6 invocation wouldn't work on the Windows box this was built on. Autocannon reports the same rps/p95/error-rate shape with no extra install. Its closest percentile bucket to p95 is p97.5, used as a (slightly conservative) stand-in — noted in code. |
| Jinja2 templates (`templates/*.j2`) | Typed TS builder functions + `js-yaml` (`apps/server/src/templates/`) | Same contract (LLM picks `template_id` + fills a `variables` bag; backend renders, never the model) — just typed instead of string-templated. |
| Terraform / Kubernetes formats, UC-3 (voting app), UC-5 (Spring Boot), UC-6 (Minikube) | Not built | Scope cut to match the spec's own "minimum viable demo set: UC-1, UC-2, UC-7, UC-8" and "UC-6 only after UC-1–4 are rock solid." Compose-only covers 4 of 7 templates (`compose-single-v1`, `compose-web-db-v1`, `compose-web-db-cache-v1`, `compose-lb-replicas-v1`); adding Terraform/K8s renderers or the 5-service voting topology is straightforward follow-up work in `templates/catalog.ts` but wasn't in scope here. |
| Nginx LB "added automatically when replicas > 1" (`02-planner.md`) | Same rule, but folded directly into `compose-web-db-v1` / `compose-single-v1` rendering rather than a separate template pick | Plain `docker compose up` (no Swarm) can't bind one fixed host port across N replicas of the same service — there's no built-in ingress mesh. Nginx fronts the service instead, resolved once at container start; Docker's embedded DNS returns one A record per replica, so a static upstream still round-robins across whatever's up at deploy time. This is what makes UC-1's 500rps→2-replica plan (which triggers the nginx rule) actually deployable with the same template used for 1-replica cases. |

Everything else matches the spec directly: the 4 JSON contracts (`packages/shared/src/contracts.ts` mirrors
`CONTRACTS.md` exactly), the node responsibilities and LLM/no-LLM boundaries per node, the hard command
allow-list (`nodes/commandAllowList.ts`, `argv` arrays via `spawn`, never `shell: true`), the two safety
rules from `WORKFLOW.md` (LLM never writes shell commands; nothing deploys without a human decision row),
and the audit event shape.

## Where each spec agent lives in code

| Spec file | Code |
|---|---|
| `00-orchestrator.md` | `apps/server/src/orchestrator/pipeline.ts`, `ws/hub.ts` |
| `01-intake.md` | `apps/server/src/nodes/intake.ts`, prompt at `apps/server/src/prompts/01-intake.md` |
| `02-planner.md` | `apps/server/src/nodes/planner.ts` + `planMerge.ts`, prompt at `prompts/02-planner.md` |
| `03-iac-generator.md` | `apps/server/src/nodes/iacGenerator.ts`, templates in `templates/catalog.ts`, prompt at `prompts/03-iac-generator.md` |
| `04-approval-gate.md` | `orchestrator/pipeline.ts` (`reachApprovalGate`, `submitDecision`, timeout), UI: `web/src/components/ApprovalGate.tsx` |
| `05-deploy-agent.md` | `apps/server/src/nodes/deploy.ts`, `commandAllowList.ts` |
| `06-verify-agent.md` | `apps/server/src/nodes/verify.ts` |
| `07-audit-store.md` | `apps/server/src/store/*`, `supabase/schema.sql`, UI: `web/src/components/AuditTimeline.tsx` |

Prompts are loaded verbatim from their fenced ` ```text ` blocks at runtime (`llm/promptLoader.ts`) — exactly
the convention `agent-md-files/README.md` itself prescribes — so editing a prompt `.md` file changes behaviour
with no code change.
