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
  "constraints": { "target": "compose", "max_memory_gb": 8 },
  "plan_only": false
}
```

`operation`: `create | modify | destroy` — UC-7 uses `modify` with `existing_env_id`.

`plan_only` — not in the original agent set. A pass-through UI flag ("Just plan this" vs "Plan + deploy")
set at request submission, never inferred by intake from wording. When `true`, the pipeline stops after the
planner (plus `compliance_check` in Enterprise Architecture Advisor mode) at a no-timeout review gate — no
`iac_generator`, `policy_validator`, or `deploy`/`verify` ever runs. See the "Plan-only review gate" section
of `04-approval-gate.md`.

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

## 2b. ReadinessReport  (planner → readiness_check → iac_generator)

Not in the original agent set — see `02b-readiness-check.md` for why and how this fits in.

```json
{
  "request_id": "req-2026-0001",
  "checks": [
    { "name": "docker_daemon_reachable", "status": "pass", "detail": "docker daemon reachable", "blocking": true },
    { "name": "host_ports_free", "status": "fail", "detail": "host port(s) already in use: 3000", "blocking": true }
  ],
  "ready": false,
  "blockers": ["host port(s) already in use: 3000"]
}
```

`status`: `pass | fail | skipped`. `ready` is true iff no `blocking: true` check has `status: "fail"` — a
`skipped` check (couldn't determine, e.g. no docker CLI on this machine) never blocks. `blockers` is the
`detail` of every failing, blocking check, surfaced verbatim in the refusal reason.

## 2c. EnterpriseContext & ArchitectureRecommendation  (intake → planner, Enterprise Architecture Advisor mode)

Not in the original agent set — see `02c-compliance-check.md`. Populated only when `intake` detects
business-context signals (compliance target, team size, RPO/RTO, industry domain) in `raw_text`; absent/null
for every other use case. `PlanRequest` gains two fields (`enterprise_mode`, `enterprise_context`); the
resulting `ArchitectureRecommendation` rides on `CapacityPlan` (once per request, not once per priced tier,
since org-scale/criticality/compliance don't vary by tier).

```json
{
  "enterprise_context": {
    "industry_domain": "payments",
    "compliance_targets": ["pci_dss"],
    "expected_users": 8000000,
    "team_size": null,
    "org_scale": "solo",
    "multi_region": true,
    "rpo_minutes": 5,
    "rto_minutes": 15,
    "signal_reasoning": "\"payment platform\" -> industry_domain=payments; \"PCI-DSS\" -> compliance_targets=[pci_dss]; \"8 million users\" -> expected_users; \"multi-region DR\" -> multi_region; \"RPO<5min\"/\"RTO<15min\" parsed directly; team size not stated -> org_scale defaults to solo (org-scale and criticality are independent axes)."
  },
  "architecture_recommendation": {
    "archetype": "solo_ecs_fargate",
    "archetype_reasoning": "org_scale=solo (team size unstated) -> smallest platform archetype, independent of workload criticality.",
    "criticality_score": 14,
    "criticality_band": "very_high",
    "criticality_reasoning": "compliance target present (+3), payments domain (+3), users>=1M (+2), RPO<=15min (+2), RTO<=30min (+2), multi_region (+2) = 14/14 -> very_high.",
    "managed_controls": [
      { "name": "AWS Shield Advanced", "category": "dr_ha", "triggered_by": "criticality", "reasoning": "very_high band requires DDoS protection beyond the AWS Shield Standard default.", "compliance_tags": ["PCI-DSS-6.6"], "estimated_cost_usd_monthly": 3000, "terraform_bundle_template_id": "tf-shield-advanced-v1" }
    ],
    "compliance_overlay": ["pci_dss"],
    "total_controls_cost_usd_monthly": 3000,
    "alternatives_considered": [
      {
        "option": "AWS Shield Advanced",
        "pros": "24/7 DDoS Response Team, cost protection during an attack, deep WAF/CloudFront/Route 53 integration.",
        "cons": "Meaningful fixed monthly cost plus a 1-year commitment.",
        "rejected_because": null
      },
      {
        "option": "AWS Shield Standard (default, free)",
        "pros": "No additional cost, automatically active on every account.",
        "cons": "No response-team access, no cost protection, less coverage against sophisticated attacks.",
        "rejected_because": "very_high criticality on a payments-adjacent workload warrants the response-team SLA Standard doesn't include."
      }
    ]
  }
}
```

`alternatives_considered` — not in the original agent set. For controls with a genuine real-world
substitute (chiefly `dr_ha`/`data_protection`/`network` category), the planner names 2-3 concrete
alternatives it weighed, with pros/cons and a `rejected_because` tied to the request's actual numbers
(RPO/RTO, expected users, budget) — this is what turns a fixed lookup table into an explanation a human
reviewer would actually trust. Empty for controls with no meaningful alternative (e.g. AWS Organizations).
See `nodes/enterpriseRulesEngine.ts`'s `ALTERNATIVES_BY_CONTROL_NAME` (mock-mode parity) and the
`compliance-and-dr-reasoning` skill (real-LLM instruction) for the exact framing.

`client_classification` — not in the original agent set. A free-form, plain-English description of who this
client actually is (e.g. "seed-stage fintech startup", "regulated healthcare enterprise") — coexists with,
rather than replaces, the structural `org_scale`/`archetype`/`criticality_band` enums those fields still
drive `enterpriseRulesEngine.ts`'s lookup tables. Exists so genuine per-request judgment shows through even
though the structural fields stay enum-constrained for auditability and UI/backend lookups.

`org_scale` (`solo|team|scale_up|enterprise`, by team size band) selects a `PlatformArchetype` — the
*platform* choice (ECS vs EKS, single- vs multi-account). `criticality_band` (`low|medium|high|very_high`,
a weighted score over compliance/domain/scale/RPO/RTO/multi-region signals) adds security/DR controls on
top of whatever archetype was picked. `compliance_targets` layers a third, independent set of mandatory
controls a framework requires regardless of the other two axes. All three compose into one deduplicated
`managed_controls` list — see `nodes/enterpriseRulesEngine.ts` for the exact scoring formula and thresholds.

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

`format`: `compose | terraform | k8s`. `template_id` normally references a vetted template in `templates/` —
the deploy agent refuses payloads with unknown template IDs. **Divergence from the original spec**: `template_id`
also accepts the sentinel value `"freeform"` — not in the original agent set. When nothing in the catalogue
covers a request's topology, `iac_generator` may write IaC files directly instead of only ever refusing with
`no_template` (see `03-iac-generator.md` and `skills/novel-requirement-reasoning.md`). The LLM's output shape
for this path is `{ "format": "compose" | "terraform", "files": [...] }` — notably it never includes
`apply_command`/`rollback_command`; those are always derived by backend code from `format` + the project
name, matching the exact literal strings `nodes/commandAllowList.ts` already expects (confirmed
format-generic, not template-specific, so no allow-list change was needed for this addition). A freeform
payload is flagged distinctly in the UI (`template_id === "freeform"`) so a human reviewer knows it wasn't
produced by a pre-validated rendering path. For `modify` operations, `diff_from` holds the previous env's
files and the UI renders a diff.

**Second divergence from the original spec**: four more fields, all optional/defaulted so every
non-build template's payload is unaffected — `build_steps` (an ordered list of `{command, cwd, env?}`,
populated only on the build-sentinel path, `nodes/buildRegistry.ts`/`nodes/build.ts` — not in the original
agent set, see the README's "sixth addition"), `resolved_images` (service name → the locally-built image
tag that `build_steps` actually produced, so environment snapshots reflect what's really running instead of
the planner's `"__BUILD__:<key>"` sentinel), `dockerfile_override` (a full Dockerfile string the `build`
node writes into the cloned repo before `docker build`, when the repo's own Dockerfile doesn't work as-is —
see `buildRegistry.ts`'s doc comment for exactly why UC-1's needs one), and `health_path` (the HTTP path
`verify` checks — was previously hardcoded to `"/"` regardless of what a template actually serves; now
threaded through from the `variables.health_path` every template already accepted, benefiting every
existing use case, not just the build path).

## 3b. PolicyReport  (iac_generator ⇄ policy_validator self-correction loop, then → approval gate)

Not in the original agent set — see `03b-policy-validator.md` for why and how this fits in.

```json
{
  "request_id": "req-2026-0001",
  "findings": [
    {
      "rule_id": "weak_default_secret",
      "severity": "high",
      "message": "DB_PASSWORD in .env is set to a common default value (\"admin123\") instead of a generated secret",
      "file": ".env",
      "auto_fixable": true
    }
  ],
  "passed": false,
  "attempts": 1
}
```

`severity`: `critical | high | medium | low`. `passed` is true iff no `critical`/`high` finding remains.
Only findings with `auto_fixable: true` drive a retry back to `iac_generator`; everything else is
reported once and shown to the human at the approval gate rather than looping.

## 3c. ComplianceReport  (compliance_check → approval gate)

Not in the original agent set — see `02c-compliance-check.md`. Enterprise Architecture Advisor mode only;
absent for every other use case. Runs once, pre-flight (alongside `readiness_check`, before `iac_generator`
is ever called) rather than in a retry loop like `policy_validator`, because every finding here is rooted in
`ArchitectureRecommendation.managed_controls` — a planner-time decision `iac_generator` has no lever over,
so there is nothing an auto-fix retry could change.

```json
{
  "request_id": "req-2026-0001",
  "frameworks": ["pci_dss"],
  "findings": [
    {
      "control_id": "PCI-DSS-3.4",
      "framework": "pci_dss",
      "status": "satisfied",
      "severity": "high",
      "message": "Encryption at rest required for cardholder data",
      "satisfied_by": "AWS KMS"
    },
    {
      "control_id": "PCI-DSS-10.2",
      "framework": "pci_dss",
      "status": "gap",
      "severity": "high",
      "message": "Audit logging with log-file validation required",
      "satisfied_by": null
    }
  ],
  "passed": false,
  "gap_count": 1
}
```

`status`: `satisfied | gap | not_applicable`. `passed` is true iff no `critical`/`high` gap remains — same
formula shape as `PolicyReport.passed`. Unresolved gaps never block the run; they ride to the approval gate
as a visible warning, consistent with `policy_validator`'s "human makes the final call" guardrail. The
`control_id`→AWS-service mapping here is illustrative (a demo gap-analysis), not audited against PCI-DSS
v4/HIPAA Security Rule text — a real compliance review should replace the mapping table before this is
presented as anything more.

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
