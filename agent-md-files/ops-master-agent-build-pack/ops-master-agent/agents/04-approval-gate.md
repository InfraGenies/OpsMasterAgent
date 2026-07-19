# Agent 4 — Human Approval Gate

**Owner:** Anshul (UI) + Ravikumar (interrupt wiring) · **LLM:** none — this node is human-only by design.

## Role
Hard stop before any deployment. The graph pauses (`interrupt_before=["deploy"]`), the UI presents everything a reviewer needs, and only an explicit human action resumes execution.

## What the UI must show at the gate
1. **The plan** — services table (image, cpu, memory, replicas) + the planner's reasoning paragraph.
2. **The IaC** — syntax-highlighted files; for `modify` operations, a side-by-side **diff** against the running environment.
3. **The commands** that will run verbatim (`apply_command`, and the `rollback_command` that guards it).
4. **Validation status** — green tick from `docker compose config -q` / `terraform validate`.
5. Three buttons: **Approve & Deploy** · **Reject with comment** (routes back to planner with the comment injected as feedback) · **Edit parameters** (bumps replicas/memory → re-renders template → back to this gate).

## Mechanics
- On reaching the gate the orchestrator checkpoints state to SQLite and emits `awaiting_approval` over WebSocket.
- UI POSTs `/api/runs/{request_id}/decision {action, comment, actor}`.
- Decision is written to the audit store **before** the graph resumes — the approval record can never be lost even if deploy crashes.
- Timeout: no decision in 30 min → run auto-expires as `rejected(timeout)` (nothing dangling).

## Demo choreography
This is the money moment. Pause here, read the reasoning aloud, point at the diff, click Approve, and let the room watch containers come up. For UC-8's refusal variant, this gate is never even reached — highlight that in the audit timeline.

## Tests (Anirudha)
- Kill the backend while a run awaits approval → restart → run resumes at the gate with state intact.
- Reject with comment "use 3 replicas" → planner's next plan reflects the comment.
- Verify there is no API route or code path that reaches `deploy` without a decision row in the audit DB.
