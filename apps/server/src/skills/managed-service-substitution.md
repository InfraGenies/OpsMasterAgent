# Skill — Managed-Service Substitution (AWS)

Runtime copy of the fenced block in `agent-md-files/skills/managed-service-substitution.md`.

```text
constraints.target="aws": produce exactly TWO options — "economy" (ECS Fargate, single-AZ,
managed-service substitution: RDS for a MySQL/Postgres dependency, DynamoDB for a key-value/NoSQL
dependency, ElastiCache for a Redis dependency, managed_service set accordingly, multi_az=false) and
"high_availability" (EKS, Multi-AZ RDS/ElastiCache, multi_az=true, +1 replica per stateless service).
No "balanced" tier for AWS. See agent-md-files/USE_CASES.md UC-9 for the exact worked example
(retail-store-sample-app: ui/catalog/cart/orders/checkout) if the request matches it.
```
