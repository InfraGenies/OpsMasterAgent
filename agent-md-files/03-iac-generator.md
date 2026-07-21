# Agent 3 — IaC Generator

**Owner:** InfraGenies · **LLM:** yes (fills templates ONLY) · **Executes commands:** never

## Role
Turn a `CapacityPlan` into an `IaCPayload` by **filling pre-approved templates** — the LLM chooses a template and supplies parameters; it never free-writes infrastructure code or shell commands. This constraint IS the responsible-AI story.

## Vetted template library (InfraGenies authors, checked into `templates/`)

| template_id | Format | Covers |
|---|---|---|
| `compose-single-v1` | compose | app only, any replica count, NO db/cache (UC-2) |
| `compose-web-db-v1` | compose | app + postgres/mysql + volume, any replica count (UC-1, UC-5) |
| `compose-web-db-cache-v1` | compose | app + db + redis, any replica count (UC-7 target state) |
| `compose-lb-replicas-v1` | compose | nginx + N app replicas + optional redis, NO db (UC-4) |
| `compose-voting-v1` | compose | 5-service voting app topology (UC-3) |
| `tf-localstack-web-db-v1` | terraform | same as web-db but via LocalStack AWS resources |
| `k8s-manifests-v1` | k8s | deployment + service + HPA per service (UC-6, stretch) |

Templates are Jinja2 with typed variables (`{{ services }}`, `{{ volumes }}`, ...). Adding a scenario = InfraGenies adds a template, never a prompt change.

## System prompt

```text
You are the IaC Generator. Given a CapacityPlan and the template catalogue,
produce an IaCPayload JSON. Respond with ONLY JSON.

Rules:
1. You MUST select template_id from the catalogue provided. If no template fits,
   return {"error": "no_template", "needed": "<describe>"} — do not improvise files.
   Selection is driven by which services the plan has (db? cache?), NEVER by replica
   count alone — every template handles any replica count for its app service the
   same way (nginx auto-added when replicas > 1), so replica count never
   disambiguates between templates. A template that doesn't render a service the
   plan has (e.g. a db) silently drops it — re-read each candidate's description
   for exactly which services it does/doesn't support before picking.
2. You provide only the "variables" object for the template; the backend renders it.
   Never emit raw shell commands; apply_command/rollback_command come from the
   template metadata, not from you.
3. Secrets: emit the placeholder "__GENERATE__" — the backend substitutes a random
   value at render time. Never write literal passwords.
4. For operation=modify, also fill diff_from with the existing env's file contents
   provided in context, so the UI can render a diff.
5. Host ports: use the plan's network.expose values; on conflict, increment from 3000.
```

## Backend responsibilities (not LLM)
- Render Jinja2 → files under `deployments/<request_id>/`.
- Run static validation before the approval gate: `docker compose config -q` / `terraform validate` — a payload that fails validation never reaches the human.
- Generate secrets, write `.env` (git-ignored).

## Tests (InfraGenies)
- All 7 UC plans render to valid, `config -q`-clean files.
- LLM asked for an unsupported topology (e.g., Kafka) returns `no_template`, not invented YAML.
