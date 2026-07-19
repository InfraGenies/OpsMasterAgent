# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An implementation of the "Ops Master Agent" infra-lifecycle-automation pipeline: a natural-language
infra request flows through `intake → planner → iac_generator → approval_gate → deploy → verify →
(rollback) → report`, fully audited. The design spec lives in `agent-md-files/` (one `.md` per pipeline
node, plus `CONTRACTS.md`, `WORKFLOW.md`, `USE_CASES.md`) — that folder is the source of truth for prompt
wording, sizing rules, and the JSON contracts; this repo is a Node/TypeScript + Supabase implementation of
it (the spec itself assumes Python/LangGraph/SQLite). **When changing pipeline behavior, check the matching
`agent-md-files/0N-*.md` file first** — code should stay traceable back to a spec file. `README.md` documents
every place this implementation deliberately diverges from the spec and why (state-machine design, Supabase
instead of SQLite, autocannon instead of k6, template scope cut to compose-only).

## Commands

Root is an npm workspaces monorepo (`packages/shared`, `apps/server`, `apps/web`).

```powershell
# One command (Windows): installs deps, builds shared, creates a mock-mode
# apps/server/.env if missing, starts server+web in the background, opens
# the browser. npm stop / .\stop-app.ps1 tears both down (kills full process
# trees via taskkill /T, not just top PIDs — npm/tsx/vite fan out on Windows).
npm start                            # == .\start-app.ps1
npm stop                             # == .\stop-app.ps1
```

```bash
npm install                          # once, from repo root
npm run build -w @ops-master/shared  # required once before first dev:server / dev:web

# Dev (two terminals) — what start-app.ps1 does under the hood
npm run dev:server                   # apps/server on :4100 (tsx watch)
npm run dev:web                      # apps/web on :5173 (vite, proxies /api and /ws to :4100)

# Build / typecheck everything
npm run build                        # builds shared -> server -> web in order (order matters: shared first)
npm run typecheck                    # same order, --noEmit

# Per-workspace (use when iterating on just one package)
npm run typecheck -w @ops-master/shared
npm run typecheck -w @ops-master/server
npm run typecheck -w @ops-master/web
npm run build -w @ops-master/shared  # must be rebuilt before server/web typecheck picks up contract changes

# In-process pipeline smoke test (no browser, no HTTP, no Docker required)
npm run smoke -w @ops-master/server
```

There is no test framework wired up yet — `smoke -w @ops-master/server` (`apps/server/src/smoke.ts`) is the
closest thing to an integration test: it drives `startRun`/`submitDecision` directly in-process through
UC-2, a refusal (UC-8a), an adversarial prompt-injection attempt, and UC-1, and prints the rendered
docker-compose + audit trail. It runs in **mock-LLM mode automatically** whenever `ANTHROPIC_API_KEY` is
unset — no external calls needed to validate pipeline logic. Deploy/rollback steps will legitimately fail
in environments without the `docker` CLI; that's an expected, informative failure (proves the allow-list +
rollback path), not a bug.

Env config: `apps/server/.env` (copy from `.env.example`). Everything is optional for local dev — no
`ANTHROPIC_API_KEY` auto-enables mock LLM responses; no `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` falls
back to a local JSON file at `apps/server/data/local-store.json`. Run `supabase/schema.sql` once in a
Supabase project's SQL editor when using real Supabase.

## Architecture

### The core design decision: audit log as checkpoint store

There is **no LangGraph and no in-memory suspended-Promise graph**. `apps/server/src/orchestrator/pipeline.ts`
implements the same node graph as the spec, but every node's output is persisted to `audit_events.output_json`
immediately (`orchestrator/audit.ts: logAudit`), and the *next* phase always rehydrates its input by reading
the audit trail back (`loadLatestNodeOutput<T>(store, requestId, nodeName)`) rather than from a closure or
in-memory object. Concretely, the pipeline is split into two independently-triggerable phases:

- **`runIntakeThroughGate`** (triggered by `POST /api/runs`): intake → planner → iac_generator → sets run
  status to `awaiting_approval` and returns. Nothing is held in memory waiting for a human.
- **`submitDecision`** (triggered by `POST /api/runs/:id/decision`): reads the persisted `PlanRequest` /
  `CapacityPlan` / `IaCPayload` fresh from the audit trail, then either loops back to the planner
  (`reworkPlan`, for reject/edit) or proceeds to `runDeployThroughReport` (for approve).

This means a server restart between "awaiting approval" and the human's decision loses nothing — the only
thing an in-memory `Map` tracks is the **30-minute approval timeout** (`scheduleApprovalTimeout`/
`clearApprovalTimeout`), which is deliberately re-armed on boot via `rehydratePendingApprovals()` (called
from `index.ts`) by reading the `approval_gate` "pending" audit event's timestamp. When touching approval-gate
or resume-after-restart logic, preserve this "audit trail is the only source of cross-request state" property
— don't introduce new in-memory state that a restart would lose.

### Contracts are the seam

`packages/shared/src/contracts.ts` defines every JSON shape that crosses a node boundary (`PlanRequest`,
`CapacityPlan`, `IaCPayload`, `VerifyReport`, `AuditEvent`, `Run`, `Decision`, `EnvironmentRecord`, `WsEvent`)
as Zod schemas, mirroring `agent-md-files/CONTRACTS.md`. Both `apps/server` and `apps/web` import types from
`@ops-master/shared` — after editing a contract, rebuild it (`npm run build -w @ops-master/shared`) before
the other workspaces' typechecks will see the change. LLM node outputs are validated against these schemas
via `llm/runLLMJson.ts`, which retries once with the validation error appended to the prompt on failure, then
throws (the node's caller in `pipeline.ts` treats an unrecoverable node failure as a run failure, not a crash).

### Prompt loading convention

Each LLM node's system prompt lives in `apps/server/src/prompts/0N-*.md` as a runtime copy of the fenced
` ```text ` block from the matching `agent-md-files/0N-*.md`. `llm/promptLoader.ts` (`loadPrompt`) extracts
that block verbatim at import time. **To change a node's LLM behavior, edit the prompt `.md` file** — that
is the intended lever, not rewriting the calling code. Keep the runtime copy and the spec file in sync when
you do.

### Mock mode

`llm/client.ts: isMockMode()` returns true whenever `MOCK_LLM=true` OR `ANTHROPIC_API_KEY` is unset. Every
node that calls an LLM (`nodes/intake.ts`, `nodes/planner.ts`, `nodes/iacGenerator.ts`) has a paired
deterministic `mock*()` function implementing the same rules the prompt describes (sizing formulas, template
selection, policy-violation regexes) — these aren't stubs to delete later, they're the offline/CI path and
must stay behaviorally consistent with the prompts.

### Store abstraction

`store/types.ts` defines `AuditStore`; `store/supabaseStore.ts` and `store/localStore.ts` both implement it.
`store/index.ts: getStore()` picks Supabase when both env vars are set, else the local JSON file, and caches
the choice for the process lifetime. Nothing outside `store/` should import `@supabase/supabase-js` or touch
the local JSON file directly — go through `getStore()`.

### IaC templates: LLM picks, backend renders

`templates/catalog.ts` holds four compose templates (`compose-single-v1`, `compose-web-db-v1`,
`compose-web-db-cache-v1`, `compose-lb-replicas-v1`). The LLM in `nodes/iacGenerator.ts` only ever chooses a
`template_id` and fills a `variables` bag (or returns `{error: "no_template", needed}`) — it never emits
YAML or shell commands directly. Secrets: the LLM emits the literal string `"__GENERATE__"`, and
`templates/secrets.ts: resolveVariableSecrets` swaps it for a real random value before rendering. A known
non-obvious rule baked into every template: plain `docker compose up` can't bind one fixed host port across
`deploy.replicas > 1` of the same service, so whenever a service's replica count is >1, the template fronts
it with an nginx sidecar that owns the host port instead (`catalog.ts: frontIfScaled`) — this is what makes
the planner's "add nginx when replicas > 1" rule actually deployable rather than just descriptive.

### Deploy: hard command allow-list

`nodes/commandAllowList.ts` is the only place that spawns a process. `resolveAllowedCommand(cmdString)`
matches against a fixed set of regexes (`docker compose -p <proj> up -d --wait` / `down -v` / `config -q`)
and returns an argv array or `null` — there is no path from an `IaCPayload.apply_command` string to a shell.
Commands run via `spawn(..., { shell: false })` with a scrubbed env and a timeout. `nodes/deploy.ts` and
`nodes/rollback.ts` both go through this. Rollback semantics differ by operation: `create` failure tears
down with `-v` (volumes included); `modify` failure restores the previous environment's files from
`IaCPayload.diff_from` and re-applies **without** `-v` (existing data must survive) — see `nodes/rollback.ts`.

### Modify flow (UC-7) and environment snapshots

`environments` rows store a serialized `EnvSnapshot` (`nodes/envSnapshot.ts`: `template_id` + full
`CapacityPlan` + rendered `files`) keyed by `env_id`, encoded/decoded via `encodeSnapshot`/`decodeSnapshot`.
For `operation=modify`, the planner is prompted to return only the *delta* services/storage/network, and
`nodes/planMerge.ts: mergeCapacityPlan` merges that delta onto the existing environment's stored plan before
it reaches `iac_generator` — downstream nodes always see one complete, contract-shaped `CapacityPlan`, never
a delta. If `existing_env_id` isn't given on a modify request, `pipeline.ts: findLatestUpEnvironment` picks
the most recently-deployed environment with `state = "up"` as a convenience default.

### Live progress: WebSocket, not Supabase Realtime

`ws/hub.ts` runs a single `WebSocketServer` at `/ws` and broadcasts every pipeline event
(`node_started`/`node_finished`/`awaiting_approval`/`log_line`/`run_finished`) to **all** connected clients;
the web app filters by `request_id` client-side (`App.tsx`). This is a deliberate simplification for a
single-demo-environment app — don't add per-request subscription filtering server-side unless the client
count actually becomes a problem. Durable state (for page reloads / late subscribers) always comes from the
REST endpoints (`GET /api/runs/:id`, `GET /api/runs/:id/audit`), which the web app refetches on every
relevant WS event rather than trusting the WS payload as the sole source of truth.

### Frontend structure

`apps/web/src/App.tsx` owns all top-level state (selected run, run detail, audit events, live log lines) and
passes it down; components under `components/` are presentational. `lib/diff.ts` is a small hand-rolled
LCS line-diff used only for the IaC file diff view (`IacFileViewer.tsx`) — no diff library dependency.
