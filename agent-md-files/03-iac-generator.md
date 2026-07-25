# Agent 3 — IaC Generator

**Owner:** InfraGenies · **LLM:** yes (fills templates ONLY) · **Executes commands:** never

## Role
Turn a `CapacityPlan` into an `IaCPayload`, preferring **pre-approved templates** when one fits — the LLM
chooses a template and supplies parameters, same as the original design. **Divergence from the original
spec** (not in the initial agent set): when nothing in the template catalogue covers the topology, the LLM
may instead write the IaC files directly (`{format, files}`, see `skills/writing-compose-iac.md` /
`writing-terraform-iac.md` / `novel-requirement-reasoning.md`), rather than only ever refusing with
`no_template`. The responsible-AI invariant this constraint protects is unchanged either way: the LLM never
free-writes shell commands, and `apply_command`/`rollback_command` always come from backend code (see
`commandAllowList.ts`), never the model — confirmed those command strings are format-generic, not
template-specific, so this addition needed zero changes to the command allow-list. Freeform output is
flagged distinctly at the approval gate (`template_id: "freeform"`) so a human reviewer knows it wasn't
produced by a pre-validated rendering path and reviews it more carefully, not less.

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

`iacGenerator.ts` appends the `writing-compose-iac`, `writing-terraform-iac`, and
`novel-requirement-reasoning` skills (`agent-md-files/skills/`) after this block at runtime, always — this
node can't know in advance whether a request will match the catalogue or fall through to writing files
directly.

```text
You are the IaC Generator. Given a CapacityPlan and the template catalogue,
produce an IaCPayload JSON. Respond with ONLY JSON.

Rules:
1. Try the catalogue first — select template_id from the catalogue provided when its
   description says it covers this plan's services. Selection is driven by which
   services the plan has (db? cache?), NEVER by replica count alone — every template
   handles any replica count for its app service the same way (nginx auto-added when
   replicas > 1), so replica count never disambiguates between templates. A template
   that doesn't render a service the plan has (e.g. a db) silently drops it — re-read
   each candidate's description for exactly which services it does/doesn't support
   before picking.
   If nothing in the catalogue covers this topology, write the files directly instead
   (see the novel-requirement-reasoning skill below) — reserve
   {"error": "no_template", "needed": "<describe>"} for requests genuinely outside
   this platform's scope entirely, not just "no exact template match."
2. Catalog path: provide only the "variables" object for the template; the backend
   renders it. Freeform path: provide "files" directly (see below). Either way, never
   emit raw shell commands; apply_command/rollback_command always come from backend
   code, never from you.
3. Secrets: emit the placeholder "__GENERATE__" (or "__GENERATE__:NAME__" to reuse the
   same generated value across multiple files/variables) — the backend substitutes a
   real random value before anything touches disk. Never write literal passwords.
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
