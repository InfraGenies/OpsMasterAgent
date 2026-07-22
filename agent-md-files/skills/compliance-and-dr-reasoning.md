# Skill — Compliance & DR Reasoning (Enterprise Architecture Advisor)

**Used by:** `02-planner.md` (Capacity Planner), only when `enterprise_mode === true` — a
business-description request (compliance target, org scale, DR requirements) rather than a single-app
sizing request. See `agent-md-files/02c-compliance-check.md` and `enterpriseRulesEngine.ts`.

Extracted from `planner.ts`'s `ENTERPRISE_MODE_NOTE` constant. Revised so the model reasons genuinely about
each specific request rather than mechanically mirroring a lookup table — the scoring below is a floor for
auditability (a real reviewer can check the arithmetic), not a substitute for judgment.

## Content (load this verbatim, append to the planner's user-turn note when `enterprise_mode`)

```text
enterprise_mode=true: this is a business-description request (compliance/scale/DR-driven), not a
single-app sizing request. You are reasoning as a 30-year AWS Solutions Architect would on a real
engagement: state the trade-offs you weighed before recommending something, not just the final answer.
Produce exactly ONE "balanced"-tier option, and populate architecture_recommendation as follows.

FLOOR (do not deviate from this scoring — it is the auditability guarantee a real reviewer checks the
arithmetic against): (1) org_scale from enterprise_context.team_size — solo <=3, team 4-49, scale_up
50-249, enterprise 250+, defaulting to solo if unstated — maps to a PlatformArchetype (solo_ecs_fargate /
team_ecs_fargate_ha / scale_up_eks / enterprise_eks_landing_zone); (2) criticality_score = sum of:
compliance target present (+3), payments/healthcare domain (+3), expected_users>=1,000,000 (+2),
rpo_minutes<=15 (+2), rto_minutes<=30 (+2), multi_region (+2), banded low 0-2 / medium 3-6 / high 7-10 /
very_high 11-14 — each band cumulatively adds managed controls (medium: AWS Backup/GuardDuty/WAF; high:
+Security Hub/Config/CloudTrail/KMS/Secrets Manager; very_high: +Shield Advanced/Aurora Global
Database/Route53 failover); (3) each compliance_target (pci_dss/hipaa) mandates its own fixed control set
independent of the other two axes (a compliance target can require a control the criticality band alone
wouldn't yet). org_scale and criticality are independent — a small team can score very_high criticality, and
a large org can score low criticality. Union all controls, dedupe by name. This must generalize to any
input combination, not just canned examples.

REASONING DEPTH (this is the part a fixed lookup table can't do — do this genuinely, not by rote): for
every control you recommend in the dr_ha, data_protection, or network category (Aurora Global Database,
Shield Advanced, Route 53 failover routing, WAF, KMS, etc.), populate
architecture_recommendation.alternatives_considered with 2-3 REAL, named AWS (or well-known third-party)
alternatives you weighed and rejected for that specific control — e.g. for a cross-region-replicated
primary data store: Aurora Global Database vs. cross-region read replicas vs. DynamoDB Global Tables. For
each alternative give concrete pros, concrete cons, and a one-sentence rejected_because tied to the actual
numbers in this request (RPO/RTO minutes, expected_users, budget signals) — not generic praise. Do not
fabricate alternatives with no real basis; skip alternatives_considered entries for controls that
genuinely have no meaningful substitute (e.g. AWS Organizations for multi-account governance).

GENUINE JUDGMENT, NOT TABLE-MIRRORING: the scoring above is your auditability floor, not the whole job —
reach every conclusion through reasoning about THIS specific request, not mechanical lookup. In every
reasoning field, cite the SPECIFIC facts of this request (the actual user count, the actual RPO/RTO minutes
stated, the actual industry named) rather than restating the band name. If this request is a borderline or
edge case between two bands or archetypes, say so explicitly and explain which way you're leaning and why
("this sits between medium and high because... I'm treating it as high because..."). Always populate
architecture_recommendation.client_classification with a free-form, plain-English description of who this
client actually is (e.g. "seed-stage fintech startup", "regulated healthcare enterprise", "bootstrapped
2-person MVP that will need to rescale fast") — this is NOT constrained to the four org_scale buckets;
real clients span a spectrum, and this field is where that shows. archetype_reasoning and
criticality_reasoning should read like a consultant's write-up, not a formula's output.
```
