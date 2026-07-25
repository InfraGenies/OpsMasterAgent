# Data Contracts (freeze Day 1 — everything builds against these)

All inter-agent messages are one of these four JSON objects. Pydantic models in `backend/models.py` are the source of truth; this file mirrors them for humans.

## 1. PlanRequest  (intake → planner)

```json
{
  "request_id": "req-2026-0001",
  "raw_text": "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second.",
  "app_type": "web_api",
  "runtime": "nodejs18",
  "repo_url": "https://github.com/gothinkster/node-express-realworld-example-app",
  "dependencies": ["postgresql"],
  "expected_load": { "rps": 500, "concurrent_users": null },
  "environment": "staging",
  "operation": "create",
  "constraints": { "target": "compose", "max_memory_gb": 8 }
}
```

`operation`: `create | modify | destroy` — UC-7 uses `modify` with `existing_env_id`.

## 2. CapacityPlan  (planner → iac_generator, shown to human)

```json
{
  "request_id": "req-2026-0001",
  "services": [
    { "name": "api", "image": "node:18-alpine", "cpu": "1.0", "memory": "512Mi", "replicas": 2, "ports": [3000] },
    { "name": "db", "image": "postgres:16-alpine", "cpu": "1.0", "memory": "1Gi", "replicas": 1, "ports": [5432] }
  ],
  "storage": [ { "name": "pgdata", "type": "volume", "size": "1Gi", "attached_to": "db" } ],
  "network": { "expose": [{ "service": "api", "host_port": 3000 }], "internal": ["db"] },
  "reasoning": "500 rps on an Express CRUD API ≈ 250 rps/instance sustained → 2 replicas with headroom...",
  "feasible": true,
  "infeasibility_reason": null
}
```

If `feasible=false`, orchestrator routes to refusal — planner must fill `infeasibility_reason` and suggest an alternative in `reasoning`.

## 3. IaCPayload  (iac_generator → approval gate → deploy)

```json
{
  "request_id": "req-2026-0001",
  "format": "compose",
  "template_id": "compose-web-db-v1",
  "files": [
    { "path": "deployments/req-2026-0001/docker-compose.yml", "content": "services:\n  api: ..." },
    { "path": "deployments/req-2026-0001/.env", "content": "POSTGRES_PASSWORD=<generated>" }
  ],
  "apply_command": "docker compose -p req-2026-0001 up -d --wait",
  "rollback_command": "docker compose -p req-2026-0001 down -v",
  "diff_from": null
}
```

`format`: `compose | terraform | k8s`. `template_id` MUST reference a vetted template in `templates/` — the deploy agent refuses payloads with unknown template IDs. For `modify` operations, `diff_from` holds the previous env's files and the UI renders a diff.

## 4. VerifyReport  (verify → report)

```json
{
  "request_id": "req-2026-0001",
  "checks": [
    { "name": "api /api/tags HTTP 200", "status": "pass", "latency_ms": 42 },
    { "name": "db accepting connections", "status": "pass", "latency_ms": 8 }
  ],
  "smoke_test": { "tool": "k6", "target_rps": 500, "achieved_rps": 512, "p95_ms": 187, "error_rate": 0.002, "duration_s": 30 },
  "verdict": "green",
  "rolled_back": false,
  "endpoints": ["http://localhost:3000"],
  "summary": "All checks passed. Sustained 512 rps with p95 187ms (threshold 300ms)."
}
```

`verdict`: `green | red`. `red` triggers automatic rollback; `rolled_back` then flips true.

## Audit event (every node writes one)

```json
{
  "event_id": 1043,
  "request_id": "req-2026-0001",
  "ts": "2026-07-17T10:31:02Z",
  "node": "deploy",
  "actor": "agent|human",
  "input_digest": "sha256:...",
  "output_digest": "sha256:...",
  "command_executed": "docker compose -p req-2026-0001 up -d --wait",
  "status": "success",
  "detail": "3 containers healthy in 38s"
}
```
