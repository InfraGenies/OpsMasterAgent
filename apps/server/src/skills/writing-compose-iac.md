# Skill — Writing Compose IaC From Scratch

Runtime copy of the fenced block in `agent-md-files/skills/writing-compose-iac.md`.

```text
When you write docker-compose files directly (no catalog template fits), follow these conventions —
they're the same ones every vetted template already uses, so your output stays consistent with them:

- One service per component. `restart: unless-stopped` on every service.
- Every service gets a `healthcheck`: HTTP services use `wget -q --spider http://localhost:<port>/<path>`
  (or the request's stated health path); PostgreSQL uses `pg_isready -U <user>`; MySQL uses
  `mysqladmin ping`; Redis uses `redis-cli ping`. Give every healthcheck `interval: 5s`, `timeout: 3s`,
  `retries: 10`, and `start_period: 10s` for app-tier services.
- Size CPU/memory via `deploy.resources.limits.cpus`/`memory`, and replica count via `deploy.replicas` —
  match whatever the CapacityPlan already specified for that service, never invent your own sizing.
- Stateful services (db/cache) get a named top-level `volumes:` entry and a bind under the service's own
  `volumes:` list; stateless app services never get a volume unless the plan says so.
- THE NGINX RULE: whenever a service's replica count is > 1, you MUST front it with an nginx sidecar
  instead of publishing its port directly — plain `docker compose up` cannot bind one fixed host port
  across N replicas of the same service. Add an `nginx` service (`image: nginx:alpine`, publish the host
  port on nginx instead of the app, `depends_on: { <app>: { condition: service_healthy } }`,
  `volumes: ["./nginx.conf:/etc/nginx/nginx.conf:ro"]`) plus a companion `nginx.conf` file with a single
  upstream block proxying to the app's container port (Docker's embedded DNS returns one A record per
  replica, so a static upstream naming the service by name round-robins across whatever's up).
- Wire `depends_on` with `condition: service_healthy` between an app and any db/cache it needs, so the app
  doesn't start before its dependency is ready.
- Secrets: NEVER write a literal password/secret value. Use the placeholder `__GENERATE__` for a one-off
  secret, or `__GENERATE__:NAME__` (e.g. `__GENERATE__:DB_PASSWORD__`) when the same secret is referenced
  in more than one place (e.g. a DB password used in both the app's connection string and the db service's
  own env) — the backend resolves these to one consistent random value per NAME before writing files to
  disk, and to independent values for each bare `__GENERATE__`.
- Host ports: use the plan's `network.expose` values; on conflict, increment from 3000.
- Emit exactly one `docker-compose.yml` at the deployment root, plus any companion files (like `nginx.conf`)
  it references by relative path.
```
