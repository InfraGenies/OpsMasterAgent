# Agent responsibilities & the skills library

One-page index of what each pipeline node is responsible for, whether it calls an LLM, and which skill
files (if any) get spliced into its prompt at runtime. Each node's full spec is its own `0N-*.md` file in
this folder; this page is a map, not a replacement for reading those. For "why this diverges from the
original agent set" narrative, see the root [`README.md`](../README.md#architecture-decisions)
"Architecture decisions" section — this page only covers *what each node does today*.

## What a "skill" is

A skill (`skills/*.md`) is a reusable knowledge module — sizing formulas, a template-writing convention, a
reasoning framework — that would otherwise be duplicated inline across every prompt that needs it. Each
skill file has a fenced ` ```text ` block (same convention as a node's own prompt) that gets loaded verbatim
and appended to a node's system prompt at runtime, via `apps/server/src/llm/skillLoader.ts: loadSkill()`
(mirrors `promptLoader.ts: loadPrompt()`). A node's prompt is built once at import time by concatenating its
base prompt with whichever skills always apply; skills that only apply *sometimes* (AWS target, enterprise
mode) are appended conditionally inside the node function itself. Editing a skill's `.md` file changes every
node that uses it — no code change, and no risk of the copies drifting out of sync with each other the way
duplicated inline text would.

Source of truth for both prompts and skills is this folder (`agent-md-files/`); `apps/server/src/prompts/`
and `apps/server/src/skills/` are runtime copies read by the server. Keep both in sync when you edit either.

## Agent responsibility table

| Node | Spec file | Role (one line) | Calls LLM? | Skills spliced in |
|---|---|---|---|---|
| `orchestrator` | [`00-orchestrator.md`](00-orchestrator.md) | Owns the state machine and routes every node transition; persists state after each node so the approval gate survives a restart. | No | — |
| `intake` | [`01-intake.md`](01-intake.md) | Converts free-text into a validated `PlanRequest`, or refuses with a reason — first line of defence against unsafe/out-of-scope/nonsensical requests. | Yes | — |
| `planner` | [`02-planner.md`](02-planner.md) | Turns a `PlanRequest` into a priced, multi-tier `CapacityPlan` with visible reasoning. | Yes | `sizing-workloads` (always) · `managed-service-substitution` (only `constraints.target === "aws"`, non-enterprise) · `compliance-and-dr-reasoning` (only `enterprise_mode === true`) |
| `readiness_check` | [`02b-readiness-check.md`](02b-readiness-check.md) | Deterministic pre-flight scan (docker daemon, host ports, disk space, template topology) before a single LLM call is spent on `iac_generator`. | No (deterministic scan) | — |
| `compliance_check` | [`02c-compliance-check.md`](02c-compliance-check.md) | Enterprise Architecture Advisor mode only: checks the planner's `ArchitectureRecommendation.managed_controls` against each requested framework's mandatory-control checklist and flags gaps. | No (deterministic scan) | — |
| `iac_generator` | [`03-iac-generator.md`](03-iac-generator.md) | Turns a `CapacityPlan` into an `IaCPayload` — picks a pre-approved template and fills parameters, or (when nothing fits) writes IaC files directly (`template_id: "freeform"`). | Yes | `writing-compose-iac` (always) · `writing-terraform-iac` (always) · `novel-requirement-reasoning` (always — the meta-skill for the freeform path) |
| `policy_validator` | [`03b-policy-validator.md`](03b-policy-validator.md) | Deterministic security/policy scan of the rendered `IaCPayload`; loops auto-fixable findings back to `iac_generator` (capped retries), surfaces the rest at the approval gate. | No (deterministic scan) | — |
| `approval_gate` | [`04-approval-gate.md`](04-approval-gate.md) | Hard human stop. Two sequential gates: Gate 1 approves the capacity plan (no IaC yet), Gate 2 approves the generated IaC + deploy commands. | No (human) | — |
| `build` | *(not in spec — see README "sixth addition")* | Clones and builds a real application from source for a `"__BUILD__:<key>"` sentinel service, using a hardcoded, developer-reviewed, commit-pinned registry (`nodes/buildRegistry.ts`) — never an LLM-supplied repo URL. | No (deterministic executor; the LLM only ever chose the sentinel, earlier, at `planner`) | — |
| `deploy` | [`05-deploy-agent.md`](05-deploy-agent.md) | Executes the approved `IaCPayload` against the local sandbox through the hard command allow-list, streams logs, rolls back on failure. | No | — |
| `verify` | [`06-verify-agent.md`](06-verify-agent.md) | Health checks + smoke load test against the plan's stated rps; emits a green/red `VerifyReport`. Red triggers automatic rollback. | Yes (summarises the report; the checks themselves are code) | — |
| `rollback` | *(part of `05-deploy-agent.md` / `06-verify-agent.md`)* | Tears down (`create` failure) or restores the previous environment's files (`modify` failure) via the same command allow-list. | No | — |
| `audit_store` | [`07-audit-store.md`](07-audit-store.md) | Durable store for every node's input/output/command/decision — the pipeline's only source of cross-request state. | No | — |

## Skills library

| Skill file | Used by | Applies |
|---|---|---|
| [`sizing-workloads.md`](skills/sizing-workloads.md) | `planner` | Always, every call — core replica/memory/storage sizing formulas, sandbox limits, and (per tier) the scoping narrative (`included_components`/`skipped_components`/`task_graph`), `scaling_strategy`, and the `manual_estimate_person_days`/`agent_estimate_minutes` ROI estimate — see README's "ninth addition". |
| [`managed-service-substitution.md`](skills/managed-service-substitution.md) | `planner` | Only `constraints.target === "aws"` and not `enterprise_mode` — containerized-DB-vs-RDS/DynamoDB/ElastiCache reasoning for UC-9-style requests. |
| [`compliance-and-dr-reasoning.md`](skills/compliance-and-dr-reasoning.md) | `planner` | Only `enterprise_mode === true` — the Enterprise Architecture Advisor's archetype/criticality/compliance reasoning framework. Spliced into **two separate LLM calls** (`runEnterprisePlanner`'s Pass 1/Pass 2), each prefixed with a pass-specific directive — a single combined call proved unreliable in practice (confirmed live against Bedrock: truncation and a dropped-tier failure). |
| [`writing-compose-iac.md`](skills/writing-compose-iac.md) | `iac_generator` | Always — conventions (healthchecks, nginx-sidecar rule, secrets) so the freeform path matches vetted-template quality. |
| [`writing-terraform-iac.md`](skills/writing-terraform-iac.md) | `iac_generator` | Always — same rationale as above, for the Terraform freeform path. |
| [`novel-requirement-reasoning.md`](skills/novel-requirement-reasoning.md) | `iac_generator` | Always — the meta-skill for the moment nothing in either template catalogue fits the request's topology. |

Each skill file's own header states its "Used by" node and condition verbatim (source of truth if this
table ever drifts from it) — see `skills/*.md`.

## Adding a new skill

1. Write `agent-md-files/skills/<name>.md` with a short "Used by" header (node + condition) and a fenced
   ` ```text ` block containing the exact text to splice in.
2. Copy it verbatim to `apps/server/src/skills/<name>.md` (the runtime copy `skillLoader.ts` actually reads).
3. Call `loadSkill("<name>")` from the node that needs it — unconditionally at module load if it always
   applies, or inside the node function (appended to the base prompt string) if it's conditional.
4. Add a row to the two tables above.
