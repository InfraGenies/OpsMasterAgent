# Dataset files — proposal, and how they'd improve the skills library

## The problem this solves

Every numeric "rule" the pipeline reasons with today lives in **prose**, and often in more than one place:

- `skills/sizing-workloads.md` has the rps-per-instance/memory table as bullet points inside its fenced
  ` ```text ` block — text the LLM reads, not data the code reads.
- `apps/server/src/nodes/planner.ts`'s `mockPlanner()` re-implements the *same* rules as TypeScript
  `if`/`switch` logic, by hand, so mock mode stays behaviorally consistent with the real-LLM prompt (see
  `CLAUDE.md`'s "Mock mode" section — this pairing is explicit and deliberate, not an accident).
- `agent-md-files/USE_CASES.md` UC-9 documents an illustrative AWS rate table (Fargate/RDS/EKS/NAT
  $/hour figures) in prose, used nowhere else — not in a prompt, not in code.
- `nodes/enterpriseRulesEngine.ts` has its own hardcoded cost/control tables for managed-service pricing
  and compliance-control mappings.

Four independent places that must agree on the same numbers, kept in sync entirely by a human remembering
to update all of them. A **dataset file** is a small, structured (JSON) file holding just the numeric
table — no prose, no reasoning framing — that every one of those four consumers can read from instead of
re-typing. This is the same one-source-of-truth motivation that drove the skills library itself (see the
root `README.md`'s "fifth addition"); datasets are the same idea one level more granular, for the actual
numbers rather than the reasoning text around them.

## Proposed convention (mirrors the skills library exactly)

```
agent-md-files/datasets/<name>.json      ← source of truth, hand-edited, reviewed like any other spec file
apps/server/src/datasets/<name>.json     ← runtime copy the server actually reads (keep in sync, same as
                                            prompts/ and skills/ already work)
apps/server/src/llm/datasetLoader.ts     ← loadDataset<T>(name): T — plain JSON.parse + a Zod schema,
                                            no ```text fence needed since this is data, not prompt prose
```

A skill's prompt can then be **generated**, not hand-typed: a small render function turns the dataset's
rows into the exact bullet-list format the model currently reads verbatim, e.g.
`renderSizingTable(loadDataset("runtime-sizing-benchmarks"))` producing the same
`- Node.js/Express CRUD API: ~250 rps per instance...` lines `sizing-workloads.md` has today. The prompt
wording (how to phrase the rule, what to cite in reasoning) stays hand-written prose; only the *numbers*
move to the dataset. Deterministic code (`mockPlanner()`, `enterpriseRulesEngine.ts`) imports the same
dataset directly — no TypeScript re-typing of numbers that must match the prompt by hand.

## Two example datasets (added in this pass)

Both are **additive only** — not yet wired into any prompt or code path, so this pass changes no pipeline
behavior. They exist to (a) prove the format works for the two clearest candidates already in the repo, and
(b) let contributors extend a table by editing JSON instead of hunting for every prose/code copy.

- [`datasets/runtime-sizing-benchmarks.json`](datasets/runtime-sizing-benchmarks.json) — the rps-per-instance/memory/CPU
  table from `skills/sizing-workloads.md`'s opening bullet list.
- [`datasets/aws-pricing-rates.json`](datasets/aws-pricing-rates.json) — the illustrative AWS rate table from
  `USE_CASES.md` UC-9 (Fargate vCPU/GB-hour, RDS/ElastiCache instance-hour, EKS control plane, NAT Gateway).

## Suggested next steps (not done here — each is its own reviewable change)

1. Add `datasetLoader.ts` + a Zod schema per dataset shape, and a `render*()` helper for the one skill file
   you're migrating first (start with `sizing-workloads.md` — it's the highest-traffic skill, used on
   every planner call).
2. Point `mockPlanner()`'s sizing `if`/`switch` logic at the same dataset instead of its own hardcoded
   numbers, and re-run `npm run smoke -w @ops-master/server` to confirm UC-1/UC-5's sizing output is
   unchanged (it should be byte-for-byte identical, since the numbers aren't changing — only where they
   live).
3. Repeat for `managed-service-substitution.md` (wire the new `aws-pricing-rates.json` into the
   `estimated_cost_usd_monthly` UC-9 worked example) and `enterpriseRulesEngine.ts`'s cost/control tables
   once the pattern is proven.
4. Only after the above are stable: consider whether a dataset ever needs to be *queried* (e.g. a real
   AWS Price List API lookup) rather than *read whole* — that's a materially different feature (a live
   data source, not a static file) and shouldn't be conflated with this file-based convention.

## Why not do all of this in one pass

Wiring live pipeline code (`planner.ts`, `enterpriseRulesEngine.ts`) to a new data source touches
LLM-prompt-adjacent behavior with no unit tests to catch a subtle mismatch — only the smoke test's few
scenarios. Doing it table-by-table, confirming the smoke test's captured output is unchanged after each
one, is much lower risk than moving every table at once.
