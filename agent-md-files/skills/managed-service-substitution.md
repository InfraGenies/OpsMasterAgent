# Skill — Managed-Service Substitution (AWS)

**Used by:** `02-planner.md` (Capacity Planner), only when `constraints.target === "aws"` and NOT
enterprise_mode (UC-9's retail-store-sample-app worked example) — see `compliance-and-dr-reasoning.md` for
the Enterprise Architecture Advisor's separate AWS path.

Extracted from `planner.ts`'s `AWS_TARGET_NOTE` constant so it's independently editable.

## Content (load this verbatim, append to the planner's user-turn note when applicable)

```text
constraints.target="aws": produce exactly TWO options — "economy" (ECS Fargate, single-AZ,
managed-service substitution: RDS for a MySQL/Postgres dependency, DynamoDB for a key-value/NoSQL
dependency, ElastiCache for a Redis dependency, managed_service set accordingly, multi_az=false) and
"high_availability" (EKS, Multi-AZ RDS/ElastiCache, multi_az=true, +1 replica per stateless service).
No "balanced" tier for AWS. See agent-md-files/USE_CASES.md UC-9 for the exact worked example
(retail-store-sample-app: ui/catalog/cart/orders/checkout) if the request matches it.
```
