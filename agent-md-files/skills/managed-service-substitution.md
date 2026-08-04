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

SCHEMA RULE (do not violate — this has caused real validation failures): every ServiceSpec.replicas MUST
be >= 1, with NO exception for a managed/serverless dependency (DynamoDB, a fully-managed cache, etc.) that
has no real task compute to run — replicas is never 0, even for something serverless. Whether you model a
managed-service dependency as a field on its owning application service (managed_service set directly on
e.g. the "cart" service) or as its own separate ServiceSpec entry (e.g. a distinct "carts-db" entry), always
set that entry's replicas: 1 and use the literal string "n/a (managed service)" for cpu/memory when there is
no real compute to size — matching the convention this codebase already uses elsewhere for illustrative
managed-database ServiceSpec entries. Never emit replicas: 0, cpu: "0", or memory: "0Mi" to represent "this
is serverless" — that is exactly the invalid shape that fails schema validation.

This CapacityPlanOption contract has no managed_controls array (that only exists on the Enterprise
Architecture Advisor's ArchitectureRecommendation) — so cover the following in included_components,
skipped_components, and scaling_strategy instead, both tiers, not just high_availability:

- Auto scale: scaling_strategy.trigger_description must name the real AWS mechanism, not just a
  floor/ceiling number — "ECS Service Auto Scaling (target-tracking on CPU or ALB request count per
  target)" for the economy/ECS tier, "Horizontal Pod Autoscaler + EKS Cluster Autoscaler" for the
  high_availability/EKS tier. Still say plainly this sandbox never applies the change live.
- Load balancing: already covered by sizing-workloads.md's load-balancer naming rule ("Application Load
  Balancer (round-robin)" for AWS) — don't duplicate it, just make sure it's present when replicas > 1.
- Monitoring: add an included_components entry for "Amazon CloudWatch (alarms + dashboards on CPU/memory/
  error rate)" in every tier — this is a baseline, not a high_availability-only add-on.
- Encryption: add an included_components entry noting encryption at rest is enabled by default
  (AWS-managed keys) on every managed data store (RDS/DynamoDB/ElastiCache) in both tiers; call out
  encryption in transit (TLS via the ALB listener / ACM certificate) alongside it.
- Auth/authorization: add an included_components entry for "Amazon Cognito (end-user
  authentication/authorization)" in both tiers unless the request's own stack already implies its own
  auth (e.g. an app explicitly described as internal-only with no end users) — say so explicitly if you
  omit it for that reason rather than silently leaving auth out.
- CI/CD pipeline: add an included_components entry for "GitHub Actions CI/CD (OIDC federation to AWS, no
  stored access keys)" in both tiers — deploying by hand isn't a real recommendation even for the economy
  tier.
- Error handling: for any tier with an asynchronous/queue-like dependency (or on request, e.g. "handle
  failures gracefully"), add a skipped_components-style call-out or included_components entry for "Amazon
  SQS dead-letter queue + retry policy" so a downstream failure is captured and replayable instead of
  silently dropped. Not required for a purely synchronous request/response service with no queue.
```
