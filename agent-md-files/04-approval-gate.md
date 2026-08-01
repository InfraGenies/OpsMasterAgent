# Agent 4 — Human Approval Gate

**Owner:** InfraGenies · **LLM:** none — this node is human-only by design. · **Executes commands:** never · **Skills:** none

## Role
Hard stop before any deployment. **Divergence from the original spec**: this is now TWO sequential hard
stops, not one — Gate 1 approves the capacity plan itself (before any IaC exists), Gate 2 approves the
generated infrastructure code and deploy commands (before `deploy` runs). The graph pauses at each in turn,
the UI presents everything a reviewer needs at that stage, and only an explicit human action resumes
execution. Rationale: `readiness_check`/`compliance_check` only need the `CapacityPlan`, not any IaC, so
they run before Gate 1; `iac_generator`/`policy_validator` only make sense once the plan is locked in, so
they run between Gate 1 and Gate 2. This also means an "Edit parameters" click at Gate 1 is free (no LLM
call) — before this split, every edit re-triggered a full `iac_generator` call just to preview a tier
change.

## Gate 1 — Plan Approval (`RunStatus="awaiting_plan_approval"`)

Reached right after the planner (plus `readiness_check` and, in Enterprise Architecture Advisor mode,
`compliance_check`) — no IaC exists yet.

1. **The plan** — services table (image, cpu, memory, replicas) + the planner's reasoning paragraph, and the
   `ArchitectureRecommendation` when applicable.
2. **Readiness/compliance findings**, if any.
3. Four buttons: **Approve plan — generate infrastructure code** (`action=approve_plan`, moves to Gate 2) ·
   **Reject with comment** (routes back to the planner with the comment injected as feedback, returns to
   this same gate) · **Edit parameters** (bumps replicas/memory or switches tier, re-checks
   readiness/compliance, returns to this same gate — no LLM call) · **Abandon run** (`action=abandon`,
   terminates the run immediately — see "Abandon" below, implementation-only addition not in the original spec).

## Gate 2 — Deploy Approval (`RunStatus="awaiting_approval"`)

Reached only after Gate 1's `approve_plan` — `iac_generator`/`policy_validator` have now run against the
already-approved plan.

1. **The IaC** — syntax-highlighted files; for `modify` operations, a side-by-side **diff** against the
   running environment.
2. **The commands** that will run verbatim (`apply_command`, and the `rollback_command` that guards it).
3. **Validation status** — green tick from `docker compose config -q` / `terraform validate`.
4. Three buttons: **Approve & Deploy** (`action=approve`) · **Reject with comment** (routes back to the
   planner with the comment, returns all the way to **Gate 1**, not straight back to Gate 2 — a rejected
   plan needs re-approval before new IaC is generated for it) · **Abandon run** (`action=abandon`,
   terminates the run immediately — see "Abandon" below).

## Mechanics
- On reaching either gate the orchestrator checkpoints state to the audit store and emits
  `awaiting_plan_approval` / `awaiting_approval` over WebSocket accordingly.
- UI POSTs `/api/runs/{request_id}/decision {action, comment, actor}`.
- Decision is written to the audit store **before** the graph resumes — the approval record can never be lost even if deploy crashes.
- Timeout: no decision in 30 min at **either** gate → run auto-expires as `rejected(timeout)` (nothing
  dangling) — both gates are part of the deploy-intent track, so both keep the timeout; only the plan-only
  review gate below is exempt.

## Plan-only review gate — not in the original agent set

When the request was submitted with `plan_only=true` (`CONTRACTS.md` §1), the pipeline stops after the
planner (plus `compliance_check` in Enterprise Architecture Advisor mode) at a **separate** gate instead of
this one — `RunStatus="awaiting_plan_review"`, not `"awaiting_approval"`. No `iac_generator`,
`policy_validator`, or `deploy`/`verify` ever runs for this run, so there is nothing to show beyond the plan
and (when applicable) the `ArchitectureRecommendation`.

Two differences from the two deploy gates above:
1. **No timeout.** `scheduleApprovalTimeout` is never called for this status — a plan-only run has nothing
   dangling to force a decision about, so it can sit under review indefinitely. The existing 30-min
   auto-reject timeout is unchanged and still applies to both `"awaiting_plan_approval"` and
   `"awaiting_approval"` (the deploy track).
2. **Three actions instead of four**: `accept_plan` (closes the run out with a report, `RunStatus="plan_ready"`,
   no deployment ever happens), `reject` with a comment (identical mechanism to "Reject with comment"
   above — re-runs the planner with the feedback, returns to this same gate), and `abandon` (see below).
   There is no `edit`/`approve` equivalent here since there's no IaC to edit or deploy to approve.

This exists for requests that are inherently scoping/estimation exercises — a 3-person startup idea or a
500-engineer/20-team organization sizing conversation — where generating deployable IaC and dangling a
deploy decision would be premature.

## Abandon — not in the original agent set

A fourth action, `action=abandon`, available at every gate above (both deploy-track gates and the plan-only
review gate). It exists because `reject` was ambiguous in practice: a reviewer who wanted to kill a run
outright had no way to do that short of a comment-less `reject`, which still spends another planner LLM call
and drops them right back at the same gate expecting a decision — a real run was observed sitting in
`running` for minutes after a "reject" the human intended as a stop, not a request for a revised plan.

`abandon` bypasses the planner entirely and calls the same `refuseRun` path used for an infeasible plan or a
timed-out gate — `RunStatus="refused"`, a refusal report generated immediately (the comment, if any, becomes
the refusal reason), no further LLM calls, no dangling state. Unlike the 30-minute timeout auto-reject,
`abandon` is available immediately, at every gate including the timeout-exempt plan-only review gate — the
person at the gate decides, rather than waiting out the clock.

## Demo choreography
This is the money moment. Pause here, read the reasoning aloud, point at the diff, click Approve, and let the room watch containers come up. For UC-8's refusal variant, this gate is never even reached — highlight that in the audit timeline.

## Tests (InfraGenies)
- Kill the backend while a run awaits a decision at either gate → restart → run resumes at that gate with state intact.
- Reject with comment "use 3 replicas" at Gate 2 → returns to Gate 1 → planner's next plan reflects the comment.
- Verify there is no API route or code path that reaches `iac_generator` without an `approve_plan` decision row, or `deploy` without an `approve` decision row, in the audit DB.
