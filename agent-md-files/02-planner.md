# Agent 2 — Capacity Planner

**Owner:** InfraGenies · **LLM:** yes · **Executes commands:** never · **Skills:** sizing-workloads (always), managed-service-substitution (aws target), compliance-and-dr-reasoning (enterprise_mode)

## Role
Turn a `PlanRequest` into a `CapacityPlan`: services, images, CPU/memory, replicas, storage, network — **with reasoning shown**. The visible reasoning grounded in real sizing rules is the team's differentiator; InfraGenies reviews every rule for realism.

## Input → Output
`PlanRequest` → `CapacityPlan` (`contracts/CONTRACTS.md` §2) — as of the multi-tier revision, a
`CapacityPlan` is `{ options: CapacityPlanOption[], recommended_tier, feasible,
infeasibility_reason }`, not one flat plan. If the ask is infeasible on a laptop sandbox,
`feasible=false` + `infeasibility_reason` + a scaled-down alternative in the single fallback
option's `reasoning` (this powers demo UC-8).

## System prompt

The sizing formulas, tier rules, cost-estimate methodology, sandbox limits, and modify-operation
rules that used to live inline here now live in `agent-md-files/skills/sizing-workloads.md` — a
reusable skill (see the "Skills library" note in `README.md`) appended to this prompt at runtime by
`planner.ts` (`loadSkill("sizing-workloads")`), rather than duplicated text. Similarly, the
AWS worked-example rules live in `skills/managed-service-substitution.md` and the Enterprise
Architecture Advisor's reasoning framework lives in `skills/compliance-and-dr-reasoning.md`, each
spliced in only when applicable (`constraints.target==="aws"` / `enterprise_mode`).

```text
You are the Capacity Planner. Given a PlanRequest, produce a CapacityPlan JSON
matching the provided schema. Respond with ONLY JSON.

Unless a note appended below this prompt says otherwise (the AWS worked-example note overrides this to
exactly TWO options, the Enterprise Architecture Advisor note overrides this to exactly ONE), the
"options" array MUST contain EXACTLY THREE entries, one per tier, in this order: "economy", "balanced",
"high_availability" — never fewer, never more, never a single flat plan. Whichever count applies, it is
a hard structural requirement, not a suggestion: even when a tier's sizing converges with the tier below
it (identical replicas/cost at low load — see sizing-workloads.md), you still emit it as its own separate
array entry and say so in that tier's reasoning; never omit, merge, or collapse a tier just because its
numbers match another tier's. Before responding, count the entries in "options" and confirm the count
matches what applies to this request (3 by default, 2 for the AWS note, 1 for the enterprise note). Each
tier is a full CapacityPlanOption
(services/storage/network/reasoning/feasible/infeasibility_reason) plus:
estimated_cost_usd_monthly, headroom_pct, availability_notes, included_components,
skipped_components, task_graph, manual_estimate_person_days, agent_estimate_minutes,
scaling_strategy.

See the sizing-workloads skill (appended below) for the exact sizing formulas, tier rules, cost
estimate methodology, sandbox limits, modify-operation rules, and the scoping-narrative /
turnaround-estimate / scaling-strategy formulas for the fields above — cite the specific rule you used
in each tier's "reasoning", and never invent a manual-days/agent-minutes/scaling number outside that
formula. scaling_strategy is narrative only — this sandbox has no live autoscaler.
```

## Few-shot examples
- UC-1: 500 rps Node+Postgres → economy: ceil(500/250)=2 replicas; balanced: ceil(500*1.2/250)=3
  replicas + nginx + postgres; high_availability: 4 replicas. Each priced from the rate table.
- UC-5: Spring Boot → 1Gi memory with the JVM rule cited, same 3-tier shape.
- UC-8: 50,000 rps → `feasible=false`, single fallback option, alternative "2,000 rps with 4
  replicas" proposed.
- UC-9 (AWS target): see `USE_CASES.md` UC-9 for the AWS-specific 2-tier (economy/high_availability
  only, no balanced) managed-service variant of this same contract.
- UC-10 (scoping narrative): see `USE_CASES.md` UC-10 for a worked example of
  included_components/skipped_components/task_graph/manual_estimate_person_days/agent_estimate_minutes
  across all three tiers for a simple 3-service request.

## Tests (InfraGenies)
- 3 sample requests → InfraGenies signs off each plan as "what I'd actually do".
- Memory sum never exceeds the constraint; replica formula exact for rps ∈ {50, 200, 500, 900, 2000, 50000}.
