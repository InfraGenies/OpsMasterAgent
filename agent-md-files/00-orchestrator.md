# Agent 0 — Orchestrator (LangGraph state machine)

**Owner:** InfraGenies · **Type:** code, not prompt — this is the graph itself, no LLM call of its own.

## Role
Owns the state machine: routes `intake → planner → iac_generator → approval_gate → deploy → verify → report`, with conditional edges to `refuse` and `rollback`. Persists state after every node via the SQLite checkpointer so the approval gate survives restarts.

## Responsibilities
- Build the LangGraph `StateGraph` over a single shared `PipelineState` (holds `PlanRequest`, `CapacityPlan`, `IaCPayload`, `VerifyReport`, `audit_events[]`).
- Implement `interrupt()` at the approval gate; resume on the human's approve/reject action from the UI.
- Write an audit event after **every** node (success or failure) — no node is trusted to log itself.
- Stream node progress to the UI over WebSocket (`node_started`, `node_finished`, `awaiting_approval`, `log_line`).
- Enforce timeouts per node (planner 60s, deploy 180s, verify 120s) → timeout routes to `rollback`.

## Skeleton (backend/graph.py)

```python
from langgraph.graph import StateGraph, END
from langgraph.checkpoint.sqlite import SqliteSaver

g = StateGraph(PipelineState)
for name, fn in [("intake", intake), ("planner", planner), ("iac_generator", iac_gen),
                 ("approval_gate", approval_gate), ("deploy", deploy),
                 ("verify", verify), ("rollback", rollback), ("report", report)]:
    g.add_node(name, with_audit(fn))          # decorator writes audit event

g.set_entry_point("intake")
g.add_conditional_edges("intake", lambda s: "planner" if s.request.feasible_input else "report")
g.add_edge("planner", "iac_generator")
g.add_edge("iac_generator", "approval_gate")   # approval_gate calls interrupt()
g.add_conditional_edges("approval_gate", lambda s: "deploy" if s.approved else "planner")
g.add_conditional_edges("deploy", lambda s: "verify" if s.deploy_ok else "rollback")
g.add_conditional_edges("verify", lambda s: "report" if s.report.verdict == "green" else "rollback")
g.add_edge("rollback", "report")
g.add_edge("report", END)

app = g.compile(checkpointer=SqliteSaver.from_conn_string("audit.db"), interrupt_before=["deploy"])
```

## Guardrails
- The graph, not the LLM, decides routing. LLM outputs are parsed into Pydantic models; parse failure = one retry with the validation error appended, then route to `report` as failed.
- `interrupt_before=["deploy"]` is a hard stop — there is no code path to `deploy` without a checkpoint resume triggered by the human.
