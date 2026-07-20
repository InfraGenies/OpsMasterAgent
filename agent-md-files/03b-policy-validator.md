# Agent 3b — Policy & Security Validator

**Owner:** Ravikumar · **LLM:** none — deterministic scan · **Executes commands:** never

**Status:** not in the original spec set (`01`–`07`); added post-hoc to close the "self-correction loop"
gap described in `source_configuration/ops-master-agent-solution.md` §4, which had no backing
implementation. Slotted in as `3b` because it sits between `03-iac-generator.md` and
`04-approval-gate.md` without renumbering the rest.

## Role
Scan a rendered `IaCPayload` for security and policy problems before a human sees it, and — for the
narrow class of findings the IaC Generator can actually fix — loop feedback back to it and retry. This is
the "self-correction loop" the source proposal describes; everything else it finds is surfaced at the
approval gate rather than silently blocking the run.

## Input → Output
`IaCPayload` + `CapacityPlan` + `PlanRequest` → `PolicyReport` (see `CONTRACTS.md` §3b).

## Why this node can't fix everything it finds
In this implementation the IaC Generator LLM only ever picks a `template_id` and fills a small variable
bag (`health_path`, `db_name`, `db_user`, `db_password`) — see `03-iac-generator.md`. Compose structure
(images, ports, replica counts, `privileged`, `network_mode`) is rendered by fixed backend template code
from the `CapacityPlan`, which the IaC Generator never touches. So a finding rooted in the `CapacityPlan`
(an unpinned image tag, a service under-replicated for its environment) cannot be fixed by retrying the
IaC Generator — retrying would just reproduce the same finding. Only `auto_fixable: true` findings drive
a retry; everything else is reported once and shown to the human.

## Checks (deterministic, run on every attempt)

| rule_id | Severity | What it checks | auto_fixable |
|---|---|---|---|
| `structural_invalid` | critical | the backend's own `docker compose config -q` result was `ok: false` | no |
| `privileged_container` | critical | any rendered file sets `privileged: true` | no |
| `host_network` | critical | any rendered file sets `network_mode: host` | no |
| `docker_socket_mount` | critical | any rendered file bind-mounts `/var/run/docker.sock` | no |
| `weak_default_secret` | high | a `*PASSWORD*`/`*SECRET*` value equals a common default (`password`, `admin`, `changeme`, `root`, `123456`, `secret`) instead of a generated value | **yes** |
| `unpinned_image_tag` | high | an `image:` value has no tag or is tagged `:latest` | no |
| `unexpected_published_port` | medium | a published host port isn't in the approved `CapacityPlan.network.expose` | no |
| `prod_single_replica` | medium | `environment` matches `prod` and an internet-facing service has `replicas < 2` | no |

`passed = true` iff no `critical`/`high` finding remains. The three container-escape checks
(`privileged_container`, `host_network`, `docker_socket_mount`) can't fire against today's templates —
they exist as regression guards, not because the current template set is at risk.

**Deferred:** a cost-guardrail check (block if the plan's cost exceeds a budget ceiling) needs a cost
model that doesn't exist yet — see the capacity-planning enhancement item in
`source_configuration/ops-master-agent-enhancements-proposal.md` §2. Add it here once that lands.

## Orchestration (in `pipeline.ts`, not a separate LangGraph node in this implementation)
1. Run IaC Generator → render `IaCPayload`.
2. Run this validator against it.
3. If `passed` OR no remaining finding is both blocking (`critical`/`high`) and `auto_fixable`, stop and
   proceed to the approval gate with whatever the report contains — visible to the human, not hidden.
4. Otherwise, format the `auto_fixable` blocking findings as feedback, re-invoke the IaC Generator with
   it appended to the user prompt (same mechanism `02-planner.md`'s reject-with-comment rework already
   uses), and repeat. Capped at 3 total attempts (1 initial + 2 self-corrections).
5. Every attempt — both the IaC Generator's output and this validator's report — gets its own audit
   event, so the retry history is inspectable, not a black box.

## Guardrails
- No LLM call, so no prompt-injection surface — it only reads already-rendered files and structured plan
  data.
- Never blocks the run outright (except the existing `no_template` refusal, unchanged). An unresolved
  `critical` finding still reaches the human at the approval gate with a visible warning — the human
  makes the final call, consistent with `04-approval-gate.md`'s "nothing deploys without a human click."

## Tests (mirrors the existing per-node test pattern in `01`–`06`)
- A clean UC-1 plan → `passed: true`, `attempts: 1`, empty or advisory-only findings.
- A request containing the demo trigger phrase "weak password" → first attempt has an unresolved
  `weak_default_secret` finding, second attempt shows `passed: true` — proves the retry loop actually
  loops in mock mode (no real LLM required).
- A `prod` request with a single-replica exposed service → `prod_single_replica` finding present,
  `passed` still `true` if nothing else is blocking (it's `medium`, not blocking) — the run reaches the
  gate with the advisory visible rather than looping pointlessly against a finding the IaC Generator has
  no lever to fix.
