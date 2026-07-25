# How Each Agent Works

Implementation guide to every node in the Ops Master Agent pipeline: what it does, the process
it follows, its inputs/outputs (contracts), and the configuration it needs. The design spec for
each agent lives in `agent-md-files/` (one file per node); this document describes how **this
codebase** implements them.

```
intake → planner → iac_generator → approval_gate → deploy → verify → report
                        ↑______________|                       |
                        (reject/edit rework loop)          (rollback on failure)
```

All JSON shapes named below (`PlanRequest`, `CapacityPlan`, `IaCPayload`, `VerifyReport`,
`AuditEvent`) are Zod schemas in `packages/shared/src/contracts.ts` — the single source of
truth both server and web UI import.

---

## 0. Orchestrator (`apps/server/src/orchestrator/pipeline.ts`)

Not an LLM agent — the deterministic state machine that wires the others together.
Spec: `agent-md-files/00-orchestrator.md`.

**Process:**
1. `POST /api/runs` → `startRun()` creates a run row, then executes
   **Phase 1** (`runIntakeThroughGate`): intake → planner → iac_generator → sets status
   `awaiting_approval` → **returns**. Nothing waits in memory for the human.
2. `POST /api/runs/:id/decision` → `submitDecision()` executes **Phase 2**: it re-reads every
   prior node output *from the audit trail* (not from memory), then either loops back to the
   planner (reject/edit) or runs deploy → verify → report (approve).

**Key property — audit log as checkpoint store:** every node's output is persisted to
`audit_events.output_json` the moment it's produced, and the next phase always rehydrates from
there. A server restart between "awaiting approval" and the decision loses nothing. The only
in-memory state is the 30-minute approval-timeout timer, deliberately re-armed on boot
(`rehydratePendingApprovals()`).

**Failure handling:** an unrecoverable node error marks the run `failed` (never crashes the
server). A deploy failure or red verification triggers the rollback path (§7).

---

## 1. Intake Agent (`apps/server/src/nodes/intake.ts`)

Spec: `agent-md-files/01-intake.md` · Prompt: `apps/server/src/prompts/01-intake.md` · **LLM: yes**

**Purpose:** turn one free-text sentence into a structured, validated `PlanRequest` — or refuse.

**Process:**
1. The raw text goes to the LLM with the intake system prompt.
2. Output is validated against `PlanRequestSchema`; on validation failure the error is appended
   to the prompt and retried once, then the run fails (`llm/runLLMJson.ts`).
3. Policy screening happens here: destructive/malicious asks (`rm -rf`, root access, prompt
   injection like "ignore all previous instructions"), impossible scale, or requests outside
   the sandbox's scope come back with `feasible_input: false` + `infeasibility_reason`, and the
   orchestrator refuses the run with a written report.

**Output (`PlanRequest`):** app type, database, cache, expected load (rps), environment target
(dev/staging/…), `operation` (create/modify/destroy), optional `existing_env_id`.

**Mock mode:** `mockIntake()` implements the same parsing + policy regexes deterministically —
it is the offline/CI path, kept behaviorally consistent with the prompt.

---

## 2. Planner Agent (`apps/server/src/nodes/planner.ts`)

Spec: `agent-md-files/02-planner.md` · Prompt: `apps/server/src/prompts/02-planner.md` · **LLM: yes**

**Purpose:** convert the `PlanRequest` into a sized `CapacityPlan` with visible reasoning.

**Process / sizing rules (from the prompt):**
- Node.js app instance ≈ 250 rps sustained → `replicas = ceil(target_rps / 250)`.
- Databases are never replicated in the sandbox; sized by memory (e.g. 1Gi) with a named volume.
- Any HTTP service with replicas > 1 gets an nginx load balancer in front.
- Beyond-sandbox asks (e.g. 50k rps, five-nines) → `feasible: false` + reasoning → refusal.
- **Rework loop:** when a human rejects with a comment, the planner is re-invoked with that
  comment as feedback and produces a revised plan; when the human *edits*, the patch
  (replicas/memory/cpu) is applied directly without an LLM call.
- **Modify flow:** for `operation=modify` the planner returns only the *delta*;
  `nodes/planMerge.ts` merges it onto the stored environment's plan so downstream nodes always
  see one complete `CapacityPlan`.

**Output (`CapacityPlan`):** services (name, image, replicas, cpu, memory), storage, network
(exposed host ports), and a human-readable `reasoning` string shown in the UI.

---

## 3. IaC Generator Agent (`apps/server/src/nodes/iacGenerator.ts`)

Spec: `agent-md-files/03-iac-generator.md` · Prompt: `apps/server/src/prompts/03-iac-generator.md` · **LLM: yes (choice only)**

**Purpose:** produce deployable Infrastructure-as-Code from pre-vetted templates.
**The LLM never writes YAML or commands** — it only returns `{template_id, variables}` chosen
from the fixed catalogue, or `{error: "no_template", needed: …}` (which becomes an honest
refusal).

**Template catalogue (`templates/catalog.ts`):**
| Template | Topology |
|---|---|
| `compose-single-v1` | one app container |
| `compose-web-db-v1` | app + database |
| `compose-web-db-cache-v1` | app + database + redis |
| `compose-lb-replicas-v1` | app + redis (scaled, LB-fronted) |

**Process:**
1. LLM (or mock) picks the template and fills variables (`db_name`, `health_path`, …).
2. **Secrets:** the LLM may only emit the literal `"__GENERATE__"`;
   `templates/secrets.ts` swaps it for a real random value at render time — real secrets never
   pass through the model.
3. The backend renders `docker-compose.yml` (+ `nginx.conf` when needed) into
   `apps/server/deployments/<request_id>/`. Rule baked into every template: a service with
   `replicas > 1` can't bind a fixed host port under plain `docker compose`, so an nginx
   sidecar owns the host port instead (`frontIfScaled`). Kubernetes-style memory units from the
   plan (`512Mi`) are normalized to compose units (`512M`) at render time.
4. Validation: `docker compose config -q` against the rendered files (skipped gracefully with
   a note when the docker CLI is absent).

**Output (`IaCPayload`):** rendered files, `apply_command`, `rollback_command`, validation
result, and (for modify) `diff_from` — the previous environment's files, used by both the diff
viewer and rollback.

---

## 4. Approval Gate (`orchestrator/pipeline.ts` — `reachApprovalGate` / `submitDecision`)

Spec: `agent-md-files/04-approval-gate.md` · **LLM: no. Human: yes.**

**Purpose:** the human-in-the-loop safety gate. Nothing deploys without a recorded decision.

**Process:**
1. Run status → `awaiting_approval`; a `pending` audit event is written; the UI shows the plan,
   the rendered IaC (with diff view for modifies), and three actions.
2. Decisions (`POST /api/runs/:id/decision`):
   - **approve** → decision row + audit event (with actor name), then deploy phase.
   - **reject + comment** → comment fed back to the planner → revised plan → back to the gate.
   - **edit + patch** → replicas/memory/cpu patch applied directly → IaC re-rendered → back to
     the gate.
3. **Timeout:** no decision within `APPROVAL_TIMEOUT_MINUTES` (default 30) → auto-reject by
   `actor: system`, run refused, report written. Timers survive restarts (re-armed from the
   pending event's timestamp at boot).

---

## 5. Deploy Agent (`apps/server/src/nodes/deploy.ts` + `nodes/commandAllowList.ts`)

Spec: `agent-md-files/05-deploy-agent.md` · **LLM: no — deterministic executor.**

**Purpose:** apply the IaC — safely.

**Safety model (the core of it):**
- `commandAllowList.ts` is the **only** file in the codebase that spawns a process.
- The `apply_command` string must match one of three exact regexes
  (`docker compose -p <proj> up -d --wait` / `down -v` / `config -q`); anything else is refused
  before any process exists. There is no path from LLM output to a shell.
- Execution: `spawn(argv, { shell: false })`, cwd pinned to the deployment dir, environment
  scrubbed to a small allow-list of variables, hard timeout (3 min), stdout/stderr streamed
  live to the UI via WebSocket.

**Mock-deploy mode:** when the docker CLI is absent (or `MOCK_DEPLOY=true`), the allow-list
check still runs, then the spawn is *simulated* and every log line, audit event, and report is
stamped `SIMULATED`. `MOCK_DEPLOY=auto` (default) switches to real Docker automatically the
moment it's installed.

**On failure:** control passes to Rollback (§7); the run never half-succeeds silently.

---

## 6. Verify Agent (`apps/server/src/nodes/verify.ts`)

Spec: `agent-md-files/06-verify-agent.md` · **LLM: no — the pass/fail verdict is deterministic.**

**Process:**
1. **Health checks:** GET each exposed endpoint, up to 10 attempts, 3s apart, 5s timeout each.
2. **Load test** (skippable via `SKIP_LOAD_TEST=true`): autocannon for 15s against the target
   rps from the request (stands in for the spec's k6, which needs Linux-only host networking).
   Thresholds: p95 < 300ms and error rate < 1%.
3. **Verdict:** `green` (all checks pass + thresholds met) or `red`. Red → automatic rollback.
   Green → the environment is recorded as `up` with its full snapshot (template, plan, files)
   for future modify operations.

In mock-deploy mode, checks are reported as simulated-passing and clearly labeled — nothing
real is probed because nothing real was deployed.

**Output (`VerifyReport`):** per-check results, smoke-test numbers, verdict, endpoints, summary.

---

## 7. Rollback (`apps/server/src/nodes/rollback.ts`)

Part of the deploy agent spec (`05-deploy-agent.md`). · **LLM: no.**

Triggered by deploy failure or red verification. Semantics differ by operation:

| Operation | Rollback behavior |
|---|---|
| `create` failed | full teardown: `docker compose down -v` (volumes included — nothing to preserve) |
| `modify` failed | restore the previous environment's files from `diff_from` and re-apply **without** `-v` — existing data must survive |

A rollback that itself fails is surfaced as "manual intervention needed" in the audit trail and
report — never hidden. All commands go through the same allow-list as deploy.

---

## 8. Report (`apps/server/src/nodes/report.ts`) & Audit Store (`apps/server/src/store/`)

Spec: `agent-md-files/07-audit-store.md`.

**Report:** every terminal state (deployed / refused / failed / rolled back) produces a
markdown report: who requested what, the plan and reasoning, verify results, endpoints, and the
full event timeline. Shown in the UI's report panel.

**Audit store:** `AuditStore` interface with two interchangeable backends —
Supabase (`supabaseStore.ts`, when both env vars are set) or a local JSON file
(`localStore.ts`, `apps/server/data/local-store.json`, the zero-config default). Every audit
event records: request id, node, actor (`agent` / `human` / `system`), status, detail, the
node's input/output JSON, any command executed, and timestamp. Because phase 2 rehydrates from
these rows, the audit trail doubles as the pipeline's checkpoint store.

---

## Configuration Reference (`apps/server/.env`)

Everything is optional — with an empty `.env` the app runs fully offline.

| Variable | Default | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(empty)* | empty → mock LLM mode auto-enables |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | model for intake/planner/iac_generator |
| `MOCK_LLM` | `false` | `true` forces mock LLM even with a key (CI) |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | *(empty)* | both set → Supabase store; else local JSON file. One-time setup: run `supabase/schema.sql` in the project's SQL editor |
| `MOCK_DEPLOY` | `auto` | `auto` = simulate deploy/verify only when docker CLI is missing; `true`/`false` force |
| `SKIP_LOAD_TEST` | `false` | `true` skips autocannon in verify (health checks still run) |
| `DEPLOYMENTS_DIR` | `./deployments` | where rendered IaC + running projects live |
| `PORT` | `4100` | API/WS port (4000 is squatted by another process on this machine) |
| `APPROVAL_TIMEOUT_MINUTES` | `30` | auto-reject window at the approval gate |

**Changing an agent's LLM behavior:** edit its prompt file in `apps/server/src/prompts/0N-*.md`
(and keep the matching `agent-md-files/0N-*.md` spec in sync) — that is the intended lever, not
rewriting the calling code. Mock functions must be kept behaviorally consistent with the
prompts they mirror.
