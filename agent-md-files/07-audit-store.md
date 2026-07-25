# Component 7 — Audit Store & Reporting

**Owner:** InfraGenies · **LLM:** report narrative only

## Do we need a database? — Decision

**Yes, but only SQLite — no database server, no IS approval, no installation.**

| Need | Solution | External DB needed? |
|---|---|---|
| Audit trail (every action logged) | SQLite file `audit.db` via SQLAlchemy | ❌ (bundled with Python) |
| LangGraph state persistence / resume-after-restart at approval gate | Same SQLite file via `SqliteSaver` checkpointer | ❌ |
| Environment registry (what's running, for UC-7 modify) | Table in the same SQLite file | ❌ |
| Demo apps' own databases (Postgres/MySQL/Redis) | Containers **provisioned by the agent itself** — they're the *product*, not our dependency | ❌ |

So: one `audit.db` file covers state + audit + registry. Postgres for the platform itself would be justified only in a real product pitch slide ("productionised with RDS") — say that verbally, don't build it. Everything else the platform needs is achieved with agents + templates ("skills"), exactly as suspected.

## Schema (SQLAlchemy)

```sql
CREATE TABLE runs (
  request_id TEXT PRIMARY KEY, raw_text TEXT, operation TEXT,
  status TEXT,                -- running|awaiting_approval|deployed|failed|rolled_back|refused
  created_at TEXT, finished_at TEXT
);
CREATE TABLE audit_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT REFERENCES runs, ts TEXT, node TEXT,
  actor TEXT,                 -- agent|human
  input_json TEXT, output_json TEXT,
  command_executed TEXT, status TEXT, detail TEXT
);
CREATE TABLE environments (
  env_id TEXT PRIMARY KEY, request_id TEXT, name TEXT,
  target TEXT, files_json TEXT, endpoints_json TEXT,
  state TEXT                  -- up|down|rolled_back
);
```

## Rules
- Audit writes happen in the orchestrator's `with_audit` decorator — agents cannot skip logging.
- Store full prompt/response JSON (synthetic data only, so no privacy concern) — judges love clicking into "what did the AI actually say".
- The final **Deployment Report** = LLM narrative over (`runs` + `audit_events` + `VerifyReport`), rendered in UI with a timeline component and exportable as Markdown.

## Timeline UI (InfraGenies)
Vertical timeline per run: node icon, timestamp, duration, actor badge (🤖/🧑), expandable raw JSON, red/green status. This single screen is the governance story — keep it on screen during the whole demo.
