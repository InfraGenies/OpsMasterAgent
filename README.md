# Ops Master Agent

Implementation of the **Hackathon Theme 4 — Ops Master Agent (Infra Lifecycle Automation)** brief in
[`agent-md-files/`](agent-md-files/): one sentence → capacity plan → IaC → human approval → live deployment →
verified report, fully audited.

The spec in `agent-md-files/` is written for a Python/LangGraph/SQLite stack. This build implements the same
architecture — same state machine, same 4 data contracts, same safety rules — in **Node.js/TypeScript**, with
**Supabase (Postgres)** as the audit/state store, per steer from the repo owner. See [Architecture decisions](#architecture-decisions)
for what changed and why.

## Repo layout

```
apps/
  server/    Express + WebSocket orchestrator (the pipeline itself)
  web/       React + Tailwind chat/approval/audit UI
packages/
  shared/    Zod contracts shared by both apps (mirrors agent-md-files/CONTRACTS.md)
supabase/
  schema.sql Run this once in your Supabase project's SQL editor
agent-md-files/  Original spec — source of truth for prompts, sizing rules, contracts
```

## Setup

### Quick start (Windows / PowerShell)

```powershell
npm start
```

Or double-click **`start-app.cmd`** (Explorer opens `.ps1` files in Notepad by default, not PowerShell —
`start-app.cmd` is a thin wrapper that actually runs `start-app.ps1`, with `-ExecutionPolicy Bypass` so it
works even on a machine that has never touched PowerShell's script-execution policy before). Either way,
this one command: checks Node.js is installed (18+), warns (non-fatally) if Docker isn't, runs
`npm install` if `node_modules` is missing, builds `@ops-master/shared`, creates a working
`apps/server/.env` in mock mode if none exists yet, then starts both the server (`:4100`) and web UI
(`:5173`) in the background and opens your browser once the server reports healthy. **No API keys or
Supabase project required to get a running app** — everything works in mock/local-store mode out of the
box; fill in real keys in `apps/server/.env` whenever you're ready (see below), no need to re-run the
script. This is the full, verified path for someone cloning the repo for the first time — no prior
`node_modules`/`.env`/build required.

```powershell
npm stop
```

Or double-click **`stop-app.cmd`** / run `.\stop-app.ps1` — stops both processes (and their child
processes; `npm`/`tsx`/`vite` fan out into several node processes on Windows, so this kills the whole tree
via `taskkill /T`, not just the top PID), and as a fallback frees ports 4100/5173 if anything's still bound
to them. Safe to run `npm start` again any time — it stops any previous instance first. Logs land in
`.run/server.log` and `.run/web.log`.

### Manual setup (any OS)

```bash
npm install
npm run build -w @ops-master/shared   # required once before first dev:server / dev:web
cp apps/server/.env.example apps/server/.env
```

Fill in `apps/server/.env`:
- `ANTHROPIC_API_KEY` — from console.anthropic.com. **Optional for now**: if left blank, the server
  auto-enables `MOCK_LLM` and every LLM call is replaced with a deterministic stand-in (see
  [Mock mode](#mock-mode-no-api-key-needed)), so you can run the whole pipeline before wiring a real key.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — create a free project at supabase.com, then
  **Project Settings → API Keys**. Use the **secret** key (`sb_secret_...` on newer projects, or the
  legacy `service_role` JWT on older ones) — **not** the publishable/anon key, which RLS blocks from
  every table by design. Also **optional for now**: if left blank, the server falls back to a local
  JSON file (`apps/server/data/local-store.json`) so you can run and demo everything without a Supabase
  project. Fill these in when you want real, durable, shared persistence.

If you do set up Supabase, run [`supabase/schema.sql`](supabase/schema.sql) once in the SQL editor —
it creates `runs`, `audit_events`, `environments`, `decisions` with RLS enabled and no anon policies
(the server only ever talks to it with the secret key, which bypasses RLS; nothing is reachable
from a browser).

```bash
# terminal 1
npm run dev:server     # http://localhost:4100

# terminal 2
npm run dev:web         # http://localhost:5173
```

Open http://localhost:5173, type a request, submit, and watch the pipeline run.

### Smoke test (no browser, no Docker required)

```bash
npm run smoke -w @ops-master/server
```

Runs UC-2, UC-8a (refusal), an adversarial prompt-injection attempt, and UC-1 end-to-end in-process, printing
the rendered `docker-compose.yml` and the audit trail. Deploy/rollback will legitimately fail here if
Docker Desktop isn't installed on the machine running the server — that's expected and still proves the
allow-list + rollback code path executes correctly; it just isn't a live container.

## What each demo scenario needs

| UC | Try it with | Needs Docker running? |
|---|---|---|
| UC-2 (simple) | "Spin up a dev environment for a simple Node.js todo app, low traffic, single instance." | for real deploy |
| UC-1 (flagship) | "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second." | for real deploy |
| UC-7 (modify) | Deploy UC-1 first, then: "Add a Redis cache to the staging environment we just created and wire the app to it." | for real deploy |
| UC-8 (refusal) | "Provision production with 50,000 req/s and five-nines availability." | no — refused before any template is rendered |
| UC-8 (rollback) | Approve any plan without Docker Desktop running | no — this **is** the rollback demo |
| UC-9 (AWS, plan-only — default) | "Deploy the retail-store-sample-app to AWS for a staging environment..." | no — `terraform plan` only |
| UC-9 (AWS, real apply) | Same request, with `ALLOW_AWS_APPLY=true` set (demo machine only) | needs `terraform` CLI + AWS credentials — see the eleventh addition below |
| UC-15 (static frontend) | "Spin up a dev environment for a static React frontend built with Vite, no backend needed." | for real deploy |
| UC-16 (live hostname demo) | "Give me a quick live demo endpoint that shows the container's own hostname on every request." | for real deploy |

Install Docker Desktop per `agent-md-files/INSTALLATION.md` for the live-deploy demos; the pipeline logic
(intake → planner → IaC → approval → audit) runs and is fully demoable without it.

## Project status

Every node in the [spec-to-code table](#where-each-spec-agent-lives-in-code) below is implemented. Status
per demo use case (see `agent-md-files/USE_CASES.md` for the full scenario descriptions):

| UC | Scenario | Status |
|---|---|---|
| UC-1 | Flagship: Node.js + PostgreSQL @ 500 rps | Working end-to-end (real clone/build, live deploy, k6-style verify); exercised by `npm run smoke` |
| UC-2 | Simple: RealWorld fullstack dev env | Working end-to-end; exercised by `npm run smoke` |
| UC-3 | Multi-service voting app (5 containers) | Topology supported by the planner/compose builder; not in the smoke script — manual UI demo only |
| UC-4 | Scale-out: LB + N replicas | Supported via `compose-lb-replicas-v1` + the nginx-sidecar rule; manual UI demo only |
| UC-5 | Spring Boot + MySQL (JVM sizing) | Sizing rule implemented; no dedicated build-registry entry, so this is manual UI demo only |
| UC-6 | Kubernetes / Minikube | Not built — scope cut, see [Architecture decisions](#architecture-decisions) |
| UC-7 | Modify existing environment | Working end-to-end (plan merge + diff view); manual UI demo |
| UC-8 | Refusal + rollback (responsible-AI) | Working end-to-end; refusal path exercised by `npm run smoke`, rollback is a manual no-Docker demo |
| UC-9 | AWS/Terraform multi-tier costing | Runnable, plan-only by default (`terraform init`/`validate`/`plan`); exercised by `npm run smoke`. `ALLOW_AWS_APPLY=true` (demo-machine-only, off everywhere else) additionally allows a real `apply`/`destroy` — see the eleventh addition below |
| UC-13 | Scoping narrative + turnaround estimate (3-developer startup) | Working end-to-end in mock mode; manual UI demo (not in `npm run smoke`) |
| UC-14 | AWS single container + ALB (aws-copilot-sample) | `BUILD_REGISTRY` entry wired (docker-compose path runnable); real AWS Fargate+ALB still needs a hand-rolled Terraform template (no bundled module to wrap, unlike UC-9) — see `USE_CASES.md` UC-14. Not in `npm run smoke` |
| UC-15 | Static frontend, no backend/DB (vite-react-docker) | Working via docker-compose (`compose-single-v1`); proves the build-sentinel path generalizes beyond the UC-1/UC-2 RealWorld pair. Not in `npm run smoke` — manual UI demo |
| UC-16 | Live hostname demo, subfolder Dockerfile (nginx-hello) | Working via docker-compose; first build-sentinel entry whose Dockerfile isn't at the repo root (`BuildRegistryEntry.dockerfileSubdir`). Not in `npm run smoke` — manual UI demo |
| Enterprise Architecture Advisor mode | `compliance_check` + managed-controls reasoning (PCI-DSS payment platform, solo MVP, enterprise rescale, and one held-out generalization scenario) | Working; exercised by 4 scenarios in `npm run smoke` beyond the numbered UC set |

Two of the rows above (UC-9's AWS/Terraform path and Enterprise Architecture Advisor mode) are real, working
features that predate this doc pass but were never called out as their own entries in
[Architecture decisions](#architecture-decisions) — see the seventh and eighth additions there. Every
tier in every row above also now carries the scoping/ROI narrative described in the ninth addition.

**Recent reliability hardening**, found and fixed while running the smoke test against a real LLM
provider — small, but worth tracking since each closes a real observed failure, not a hypothetical one:
- `deploy.ts` retries once, after a 3s pause, when a `docker compose up` failure looks transient (port
  still releasing, an image-pull timeout, a flaky registry blip) — matched against a fixed set of patterns;
  a genuine config/payload error fails identically on retry, so this never masks a real problem.
- `intake.ts` now deterministically corrects `constraints.target`'s aws-vs-compose choice with a keyword
  check instead of trusting the model's classification — confirmed live that the same request text was
  classified differently across runs. `enterprise_mode` requests are always forced to `target: "aws"`
  outright, since the Enterprise Architecture Advisor always recommends AWS-shaped infrastructure regardless
  of literal wording.
- `policyValidator.ts` gained a `checkResilience` rule (missing healthcheck/restart policy) scoped to
  freeform IaC payloads only — catalog-rendered payloads always have both from fixed template code, so
  checking those would just be a regression guard on code already controlled elsewhere.
- `anthropicProvider.ts`/`bedrockProvider.ts`'s `max_tokens` raised 8192→16000 after confirming live that
  the Enterprise Architecture Advisor's largest outputs (a 15-step `task_graph` plus
  `alternatives_considered` plus `managed_controls` reasoning) still truncated mid-JSON at 8192.

## Mock mode (no API key needed)

`MOCK_LLM=true`, or simply leaving `ANTHROPIC_API_KEY` blank, swaps every Claude call for a deterministic
stand-in that follows the same sizing rules and template-selection logic described in the prompts
(`apps/server/src/nodes/*.ts`, the `mock*` functions). This is what the smoke test runs under. It's meant
for offline development and CI, not the real demo — flip on a real `ANTHROPIC_API_KEY` for judges to see
the actual LLM reasoning (shown verbatim in the audit timeline either way).

## Deploying to AWS

Terraform + a GitHub Actions pipeline to self-host this app (not to be confused with
`apps/server/src/templates/terraformCatalog.ts`, which is IaC *this product generates for end users* who
ask it to deploy something else — those stay deliberately separate) live in [`infra/aws/`](infra/aws/);
[`infra/aws/README.md`](infra/aws/README.md) is the step-by-step bootstrap runbook. Summary:

**Architecture**: one ECS Fargate task (0.5 vCPU / 1GB) runs a single container — Express serves the
API/WebSocket (`/api/*`, `/ws`) *and* the built React static files (`apps/web/dist`) with an SPA
fallback (`apps/server/src/index.ts`), so there's one origin, no CORS, no separate CloudFront/S3. An ALB
(HTTP only — no custom domain/ACM by default) fronts it on the account's default VPC public subnets; the
Fargate task gets a public IP directly rather than sitting behind a NAT Gateway (saves ~$32/mo — nothing
in the container needs a stable private egress path). Supabase is unchanged; only its service-role key
moves from the local `.env` file to AWS Secrets Manager.

```
GitHub push to main → GitHub Actions (OIDC, no stored AWS keys)
  → build+typecheck+smoke → docker build → push to ECR
  → register new ECS task definition → update ECS service → wait for stability
                                                    ↓
                          ALB (public, HTTP) → Fargate task (public subnet, public IP)
                                                    ↓
                                        Supabase (unchanged, external)
```

**CI/CD**: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR/push to `main` —
`npm ci && npm run build && npm run typecheck && npm run smoke -w @ops-master/server` — the smoke script's
mock mode means this needs zero AWS/Anthropic/Supabase access.
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the same gate, then authenticates to
AWS via **GitHub OIDC** (no AWS access keys stored in GitHub at all), builds/pushes the image to ECR, and
rolls out a new ECS task definition, waiting for the service to stabilize.

**Credentials & config**:

| Concern | Where it lives |
|---|---|
| Local dev secrets | `apps/server/.env` (gitignored) — unchanged |
| CI (`ci.yml`) | Nothing — runs in mock mode |
| GitHub → AWS auth (`deploy.yml`) | GitHub OIDC → IAM role (`infra/aws/iam-oidc.tf`) — no stored AWS keys |
| `ANTHROPIC_API_KEY` / `AWS_BEARER_TOKEN_BEDROCK` / `SUPABASE_SERVICE_ROLE_KEY` (runtime) | AWS Secrets Manager, injected into the ECS task as `secrets` — never in the image or GitHub |
| `SUPABASE_URL`, `DEPLOY_TARGET`, `MOCK_DEPLOY`, etc. | Plain env vars in the ECS task definition (not secret) |
| `ALLOW_AWS_APPLY` | Hardcoded `false` in the ECS task definition — the hosted instance must never `terraform apply`/`destroy` against the AWS account it runs in, same guidance as the rest of this doc |
| Docker-compose deploy track (UC-1/2/3/4/7/13 etc.) when hosted | Automatically simulated — Fargate has no Docker daemon, and `MOCK_DEPLOY=auto` already detects that and labels those runs `SIMULATED`, exactly like a judge's laptop without Docker Desktop |

**Estimated cost** (`us-east-1`, always-on): Fargate task ~$18/mo + ALB ~$20/mo + Secrets Manager (3
secrets) ~$1.20/mo + ECR/CloudWatch Logs ~$2/mo ≈ **~$41-45/mo**. `terraform apply -var desired_count=0`
between demos drops it to just the ALB (~$20/mo); `terraform destroy` drops it to $0. See
`infra/aws/README.md`'s "Cost control between demos" section.

## Architecture decisions

The brief's own docs (`agent-md-files/README.md`) describe a Python + LangGraph + FastAPI + SQLite stack.
Given the steer toward Node/TypeScript/React/Supabase, here's what this build does differently, and why:

| Spec says | This build does | Why |
|---|---|---|
| LangGraph (Python) state machine + `SqliteSaver` checkpointer | Hand-rolled TypeScript pipeline (`apps/server/src/orchestrator/pipeline.ts`) where **every cross-node handoff is read back from the audit trail**, not from in-memory state | Genuinely stronger for the "resume after restart" requirement in `04-approval-gate.md`: the approval-gate POST handler rehydrates `PlanRequest`/`CapacityPlan`/`IaCPayload` straight from `audit_events.output_json`, so a decision arriving after a server restart works with **zero** in-memory state to have lost. A suspended-Promise design (closer to literal LangGraph `interrupt()`) would have made that test case fragile instead of trivially true. |
| SQLite audit/state store | Supabase Postgres (`apps/server/src/store/supabaseStore.ts`), same 4 tables from `07-audit-store.md` plus `decisions` | Per your steer. RLS is enabled with no policies — the server's service-role key bypasses RLS, nothing is reachable from a browser. A local JSON-file store (`store/localStore.ts`) is the dev/offline fallback. |
| k6 in a container, `docker run --network host` | `autocannon` (pure Node, `nodes/verify.ts`) | `--network host` is a Linux-only Docker trick — Docker Desktop on Windows/Mac runs containers in a VM where it doesn't pass through, so the spec's own k6 invocation wouldn't work on the Windows box this was built on. Autocannon reports the same rps/p95/error-rate shape with no extra install. Its closest percentile bucket to p95 is p97.5, used as a (slightly conservative) stand-in — noted in code. |
| Jinja2 templates (`templates/*.j2`) | Typed TS builder functions + `js-yaml` (`apps/server/src/templates/`) | Same contract (LLM picks `template_id` + fills a `variables` bag; backend renders, never the model) — just typed instead of string-templated. |
| Terraform / Kubernetes formats, UC-3 (voting app), UC-5 (Spring Boot), UC-6 (Minikube) | Not built | Scope cut to match the spec's own "minimum viable demo set: UC-1, UC-2, UC-7, UC-8" and "UC-6 only after UC-1–4 are rock solid." Compose-only covers 4 of 7 templates (`compose-single-v1`, `compose-web-db-v1`, `compose-web-db-cache-v1`, `compose-lb-replicas-v1`); adding Terraform/K8s renderers or the 5-service voting topology is straightforward follow-up work in `templates/catalog.ts` but wasn't in scope here. |
| Nginx LB "added automatically when replicas > 1" (`02-planner.md`) | Same rule, but folded directly into `compose-web-db-v1` / `compose-single-v1` rendering rather than a separate template pick | Plain `docker compose up` (no Swarm) can't bind one fixed host port across N replicas of the same service — there's no built-in ingress mesh. Nginx fronts the service instead, resolved once at container start; Docker's embedded DNS returns one A record per replica, so a static upstream still round-robins across whatever's up at deploy time. This is what makes UC-1's 500rps→2-replica plan (which triggers the nginx rule) actually deployable with the same template used for 1-replica cases. |

Everything else matches the spec directly: the JSON contracts (`packages/shared/src/contracts.ts` mirrors
`CONTRACTS.md` exactly), the node responsibilities and LLM/no-LLM boundaries per node, the hard command
allow-list (`nodes/commandAllowList.ts`, `argv` arrays via `spawn`, never `shell: true`), the two safety
rules from `WORKFLOW.md` (LLM never writes shell commands; nothing deploys without a human decision row),
and the audit event shape.

Two nodes were added beyond the original `01`–`07` spec set: `readiness_check`
(`agent-md-files/02b-readiness-check.md`), a deterministic pre-flight scan (docker daemon, host ports, disk
space, template topology) that runs before a single LLM call is spent on `iac_generator`; and
`policy_validator` (`agent-md-files/03b-policy-validator.md`), a deterministic security/policy scan with a
bounded self-correction loop back to `iac_generator`. Both close real gaps —
`source_configuration/ops-master-agent-solution.md` §3/§4 describe these checkpoints as part of the pitch,
but no code implemented them. See each `*.md` for exactly what it checks, what it can and can't auto-fix,
and why (`readiness_check`'s doc also flags a separate pre-existing gap in how `modify` names its compose
project, found while building its drift check — not fixed there, noted as a follow-up).

A third addition beyond the spec: a **plan-only track** (`PlanRequest.plan_only`, `RunStatus`
`awaiting_plan_review`/`plan_ready`, `orchestrator/pipeline.ts: reachPlanReviewGate`/`finalizePlanOnly`, UI:
`web/src/components/PlanReviewGate.tsx`). Set via a UI toggle at submission, it stops the pipeline after the
planner (plus `compliance_check` in Enterprise Architecture Advisor mode) — no `iac_generator`,
`policy_validator`, or `deploy`/`verify` ever runs, and unlike the deploy-approval gate there is no 30-minute
auto-reject timeout, since a plan-only run has nothing dangling to force a decision about. This exists for
scoping/estimation requests (a small-team app idea, a large-org sizing conversation) where generating
deployable IaC would be premature — see `04-approval-gate.md`'s "Plan-only review gate" section.

A fourth addition: the deploy track's single approval gate is now **two sequential gates**
(`orchestrator/pipeline.ts: reachPlanApprovalGate` / `reachApprovalGate`, `RunStatus`
`awaiting_plan_approval` → `awaiting_approval`, UI: `web/src/components/PlanApprovalGate.tsx` /
`ApprovalGate.tsx`). Gate 1 approves the capacity plan itself (`readiness_check`/`compliance_check` already
ran, no IaC exists yet); only on approval does `iac_generator`/`policy_validator` run, reaching Gate 2 to
approve the actual generated code and deploy commands. Rejecting at either gate always returns to Gate 1,
never straight back to Gate 2 — a changed plan needs re-approval before new IaC is generated for it. Both
gates keep the 30-minute auto-reject timeout (both are part of the deploy-intent track); only the
plan-only track's review gate is exempt. See `04-approval-gate.md`'s "Gate 1"/"Gate 2" sections.

A fifth addition: a **skills library** (`agent-md-files/skills/*.md`, runtime copies under
`apps/server/src/skills/`, loaded via `llm/skillLoader.ts`) — reusable knowledge modules (sizing formulas,
AWS managed-service substitution, compliance/DR reasoning, IaC-writing conventions) spliced into node
prompts at runtime instead of duplicated inline text, so a capability can be edited in one place regardless
of how many nodes use it. This also underpins **freeform IaC generation**: `iac_generator` now tries the
template catalogue first, and when nothing covers a request's topology, writes the IaC files directly
(`template_id: "freeform"`) rather than only ever refusing — informed by the `writing-compose-iac`/
`writing-terraform-iac`/`novel-requirement-reasoning` skills, validated by the same `docker compose config
-q`/`terraform validate` checks the catalogue path already used, self-corrected through the existing
`policy_validator` retry loop (`checkStructural`'s `auto_fixable` now flips to `true` specifically for
freeform payloads), and flagged distinctly at the approval gate so a human reviews it more carefully, not
less. `apply_command`/`rollback_command` are still never produced by the LLM in this path either — derived
generically from `format` + project name, matching the exact literal strings `commandAllowList.ts` already
expects, so no allow-list change was needed.

A sixth addition: a **`build` node** (`apps/server/src/nodes/build.ts`, run from
`orchestrator/pipeline.ts: runDeployThroughReport` between Gate 2 approval and `deploy`) that clones and
builds a real application from source for UC-1's flagship request (and, since then, the default fallback
for *any* generic Node.js request with no repo/app named — see below), instead of the placeholder runtime
image every other compose template uses (`node:18-alpine` with no app code — deployable, but not the
credible reference API UC-1 is meant to demonstrate). Security follows the same discipline as
`commandAllowList.ts`'s existing hard allow-list: the planner can only ever emit a `"__BUILD__:<key>"`
sentinel for a service's `image` (mirroring the existing `"__GENERATE__"` secret sentinel in
`templates/secrets.ts`) — never a real repo URL — and `nodes/buildRegistry.ts` is the sole, hardcoded,
developer-reviewed table mapping that sentinel to an actual repo pinned to an exact commit (never a
floating branch), with `commandAllowList.ts` deriving its git-clone/checkout rules directly from that
table. Getting the RealWorld Node/Express/Prisma reference app (`gothinkster/node-express-realworld-example-app`)
actually running took three separate, non-obvious fixes layered on top of the repo's own Dockerfile,
documented in full in `buildRegistry.ts`'s `dockerfileOverride` doc comment: `prisma generate` has to run
inside the same Linux/musl target the engine binary will actually execute on (not the build host); Prisma's
own platform auto-detection is unreliable on this Alpine base and has to be forced via a schema-level
`binaryTargets` patch; and the *client's* runtime engine selection is separately broken the same way,
requiring `PRISMA_QUERY_ENGINE_LIBRARY` to bypass auto-detection entirely at the container level. Confirmed
by manually running the built image standalone until `/api/tags` returned `{"tags":[]}`, then via a full
live pipeline run reaching `deployed` with a green `verify` report. Every other use case's `IaCPayload.build_steps` stays `null`, and behavior for them is unchanged.

**Update:** `buildRegistry.ts` now has a second entry, `realworld-react-frontend` (paired with the backend
above via a `pairedWith` field), so `docker/welcome-to-docker` is no longer the default for a generic
Node.js request with no repo/app named — it's reserved for non-Node runtimes now. `iacGenerator.ts` loops
over every build-sentinel service in a plan (not just the first) and renders both through a new
`compose-realworld-fullstack-v1` template (`templates/catalog.ts`), giving a real, browser-rendered login
page instead of a placeholder. The frontend is `react-scripts@1.1.1` (2018-era CRA) with no env-var
mechanism for its API base URL — `iac_generator` `sed`-patches a placeholder token in `src/agent.js` to the
real, resolved backend host-port URL at plan-render time. Confirmed by building the frontend in isolation
first: `node:16-alpine` (not `node:lts-alpine`) ships pre-OpenSSL-3 and needed zero extra flags to build
cleanly, and the pinned backend commit's `app.use(cors())` (no origin restriction) needed no changes for
the cross-port browser calls to work. `IaCPayload.dockerfile_override`/`health_path` both changed from a
single scalar to a map (keyed by clone-dir and service name respectively) to support two build-sentinel
services in one plan; `pipeline.ts`/`verify.ts` similarly changed from a single endpoint+health-path to one
pair per app-classified service.

A seventh addition: **multi-tier capacity planning + an AWS/Terraform template family** (UC-9). `planner.ts`
now emits `CapacityPlan.options: CapacityPlanOption[]` (economy/balanced/high_availability, or just
economy/high_availability when `constraints.target === "aws"`) instead of one flat plan, each tier priced
(`estimated_cost_usd_monthly`) and reasoned independently. For an AWS-targeted request, `iac_generator` picks
from `templates/terraformCatalog.ts` (`tf-ecs-fargate-v1` / `tf-eks-v1`) instead of the compose catalogue,
filling the repo's own bundled Terraform modules rather than hand-rolled resources — same "LLM picks a
template, backend renders" discipline as compose, extended to `IaCPayload.format: "terraform"`.
`commandAllowList.ts` permits `terraform init`/`validate`/`plan` only — `apply`/`destroy` are deliberately
absent from the allow-list, so there is no code path from this UC to a real AWS account; "deploy" always
resolves to a plan-only, `SIMULATED`-labeled outcome. See `USE_CASES.md` UC-9 for the worked cost comparison.

An eighth addition: **Enterprise Architecture Advisor mode** (`agent-md-files/02c-compliance-check.md`,
not in the original agent set). `intake` detects business-context signals in `raw_text` (compliance target,
team size, RPO/RTO, industry domain) and, only when found, sets `PlanRequest.enterprise_mode` +
`enterprise_context`; the planner then produces one `ArchitectureRecommendation` per request (not per
tier) via `nodes/enterpriseRulesEngine.ts` — an `org_scale`-driven platform archetype, a weighted
`criticality_band` score that adds security/DR controls, and framework-driven mandatory controls from
`compliance_targets`, deduplicated into one `managed_controls` list (each priced via
`templates/enterpriseCatalog.ts`). `nodes/complianceCheck.ts` then runs once, pre-flight (alongside
`readiness_check`, before `iac_generator`), checking those controls against a per-framework mandatory-control
list and surfacing any `gap` as a visible warning at the approval gate — gaps never block the run, same
"human makes the final call" guardrail as `policy_validator`. UI: `ComplianceReportView.tsx`. Because a
real LLM call asked to produce both priced tiers *and* the full `architecture_recommendation` in one
response proved unreliable in practice (confirmed live against Bedrock: a timeout, and separately a
hard failure where the model returned only one tier even after the schema-validation retry),
`planner.ts: runEnterprisePlanner` now splits this into **two smaller LLM calls** instead of one: Pass 1
produces the full-posture `high_availability` option plus the complete `architecture_recommendation`,
then Pass 2 is given Pass 1's output as ground truth and produces only a cost-reduced `economy` option —
see `skills/compliance-and-dr-reasoning.md`'s "Two-pass split" note for the exact framing sent each call.
This mode is absent (`enterprise_mode: false`/`null` fields) for every use case that doesn't trip a business-context
signal, so UC-1 through UC-9 are unaffected. Exercised by four scenarios in `npm run smoke -w
@ops-master/server` beyond the numbered UC set (a PCI-DSS payment platform, a 2-developer MVP, an
enterprise-scale rescale of that same MVP proving `org_scale` and `criticality_band` vary independently, and
a held-out HIPAA-healthcare scenario proving the rules generalize rather than pattern-matching one canned
example).

A ninth addition: **per-tier scoping and ROI narrative** on `CapacityPlanOption`
(`packages/shared/src/contracts.ts`) — `included_components`/`skipped_components` (what's in scope for this
tier and what was deliberately left out, and why), `task_graph` (the ordered provisioning steps the tier's
services/storage/network already imply, restated as steps a reviewer recognizes), `scaling_strategy`
(narrative min/max replicas + the condition a human would scale on — there is no live autoscaler in this
sandbox, replicas are fixed once at plan time), and `manual_estimate_person_days`/`agent_estimate_minutes`
(the platform's core ROI pitch: days of manual platform-engineering work vs. minutes with this pipeline,
scaled by service count and tier, kept illustrative like the existing AWS cost figures rather than
measured). All four are additive/defaulted (`[]`/`0`/`null`) so older persisted plans still parse. The
exact formulas the planner cites live in `skills/sizing-workloads.md`'s "Scoping narrative"/"Turnaround
estimate" sections (see `AGENTS_AND_SKILLS.md`); rendered at the approval gate by
`web/src/components/CapacityPlanView.tsx`. See `USE_CASES.md` UC-13 for a worked example (a 3-developer
startup request) with the exact captured field values.

A tenth addition: an explicit **`abandon` decision action** (`DecisionActionSchema` in
`packages/shared/src/contracts.ts`, handled in `orchestrator/pipeline.ts: submitDecision`), available at
every approval gate alongside `reject`. `reject` was ambiguous in practice — it always loops back through
another planner LLM call and returns to the same gate, even with no comment, so a reviewer who wanted a run
to just stop had no way to say so; the run instead sat in `running` for however long that LLM call took
(minutes, on the Enterprise Architecture Advisor path) before landing back at a gate nobody meant to revisit.
`abandon` skips the planner and goes straight to the same `refuseRun` path an infeasible plan or a timed-out
gate already use — `RunStatus="refused"`, refusal report generated immediately, no further LLM calls. UI:
an "Abandon run" button on `PlanApprovalGate.tsx`, `ApprovalGate.tsx`, and `PlanReviewGate.tsx`. See
`04-approval-gate.md`'s "Abandon" section.

An eleventh addition: a **gated real-apply path for the AWS/Terraform format** (`ALLOW_AWS_APPLY`,
`config.ts`), off by default everywhere — every contributor, judge, and `npm run smoke` sees UC-9's
existing plan-only behavior with zero change. Set on a demo machine only, it unlocks two additional
allow-listed commands in `commandAllowList.ts` (`terraform apply ... tfplan` and
`terraform destroy ...`, both gated behind an `enabled: isAwsApplyEnabled` check on the rule itself, plus
an always-on read-only `terraform output -json`) and applies to *any* terraform-format `IaCPayload`
(UC-9's own templates and the Enterprise Architecture Advisor's terraform bundle alike — the gate isn't
template-specific). `nodes/deploy.ts` applies the exact plan file a human already approved (never a fresh
unreviewed plan) and resolves the applied endpoint via `terraform output`; `nodes/verify.ts` then health-
checks that real URL instead of the plan-only bypass (deliberately no load test against it — a freshly
applied ALB/ECS service under real load is unnecessary risk for a short live demo); `nodes/rollback.ts`
runs a real `terraform destroy` if build/deploy/verify ever fails afterward — the first time that
rollback branch is reachable at all (previously dead code, since plan-only `deployOk` was hardcoded
`true`). Credentials: prefer a named AWS CLI profile (`aws configure --profile ...`, forwarded via the
`AWS_PROFILE` env var, always in `scrubbedEnv()`'s keep-list since it's a name, not a secret) over raw
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` env vars, which are supported but scoped
to only the terraform apply/destroy/output spawns (`awsCredentialEnv()`), never the general keep-list.
Cost-safety teardown: `templates/terraformCatalog.ts`'s `tf-ecs-fargate-v1` (the fast-to-apply economy
tier — recommended for a live demo; EKS create/destroy each take ~15-20 minutes) now also renders
`schedule-auto-destroy.ps1`/`cancel-auto-destroy.ps1`, reusing the exact Windows-Task-Scheduler pattern
`templates/enterpriseCatalog.ts` already had for its own terraform bundle — run the former immediately
after a successful live apply so a demo environment can't outlive the session even if rollback never
triggers (a healthy demo has nothing to roll back).

## Where each spec agent lives in code

| Spec file | Code |
|---|---|
| `00-orchestrator.md` | `apps/server/src/orchestrator/pipeline.ts`, `ws/hub.ts` |
| `01-intake.md` | `apps/server/src/nodes/intake.ts`, prompt at `apps/server/src/prompts/01-intake.md` |
| `02-planner.md` | `apps/server/src/nodes/planner.ts` + `planMerge.ts`, prompt at `prompts/02-planner.md`, skills at `skills/{sizing-workloads,managed-service-substitution,compliance-and-dr-reasoning}.md` |
| `02b-readiness-check.md` | `apps/server/src/nodes/readinessCheck.ts` (deterministic, no prompt file — no LLM call), wired into `orchestrator/pipeline.ts: reachApprovalGate`, UI: `web/src/components/ReadinessReportView.tsx` |
| `02c-compliance-check.md` | `apps/server/src/nodes/complianceCheck.ts` + `enterpriseRulesEngine.ts` (deterministic, no prompt file — no LLM call), pricing in `templates/enterpriseCatalog.ts`, wired into `orchestrator/pipeline.ts` alongside `readiness_check`, UI: `web/src/components/ComplianceReportView.tsx` — see "eighth addition" above |
| `03-iac-generator.md` | `apps/server/src/nodes/iacGenerator.ts`, templates in `templates/catalog.ts` (compose) + `templates/terraformCatalog.ts` (AWS, see "seventh addition" above), prompt at `prompts/03-iac-generator.md`, skills at `skills/{writing-compose-iac,writing-terraform-iac,novel-requirement-reasoning}.md` |
| `03b-policy-validator.md` | `apps/server/src/nodes/policyValidator.ts` (deterministic, no prompt file — no LLM call), self-correction loop lives in `orchestrator/pipeline.ts: reachApprovalGate`, UI: `web/src/components/PolicyReportView.tsx` |
| `04-approval-gate.md` | `orchestrator/pipeline.ts` (`reachPlanApprovalGate` = Gate 1, `reachApprovalGate` = Gate 2, `submitDecision`, timeout, `abandon` handling — see "tenth addition" above), UI: `web/src/components/PlanApprovalGate.tsx` (Gate 1), `ApprovalGate.tsx` (Gate 2) |
| *(not in spec — see "sixth addition" above)* | `apps/server/src/nodes/build.ts` + `buildRegistry.ts` (deterministic, no prompt file — no LLM call beyond the planner's sentinel choice), wired into `orchestrator/pipeline.ts: runDeployThroughReport` right before `deploy` |
| `05-deploy-agent.md` | `apps/server/src/nodes/deploy.ts`, `commandAllowList.ts` |
| `06-verify-agent.md` | `apps/server/src/nodes/verify.ts` |
| `07-audit-store.md` | `apps/server/src/store/*`, `supabase/schema.sql`, UI: `web/src/components/AuditTimeline.tsx` |

Prompts are loaded verbatim from their fenced ` ```text ` blocks at runtime (`llm/promptLoader.ts`) — exactly
the convention `agent-md-files/README.md` itself prescribes — so editing a prompt `.md` file changes behaviour
with no code change.
