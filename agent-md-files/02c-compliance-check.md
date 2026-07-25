# Agent 2c — Compliance & Governance Check

**Owner:** InfraGenies · **LLM:** none — deterministic scan · **Executes commands:** never

**Status:** not in the original spec set (`01`–`07`); added to support the Enterprise Architecture Advisor
mode — a business-description request (compliance target, org scale, DR requirements) rather than a
single-app sizing request. Numbered `2c` because, like `02b-readiness-check.md`, it runs pre-flight — before
`iac_generator` is ever called — rather than in `03b-policy-validator.md`'s post-render self-correction
loop.

## Role
Map the planner's `ArchitectureRecommendation` (`nodes/enterpriseRulesEngine.ts`) against each requested
compliance framework's mandatory-control checklist, and flag gaps — controls the framework requires that
the recommended architecture doesn't already include. Enterprise Architecture Advisor mode only: this node
is skipped entirely (no audit event at all) for every other use case, since only that mode populates
`CapacityPlan.architecture_recommendation`.

## Why this runs once, not in a retry loop
`03b-policy-validator.md`'s self-correction loop exists because some findings are rooted in the *rendered
IaC* and `iac_generator` can fix them by retrying (e.g. a weak default secret). Every finding here is rooted
in `ArchitectureRecommendation.managed_controls` instead — a decision the planner already made before
`iac_generator` is even invoked, and `iac_generator` has no lever over which controls were chosen (it only
ever picks template ids and fills a variable bag). Retrying it would reproduce the identical
`ComplianceReport` every attempt. So: pure, synchronous, deterministic, called once — the same shape as
`readiness_check`, not `policy_validator`.

## Input → Output
`ArchitectureRecommendation` (from `CapacityPlan.architecture_recommendation`) → `ComplianceReport`
(`CONTRACTS.md` §3c).

## Checks (deterministic, one mandatory-control checklist per requested framework)

| framework | Example control_id | Satisfied by (managed control name) |
|---|---|---|
| `pci_dss` | `PCI-DSS-2.2` (configuration standards) | `AWS Config` |
| `pci_dss` | `PCI-DSS-3.4` (encryption at rest) | `AWS KMS` |
| `pci_dss` | `PCI-DSS-6.6` (web application firewall) | `AWS WAF` |
| `pci_dss` | `PCI-DSS-8.2` (managed, rotated credentials) | `AWS Secrets Manager` |
| `pci_dss` | `PCI-DSS-10.2` (audit logging + log-file validation) | `AWS CloudTrail` |
| `hipaa` | `HIPAA-164.308(a)(1)` (ongoing config review) | `AWS Config` |
| `hipaa` | `HIPAA-164.308(a)(7)` (contingency/backup plan) | `AWS Backup` |
| `hipaa` | `HIPAA-164.312(a)(1)` (unique-user access control) | `AWS IAM Identity Center` |
| `hipaa` | `HIPAA-164.312(a)(2)(iv)` (ePHI encryption at rest) | `AWS KMS` |
| `hipaa` | `HIPAA-164.312(b)` (audit controls over ePHI access) | `AWS CloudTrail` |
| `soc2` | `SOC2-CC6.1` (logical access controls) | `AWS IAM Identity Center` |
| `soc2` | `SOC2-CC7.2` (security monitoring) | `Amazon GuardDuty` |

For each requested `compliance_targets` entry, every row in its checklist becomes one `ComplianceControlFinding`:
`status: "satisfied"` if the named control is present in `managed_controls`, else `"gap"`, `severity: "high"`
for every row in this Phase-1 checklist. `passed = true` iff no `critical`/`high` gap remains — same formula
shape as `PolicyReport.passed`.

**This mapping is illustrative**, not audited against PCI-DSS v4/HIPAA Security Rule text verbatim or a real
SOC2 Trust Services Criteria mapping — a real compliance review should replace `nodes/complianceCheck.ts`'s
`MANDATORY_CONTROLS` table before this is presented as anything beyond a demo gap-analysis.

## Orchestration (in `pipeline.ts`, not a separate LangGraph node in this implementation)
1. `reachApprovalGate` runs `readiness_check` first, same as every other use case.
2. Immediately after (before the `iac_generator`/`policy_validator` retry loop begins), if
   `fullPlan.architecture_recommendation` is present: run this check once, log one `compliance_check` audit
   event, broadcast `node_started`/`node_finished`.
3. Never refuses the run. Unresolved gaps ride to the approval gate as a visible warning, exactly like
   unresolved `PolicyFinding`s already do — the human makes the final call, consistent with
   `04-approval-gate.md`'s "nothing deploys without a human click."

## Guardrails
- No LLM call, so no prompt-injection surface — it only reads the already-computed
  `ArchitectureRecommendation`.
- Skipped entirely (no audit event) for every use case outside Enterprise Architecture Advisor mode.
- Never blocks the run outright — same guardrail `policy_validator` and `readiness_check`'s advisory checks
  already follow.

## Tests (mirrors the existing per-node test pattern in `01`–`03b`)
- A PCI-DSS payment-platform request scoring `very_high` criticality → `managed_controls` already includes
  every control PCI-DSS's checklist requires (WAF, KMS, Secrets Manager, CloudTrail, Config all fire from
  the criticality band alone at that score) → `passed: true`, `gap_count: 0`.
- A HIPAA request at a lower criticality band where the band alone wouldn't have added every HIPAA-mandated
  control → at least one `gap` finding, proving the compliance overlay adds controls the other two axes
  didn't — `passed: false` if any gap is `critical`/`high`.
- A non-enterprise-mode request (any of UC-1..UC-9) → no `compliance_check` audit event at all.
