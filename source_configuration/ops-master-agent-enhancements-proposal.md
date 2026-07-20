# Ops Master Agent — Enhancement Proposal (CAIO Review)

**Reviewer stance:** DevOps/AI consulting review of `ops-master-agent-solution.md` against the current
Node/TS implementation (`agent-md-files/`, `apps/server/src/`). Goal: take this from "generates and deploys
one plan" to "reasons like a staff-level infra architect, shows its work, and lets a human pick between
priced tradeoffs before anything touches a system."

**Method note:** every gap below was checked against the running code (`pipeline.ts`, `nodes/*.ts`,
`contracts.ts`), not just the spec docs. Where I say "doesn't exist today," I mean it — I grepped/read the
implementation before writing the claim.

---

## Current state, in one paragraph

`intake → planner → readiness_check → iac_generator → policy_validator → approval_gate → deploy → verify →
(rollback) → report` is real and working. As of this revision, §3 (Readiness Check) and §4 (Policy &
Security Validation) have both been **implemented** — see the status notes at the top of each section. The
rest of the pipeline is still **single-path**: one interpretation of the request, one capacity plan, one
IaC payload, and a deploy executor limited to Docker Compose with immediate rollback-on-any-failure. The
approval gate shows a plan, a diff, readiness checks, and policy findings — it still does not show cost,
budget position, or alternatives. That's the remaining gap between "MVP that works" and "what I'd want a
$50k/mo provisioning system to actually do."

---

## 1. Intake / NLU — make it research, not just parse

**Today:** `nodes/intake.ts` is a single LLM call that maps free text → `PlanRequest`. It never looks at the
`repo_url` it's given, never checks history, and silently fills unstated fields with `null` (e.g. `rps`) —
see `01-intake.md` rule 5.

**The problem with silent guessing:** a request that omits load, compliance context, or environment
sensitivity shouldn't be *guessed* — it should either (a) be inferred from evidence, or (b) come back as a
targeted clarifying question, cheaply, before three more LLM calls and a human reviewer's time get spent
downstream on a plan built on a bad assumption.

**Proposed additions:**

1. **Repo fingerprinting step** (runs before the LLM call, deterministic, no LLM cost): if `repo_url` is
   given, fetch `package.json` / `requirements.txt` / `pom.xml` / `Dockerfile` and detect actual runtime,
   framework, DB client libraries, and exposed ports. Feed this as *evidence* into the intake prompt instead
   of asking the LLM to infer runtime from prose alone. This directly strengthens the "understand the
   request" claim in the source doc (§1) — right now "understanding" is text-only.
2. **Confidence + clarification, not silent null:** extend `PlanRequest` with a `field_confidence` map and a
   `needs_clarification: string[]`. If `expected_load.rps` or `environment` is unstated *and* can't be
   inferred from the repo, surface one targeted question in the chat UI (`ChatInput.tsx` already supports a
   conversational flow) rather than manufacturing an assumption that only surfaces six steps later at the
   approval gate.
3. **Compliance/data-sensitivity tagging:** add `compliance_tags: string[]` (e.g. `pii`, `payment`,
   `none`) inferred from keywords + repo evidence (env var names like `STRIPE_KEY`, schema field names).
   This is the input the Policy Validator (§4) and Capacity Planner (§2) both need to set stricter defaults
   — today nothing downstream knows a request touches sensitive data.
4. **Close the loop with history:** before finalizing, look up prior `PlanRequest`s with the same
   `app_type`/`runtime` via the audit store and surface "3 similar requests exist; the last one specified
   redis for caching — did you mean to include it?" This is cheap (one store query) and materially raises
   perceived intelligence.

**Contract change:** `PlanRequest` gains `field_confidence`, `needs_clarification`, `compliance_tags`,
`repo_evidence` (nullable). All additive — no breaking change to `CONTRACTS.md` §1 consumers.

---

## 2. Capacity Planning — think in tiers, not a single point estimate

**Today:** `nodes/planner.ts` (per `02-planner.md`) applies fixed per-runtime formulas
(`ceil(rps/250)` etc.) and emits **exactly one** `CapacityPlan`. There's no cost figure anywhere in the
contract, no headroom margin (the formula sizes to *exactly* the stated load, not load + burst buffer), and
no variation by environment (`prod` and `dev` get the same replica-floor logic).

**This is the biggest single gap relative to what you described** ("X capacity and cost, Y capacity and
cost"). Right now there is no X vs Y — there's only X.

**Worked example added:** `agent-md-files/USE_CASES.md` UC-9 now carries a concrete Tier X (Economy,
~$150/mo) vs. Tier Y (High-Availability, ~$430/mo) comparison for AWS's own
[retail-store-sample-app](https://github.com/aws-containers/retail-store-sample-app) — real AWS managed
services (RDS/DynamoDB/ElastiCache/ECS/EKS), not just a replica-count knob. It's marked target-state
because it also needs the Terraform template family from §6; use it as the acceptance test for this
section once built.

**Proposed shape — `CapacityPlanOption[]` instead of a single `CapacityPlan`:**

```json
{
  "request_id": "req-2026-0001",
  "options": [
    {
      "tier": "economy",
      "services": [...], "storage": [...], "network": {...},
      "estimated_cost_usd_monthly": 38,
      "headroom_pct": 0,
      "availability_notes": "single replica per service, no failover",
      "reasoning": "..."
    },
    {
      "tier": "balanced",
      "services": [...], "storage": [...], "network": {...},
      "estimated_cost_usd_monthly": 76,
      "headroom_pct": 20,
      "availability_notes": "2x app replicas behind nginx, 20% burst headroom over stated rps",
      "reasoning": "..."
    },
    {
      "tier": "high_availability",
      "...": "...",
      "estimated_cost_usd_monthly": 154,
      "availability_notes": "N+1 redundancy on every stateful service, daily volume backup"
    }
  ],
  "recommended_tier": "balanced",
  "feasible": true
}
```

- `recommended_tier` is the planner's pick; the human still sees and can choose the others at the approval
  gate (§5) — this is what makes "X budget/capacity or Y budget/capacity" a real decision instead of a
  narrative aside.
- A local **rate table** (cost-per-CPU-hour, cost-per-GiB-RAM-hour, cost-per-GiB-storage) is enough for
  MVP — no live cloud pricing API needed yet, and it keeps the sandbox-only demo self-contained. Structure
  it so swapping in a real pricing API later (AWS Price List API, Infracost) is a drop-in behind the same
  `estimated_cost_usd_monthly` field.
- **Environment-aware sizing:** `prod` should get a replica floor of 2 for anything stateless and a backup
  volume requirement for anything stateful; `dev`/`staging` can go to 1. Today the formula is
  environment-blind.
- **Headroom, not exact-fit:** size to `ceil(rps * (1 + headroom_pct) / per_instance_rps)` for the
  `balanced`/`ha` tiers — sizing to the exact stated number with zero margin is the kind of thing that looks
  fine in a demo and pages someone in week two.
- **Feed verification history back in:** `VerifyReport.smoke_test.achieved_rps` from prior runs of the same
  `runtime` should adjust the per-instance-rps constant over time (even a simple rolling average beats a
  hardcoded `250`). This is the actual feedback loop the source doc promises in §8 ("feedback from
  verification results is used to improve future capacity plans") — right now nothing reads
  `VerifyReport`s back into planning.

**Contract change:** replace single-object `CapacityPlan` response with `{ options: CapacityPlanOption[],
recommended_tier, feasible, infeasibility_reason }`. This is a breaking contract change — plan it as one
deliberate migration (bump the schema, update `iac_generator`/`approval_gate`/UI together), not incremental.

---

## 3. Pre-IaC checkpoints — infrastructure readiness gate — ✅ implemented

**Status: shipped.** Second item off the sequencing list, right after the Policy Validator.

**What's in the codebase now:**

- New node `apps/server/src/nodes/readinessCheck.ts` — `runReadinessCheck(input)`, deterministic, no LLM.
  Spec file: `agent-md-files/02b-readiness-check.md`. Contract: `ReadinessReport`/`ReadinessCheckResult` in
  `packages/shared/src/contracts.ts`, plus `"readiness_check"` added to `NodeNameSchema`.
- Runs as the first step inside `pipeline.ts: reachApprovalGate` — before `iac_generator` is ever called —
  so both the initial run and every rework-after-reject path get it, since both funnel through that one
  function.
- Five checks shipped, four of the original six proposed: `docker_daemon_reachable`, `host_ports_free`,
  `disk_space_available`, `template_topology_supported` (all blocking), and
  `modify_state_matches_snapshot` (advisory only — see below). The budget-ceiling check stays deferred,
  same reason as the policy validator's cost guardrail: no cost model yet (§2).
- Demo hook: the phrase `"port conflict"` forces a synthetic `host_ports_free` failure, same convention as
  `policy_validator`'s `"weak password"` trigger — makes the refusal path demoable deterministically
  regardless of real OS port state.
- Web: a "Readiness" step in `PipelineStepper.tsx`, a `ReadinessReportView.tsx` panel between the Capacity
  Plan and Infrastructure-as-Code sections (matches where it actually runs).

**A real gap this surfaced, not fixed here:** building the `modify_state_matches_snapshot` check exposed
that `docker compose -p <project>` names are derived from the *current* request's ID at every call site
(`iacGenerator.ts`, the rollback path in `pipeline.ts`) — including for `modify`. So each successful modify
redeploys under a **new** project name rather than the one actually running, meaning vanilla compose would
mint fresh volume names rather than reuse the existing data volume. That's a separate, real issue in the
modify flow, not something a readiness-check feature should silently paper over. The drift check works
around it by resolving the live project name from the environment record's `request_id` field (the request
that last successfully redeployed it) rather than the in-flight one, and — because of the surrounding
uncertainty — is `blocking: false` (advisory, surfaced but non-refusing) rather than the hard blocker
originally proposed. Worth its own follow-up ticket.

**Contract, as shipped:** `ReadinessReport { request_id, checks: [{name, status: "pass"|"fail"|"skipped",
detail, blocking: boolean}], ready: boolean, blockers: string[] }` — logged as its own audit node
(`readiness_check`), same pattern as every other node. `ready=false` routes to the existing `refuseRun`
with the specific blocker, exactly as proposed — no new terminal state was needed.

**Verified:** `npm run typecheck` / `npm run build` clean across all three workspaces; `smoke.ts` extended
with a port-conflict refusal scenario (asserts the run reaches `refused` with a `readiness_check` audit
event present); and confirmed live against the running dev server — the port-conflict trigger produces
`ready: false` with the exact synthetic blocker, a plain request produces `ready: true` with all checks
passing or (for `docker_daemon_reachable`, since this dev machine has no docker CLI) skipped, and the
audit trail shows `readiness_check` correctly ordered between `planner` and `iac_generator`.

---

## 4. Policy & Security Validation — ✅ implemented

**Status: shipped.** This was the first item off the sequencing list (below) — additive, no upstream
contract breakage, and it closed the single largest gap between the source doc's narrative (§4,
"self-correction loop") and the code, which genuinely had nothing here before: no security scan, no
policy-as-code, no retry loop, just `docker compose config -q`.

**What's in the codebase now:**

- New node `apps/server/src/nodes/policyValidator.ts` — `runPolicyValidator(payload, plan, planRequest,
  attempts)`, deterministic, no LLM. Spec file: `agent-md-files/03b-policy-validator.md`. Contract:
  `PolicyReport`/`PolicyFinding` in `packages/shared/src/contracts.ts`, plus `"policy_validator"` added to
  `NodeNameSchema`.
- Runs between `iac_generator` and `approval_gate`, wired into the retry loop in `pipeline.ts:
  reachApprovalGate` — up to 3 attempts (1 initial + 2 self-corrections), every attempt logged as its own
  audit event so the retry history is inspectable, not hidden.
- Eight checks shipped: `structural_invalid`, `privileged_container`, `host_network`,
  `docker_socket_mount` (critical — the last three are future-proofing guards, not live risks yet, see
  below), `weak_default_secret` (high, **auto-fixable**), `unpinned_image_tag` (high), 
  `unexpected_published_port` (medium), `prod_single_replica` (medium).
- `iacGenerator.ts` gained a `feedback?: string` param, appended to the user prompt the same way
  `planner.ts`'s reject-with-comment rework already does — no system-prompt change needed.
- Web: a "Policy & Security" step in `PipelineStepper.tsx`, a `PolicyReportView.tsx` findings table, and a
  warning strip in `ApprovalGate.tsx` for unresolved critical/high findings.

**Where the actual build deliberately narrowed the original proposal, and why:**

1. **Only `weak_default_secret` drives a retry.** In this codebase the `iac_generator` LLM only ever picks
   a `template_id` and fills a small variable bag (`health_path`, `db_name`, `db_user`, `db_password`) —
   it never touches images, ports, replica counts, `privileged`, or `network_mode`; those come from fixed
   template code driven by the `CapacityPlan`. Looping `iac_generator` on a `CapacityPlan`-rooted finding
   (e.g. `unpinned_image_tag`, `prod_single_replica`) would just reproduce the same finding — it has no
   lever over it. So every finding now carries an `auto_fixable` flag, and only `auto_fixable: true`
   findings feed the retry; everything else is surfaced once at the gate rather than spinning the loop
   pointlessly. This is a real, checked-in-code refinement of the original "package findings as feedback,
   cap at 2 attempts" plan, not a simplification for its own sake.
2. **No policy-as-code naming-convention / `compliance_tags` rule.** The proposal's naming-convention check
   assumed `IaCFile.path` values look like `deployments/<request_id>/docker-compose.yml`
   (`CONTRACTS.md`'s example shape) — the actual rendered paths are relative (`docker-compose.yml`, `.env`)
   with the request-id directory added only when writing to disk, so that specific check didn't apply as
   described and was dropped rather than built against a fiction. The `compliance_tags`-driven isolation
   rule is still correctly deferred — it needs `PlanRequest.compliance_tags` from §1, which doesn't exist
   yet.
3. **No cost guardrail.** Confirmed still deferred, as originally scoped — it needs the cost model from §2,
   which hasn't been built.
4. **Demo hook added, not in the original proposal:** `mockIacGenerator` now takes a `demoWeakSecret` flag,
   triggered by the phrase "weak password" in the request text, so the self-correction loop is exercisable
   end-to-end with `MOCK_LLM=true` and no real API key — mirrors the existing `forceFail` trigger already
   used in `nodes/verify.ts`.

**Verified:** `npm run typecheck` / `npm run build` clean across all three workspaces; `smoke.ts` extended
with a self-correction scenario (asserts two `iac_generator` audit events + a final `passed: true`
`policy_validator` event); and confirmed live against the running dev server via direct API calls — the
weak-password trigger produces `attempts: 2` with an intermediate failed `policy_validator` event and a
clean second pass, a plain request produces `attempts: 1` with zero findings.

---

## 5. Human Approval — turn it into a budgeted decision, not a rubber stamp

**Today:** the approval gate (`04-approval-gate.md`, UI in `apps/web`) shows the plan, the IaC diff,
structural validation status, and — as of §4 shipping — a `PolicyReport` findings table with a warning
strip for unresolved critical/high findings. Still three buttons: approve / reject+comment / edit. There is
no cost figure, no budget context, and no tier comparison — because today there's only ever one plan to
look at.

**Proposed additions, now that §4 exists (still blocked on §2 for the comparison panel specifically):**

1. **Tier comparison panel** — the actual "X capacity/cost vs Y capacity/cost" decision surface you asked
   for. Render `CapacityPlanOption[]` as a side-by-side table (replica count, memory, availability notes,
   `$/month`) with the planner's `recommended_tier` pre-selected. Choosing a different tier re-renders IaC
   for that tier and re-runs `policy_validator` before the Approve button is live — never let a human approve
   a tier that hasn't itself been through the same validation as the recommended one.
2. **Org budget context** — a small computed panel (query-time aggregation over `listEnvironments()`, no new
   persisted state needed): current month's summed `estimated_cost_usd_monthly` across `state=up`
   environments vs. a configured org ceiling, and where this request's selected tier would land it
   ("$340/mo used of $500; this adds $45/mo → $385/mo, still under budget"). This is the "statistics before
   budgeting decision" you described — it belongs at the gate, computed fresh, not baked into the plan
   itself.
3. **Historical accuracy strip** — "last 5 similar (`runtime`+`app_type`) deployments: avg achieved_rps was
   8% above target, 0 rollbacks, 1 required a manual restart" pulled from prior `VerifyReport`s. Builds
   reviewer trust in the recommendation and gives teeth to §2's feedback-loop claim.
4. **Risk badge** — one computed Low/Medium/High combining: any unresolved `PolicyReport` findings (by
   severity), `ReadinessReport` blockers if any were overridden, and headroom margin. Lets a reviewer
   triage across multiple concurrent `awaiting_approval` runs at a glance instead of reading every panel on
   every run.

None of this needs a new persisted contract — it's server-side aggregation exposed via a
`GET /api/runs/:id/approval-context` endpoint the web app calls when it lands on an `awaiting_approval` run,
consistent with your existing pattern of REST-refetch-on-WS-event rather than trusting WS payloads as source
of truth.

---

## 6. Automated Deployment — reusable primitives + a real extension point

**Today:** `nodes/commandAllowList.ts` is a genuinely good design — regex-matched argv allow-list, no shell,
scrubbed env, timeout. Keep that shape exactly. The gaps are elsewhere:

1. **Templates are monolithic, not composed.** `templates/catalog.ts` already has one good reusable
   primitive (`frontIfScaled` — the nginx-sidecar-when-replicas>1 rule). Generalize that pattern: factor
   healthcheck blocks, a backup-sidecar fragment (for §2/§4's prod-backup-volume rule), and a TLS-terminating
   proxy fragment into composable pieces that templates assemble from, rather than each template being
   written whole-cloth. This is what actually delivers the source doc's "golden modules" claim (§3) inside
   the compose-only scope — right now "golden modules" describes Terraform aspirations, but the same idea
   applies at the compose layer today.
2. **No retry-before-rollback.** Per `05-deploy-agent.md`, any non-zero exit triggers immediate rollback.
   A transient image-pull timeout or a port-bind race is indistinguishable from a genuinely broken payload
   today. Add one bounded retry (e.g. 2 attempts, short backoff) on `apply_command` specifically for
   exit-code patterns that look transient (pull timeout, "address already in use") before declaring failure
   — keep the immediate-rollback path for anything else, especially config errors.
3. **No deployment-target abstraction.** The source doc explicitly promises "the same pipeline extends to
   real cloud targets... with no change to the agent architecture — only the deployment tools swap." Today
   that's true only in the sense that nothing *prevents* it — there's no `DeploymentTarget` interface backing
   the claim. Introduce one now, even with a single `compose` implementation: `{ preflight(), apply(),
   rollback(), healthCheck() }`, so `commandAllowList.ts`'s pattern extends to a `terraform` or `k8s`
   implementation later by adding a module, not by touching `deploy.ts`'s control flow.
   `agent-md-files/USE_CASES.md` UC-9 (AWS/Terraform, retail-store-sample-app) is the concrete acceptance
   test for this: a `tf-ecs-fargate-v1`/`tf-eks-v1` template family filling that repo's own bundled
   Terraform modules, plus a `terraform init`/`plan`/`apply` `DeploymentTarget` implementation alongside
   `compose`'s. `IaCPayload.format` already allows `"terraform"` — nothing renders it yet.
4. **Post-deploy structural re-check.** After `up -d --wait` returns success, re-run the cheap structural
   checks from §4 (§3's readiness pattern reused) against the *actual* live containers (`docker compose ps
   --format json`) before marking `deploy_ok=true` — catches "compose says healthy, container crash-looped
   immediately after" before it reaches Verify and gets misattributed as a verification failure rather than
   a deploy one.
5. **Blue/green-lite within compose scope.** For `modify` on a service with existing traffic, bring up the
   new revision alongside the old, health-check it, then cut over and tear down the old — rather than
   compose's default recreate-in-place. Reduces the verification-time gap where the service is briefly down
   mid-deploy. This is a real implementation of the "progressive rollout" line in the source doc (§6),
   scoped to what compose can actually do (full canary/traffic-split needs a real LB or mesh, which is
   correctly out of scope for the sandbox MVP).

---

## Sequencing recommendation

Suggested order, each step shippable and demoable on its own:

1. ~~**§4 Policy Validator**~~ — ✅ **done.** `nodes/policyValidator.ts` +
   `agent-md-files/03b-policy-validator.md`, wired into `pipeline.ts`'s self-correction loop, surfaced in
   the web UI. See §4 above for exactly what shipped and where the build narrowed the original proposal.
2. ~~**§3 Readiness Check**~~ — ✅ **done.** `nodes/readinessCheck.ts` +
   `agent-md-files/02b-readiness-check.md`, wired into `pipeline.ts` ahead of `iac_generator`, surfaced in
   the web UI. See §3 above for what shipped, what stayed deferred, and the modify project-naming gap it
   surfaced along the way.
3. **§2 Multi-tier Capacity Planning** — up next, and now the contract-breaking one; do it now that
   `ReadinessReport` and `PolicyReport` both exist so tier-switching at the gate (§5) can re-run readiness
   + policy validation cheaply against whichever tier the human picks.
4. **§5 Approval Gate enrichment** — mostly UI + a read-side aggregation endpoint; the readiness panel,
   policy findings panel, and warning strip are already there, so this is now "add the tier comparison +
   budget context," not "start from nothing." Depends on §2 for the comparison panel.
5. **§1 Intake research depth** — highest value but the most open-ended (repo fetching, clarification UX);
   do last so it can draw on the richer downstream contracts already existing to decide what's worth asking
   about.
6. **§6 Deployment improvements** — independent of the others; can be picked up in parallel by whoever owns
   `nodes/deploy.ts` at any point.

Say which one to start next and I'll turn it into an implementation plan the same way — contract diffs,
new node file, prompt/spec-doc updates, UI component, verified end-to-end before calling it done.
