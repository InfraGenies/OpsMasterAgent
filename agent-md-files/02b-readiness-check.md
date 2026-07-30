# Agent 2b — Infrastructure Readiness Check

**Owner:** InfraGenies · **LLM:** none — deterministic scan · **Executes commands:** read-only diagnostics only (`docker info`, `docker compose ps`) — never a mutating command, and never through the deploy allow-list, which exists specifically to gate commands built from `apply_command`/`rollback_command` strings · **Skills:** none

**Status:** not in the original spec set (`01`–`07`); added post-hoc, same rationale as `03b-policy-validator.md`
— `source_configuration/ops-master-agent-enhancements-proposal.md` §3 described this checkpoint with no
backing implementation. Numbered `2b` because it sits between `02-planner.md` and `03-iac-generator.md`.

## Role
Catch the class of failure that would otherwise only surface as a deploy failure + rollback several steps
later — port collisions, a stopped Docker daemon, low disk space, a topology no template covers — *before*
a human reviews the plan and *before* a single LLM call is spent on the IaC Generator.

## Input → Output
`CapacityPlan` (+ the existing environment's plan/record, for `modify`) → `ReadinessReport`
(`CONTRACTS.md` §2b).

## Checks

| name | Blocking? | How |
|---|---|---|
| `docker_daemon_reachable` | yes, only when Docker is installed | `docker info`; skipped (not blocking) if the docker CLI isn't present at all — the deploy node already simulates cleanly in that case (`nodes/dockerProbe.ts`) |
| `host_ports_free` | yes | bind-tests every new host port from `CapacityPlan.network.expose` (a throwaway `net.Server`, not a shell-out); for `modify`, only ports not already used by the environment being modified are checked |
| `disk_space_available` | yes | `fs.promises.statfs` on the server root against a 500MB floor; skipped (not blocking) if the platform can't report it |
| `template_topology_supported` | yes | today's template catalogue only covers one app service per plan (`templates/catalog.ts`) — reject more than one before wasting an LLM call that would just come back `no_template` |
| `modify_state_matches_snapshot` | **no — advisory only** | compares live `docker compose ps` output to the stored `EnvSnapshot`'s service list. See the caveat below for why this doesn't block. |

`ready = true` iff no `blocking` check has `status: "fail"`. A `skipped` check never blocks — it means
"couldn't determine this, not the plan's fault."

## A caveat on `modify_state_matches_snapshot`

Building this check surfaced a separate, pre-existing gap: `docker compose -p <project>` project names
are derived from the *current* request's ID at every call site (`nodes/iacGenerator.ts`,
`orchestrator/pipeline.ts`'s rollback path) — including for `modify`. That means each successful modify
redeploys under a **new** project name rather than the one the environment is actually running under, so
this check resolves the live project name from the environment record's own `request_id` field (the
request that most recently redeployed it — kept current by `runDeployThroughReport`'s
`upsertEnvironment` call) rather than the in-flight one. Given that underlying uncertainty, this specific
check is advisory (`blocking: false`) rather than a hard refusal — it's surfaced to the human, not hidden,
but doesn't gate the run on its own. The project-naming issue itself is a separate follow-up, not fixed
here.

## Demo hook
The phrase `"port conflict"` in the request text forces a synthetic `host_ports_free` failure
(deterministic, doesn't depend on real OS port state) — same convention as `policy_validator`'s
`"weak password"` trigger and `verify`'s `forceFail`.

## Guardrails
- No LLM call — no prompt-injection surface.
- Only read-only diagnostic commands (`docker info`, `docker compose ps`); never anything that mutates
  state, and never routed through `commandAllowList.ts` (that allow-list exists to gate LLM-influenced
  `apply_command`/`rollback_command` strings specifically, not backend-constructed diagnostic argv).
- On `ready: false`, routes to the existing `refuseRun` path — no new terminal state.

## Tests
- A clean UC-1 plan on a machine with free ports and disk space → `ready: true`, all checks `pass` or
  `skipped`.
- A request containing `"port conflict"` → `ready: false`, `host_ports_free` fails, run reaches `refused`
  with a `readiness_check` audit event recorded.
- A multi-app-service plan (today's templates can't cover it) → `template_topology_supported` fails before
  `iac_generator` is ever invoked.
