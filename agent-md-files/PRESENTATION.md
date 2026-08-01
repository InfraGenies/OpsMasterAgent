# Ops Master Agent — Presentation Source

Feed this whole file to Claude (or any AI) with a prompt like *"Turn this into a slide deck (PPTX/Google
Slides/Markdown-based slides), one `## Slide N` section per slide, bullets as bullet points, and the
`> Speaker notes:` blockquote as the notes field."* Each slide section below is self-contained — title,
bullet content, and (where useful) a diagram or table already formatted to drop straight onto a slide.
Sourced from `README.md`, `WORKFLOW.md`, `USE_CASES.md`, `AGENTS_AND_SKILLS.md`, and `CONTRACTS.md` in this
folder — update those first if facts change, then regenerate the deck from here rather than editing slide
content independently in two places.

**Suggested deck length:** 16 slides for a pitch/judge audience (skip slides marked *[technical]*), or all
19 for an engineering audience.

---

## Slide 1: Title

**Ops Master Agent**
Infra Lifecycle Automation — one sentence to a running, verified environment

> Speaker notes: Open with the one-line pitch: "One sentence → running verified environment in under 3
> minutes, versus 2–3 days of tickets. The AI plans, vetted templates constrain, a human approves, and
> every action is audited."

---

## Slide 2: The problem

- Standing up a new environment (dev/staging/prod-like) today means filing a ticket and waiting **2–3
  days** for a human ops engineer to size it, write the IaC, and provision it.
- Every step is manual, slow, and inconsistently documented — sizing decisions live in someone's head, not
  in an audit trail.
- Teams need this to be self-service *without* losing the safety net a human ops reviewer provides.

> Speaker notes: Ground this in the audience's own experience of waiting on infra tickets — this is the
> pain, not a hypothetical.

---

## Slide 3: The idea

**Natural language in → capacity plan → infrastructure-as-code → human approval → live deployment →
verified report.** Fully audited at every step.

- The AI does the *thinking* (sizing, template selection, reasoning shown in plain English).
- The AI never has *unsupervised write access* — it fills pre-approved templates and never executes a raw
  shell command.
- A human always clicks approve before anything real happens.

> Speaker notes: This slide is the whole pitch in three bullets — don't rush past it.

---

## Slide 4: The two safety rules (repeat these to judges)

1. **The LLM never writes shell commands.** It only ever fills parameters into vetted
   Terraform/Docker-Compose *templates* — the deploy executor has a hard command allow-list
   (`docker compose up/down`, `terraform init/validate/plan`; note `apply`/`destroy` are intentionally
   **not** allow-listed for the AWS path — see Slide 14).
2. **Nothing deploys without a human click.** The pipeline pauses at a hard approval gate; state is
   checkpointed so approval still works even after a server restart.

> Speaker notes: This is the governance story judges score heaviest. State it plainly, twice if needed.

---

## Slide 5: Pipeline flow (diagram)

```
User NL request
      │
      ▼
 Chat UI ───────────────────────────────┐
      │                                 │ live progress via WebSocket
      ▼                                 │
 Orchestrator (audit-trail-backed state machine)
      │
 1. INTAKE ──invalid──► REFUSE (reasoned) ──► audit + report
      │ PlanRequest
      ▼
 2. PLANNER ──► CapacityPlan (priced tiers, reasoning shown)
      │
      ▼
 2b. READINESS CHECK (no LLM) ──not ready──► REFUSE (reasoned)
      │ ready
      ▼
 3. IaC GENERATOR (pre-approved templates, or freeform when nothing fits) ──► IaCPayload
      │
      ▼
 3b. POLICY & SECURITY VALIDATOR (no LLM) ──unresolved, auto-fixable──┐
      │ passed                                                        │
      │◄──────────────────────────────────── back to IaC GENERATOR ──┘
      ▼
 4. ██ HUMAN APPROVAL GATE(S) ██  ◄── rejected/edited ──┐
      │ approved                                        │ loops to Planner
      ▼                                                  │
 5. DEPLOY (vetted commands only) ──fail──► ROLLBACK ────┤
      │ up                                                │
      ▼                                                   │
 6. VERIFY (health + load test) ──red──► ROLLBACK ────────┤
      │ green                                             │
      ▼                                                   ▼
 7. REPORT  ◄──────────────────────────────── failure report
```

> Speaker notes: Walk left to right. Emphasize the two loop-backs (policy validator self-correction, and
> approval-gate rejection) — the pipeline isn't a rigid one-way pipe, it corrects itself and defers to
> humans when it should.

---

## Slide 6: Pipeline stages, what each one does

| # | Stage | Does |
|---|---|---|
| 1 | Intake | Free text → validated request, or refuse unsafe/nonsensical asks |
| 2 | Planner | Sizes services (CPU/memory/replicas/storage), prices 2–3 cost tiers, reasoning shown |
| 2b | Readiness check | Pre-flight scan (docker daemon, ports, disk) before spending an LLM call on IaC |
| 3 | IaC Generator | Fills a vetted template, or writes IaC from scratch when nothing fits |
| 3b | Policy Validator | Deterministic security scan, self-corrects auto-fixable findings |
| 4 | Approval Gate(s) | Human reviews the plan, then the generated code — hard stop, no auto-approve |
| 5 | Deploy | Executes only allow-listed commands, streams logs live |
| 6 | Verify | Health checks + load test against the plan's stated traffic; red → auto-rollback |
| 7 | Report | Final narrative: endpoints, metrics, full audit timeline |

> Speaker notes: This table is the backbone of the deck — most other slides zoom into one row.

---

## Slide 7: Demo use cases

| UC | Scenario | Proves |
|---|---|---|
| UC-2 | Simple dev environment | Fastest happy path — opener demo |
| UC-1 | Node.js + PostgreSQL @ 500 rps | The flagship: the exact sentence from the brief, end-to-end |
| UC-7 | Add Redis to a running environment | Lifecycle management, not just one-shot provisioning |
| UC-8 | Refusal + rollback | Responsible-AI governance: says no, and recovers from failure |
| UC-9 | AWS/Terraform multi-tier costing | Real managed-service substitution, priced cost tiers, Terraform output |

> Speaker notes: Recommended live-demo order is UC-2 → UC-1 → UC-7 → UC-8 (simple → flagship → modify →
> governance). UC-9 is a strong bonus if there's time.

---

## Slide 8: What the human sees at the approval gate

- The full capacity plan, with the AI's reasoning in plain English (not just numbers).
- The generated Docker Compose / Terraform, diffed against the previous version for a modify request.
- Any policy/security findings the validator couldn't auto-fix.
- One click: approve, reject, or edit and re-plan.

> Speaker notes: If doing a live demo, this is the slide to linger on before switching to the browser.

---

## Slide 9: The ROI pitch, quantified

Every priced tier now carries a **scoping narrative**, not just services and cost:

- **What's in vs. out, and why** — `included_components` names each service and the reason it's there;
  `skipped_components` calls out genuine tradeoffs a reviewer would want flagged (e.g. "Multi-AZ
  redundancy: skipped, cost-sensitive economy tier"), not a noisy list of every feature that wasn't
  relevant.
- **The provisioning steps**, laid out as a `task_graph` a human recognizes — not a new decision, just the
  plan already made, shown as steps.
- **Manual vs. agent turnaround** — a worked example (3-developer startup, Node+Postgres+Redis): **~2.5
  person-days** for a human platform team to plan and stand this up, versus **~22 minutes** for this
  pipeline to plan, generate, and validate it. The high-availability tier (adds a replica + load balancer)
  scales to ~3.5 person-days manually vs. still well under an hour end-to-end here.

> Speaker notes: This is the slide that turns "AI writes YAML" into a business case — lead with the
> person-days-vs-minutes number, it's the most concrete number in the whole deck. See `USE_CASES.md` UC-13
> for the full captured example this is drawn from.

---

## Slide 10: Responsible-AI moment — refusal

*"Provision production with 50,000 req/s and five-nines availability."*

→ The planner recognizes this exceeds the sandbox's feasible limits, explains why in plain English, and
proposes a scaled-down alternative that **would** fit — instead of either silently failing or overselling
what the sandbox can actually do. Nothing is deployed.

> Speaker notes: This is the "AI says no, and explains why" moment — judges specifically look for this.

---

## Slide 11: Responsible-AI moment — rollback

- Deploy or verify fails → the pipeline automatically rolls back rather than leaving a half-provisioned
  environment behind.
- `create` failures tear down everything (including volumes); `modify` failures restore the previous
  environment's files without touching existing data.
- One bounded retry (3s pause) absorbs failures that look transient (a port still releasing, an
  image-pull timeout) — a genuine config error still fails identically and still rolls back.
- Every step of the rollback is in the same audit trail as everything else.

> Speaker notes: Pair this with Slide 10 — refusal and rollback are the two halves of the governance story.

---

## Slide 12: Full audit trail

- Every node's input, output, and any command it ran is persisted immediately — not held in memory.
- A human's approval decision can arrive **after a server restart** and the pipeline resumes correctly,
  because the next step always re-reads its input from the audit trail, not from memory.
- Nothing about "what happened and why" depends on the server having stayed up the whole time.

> Speaker notes: This is a genuine engineering differentiator, not just a compliance checkbox — say so.

---

## Slide 13: Extensibility — skills & datasets *[technical]*

- Reusable **skill** modules (sizing formulas, IaC-writing conventions, compliance reasoning) are spliced
  into node prompts at runtime from their own files — editing a skill changes every node that uses it, no
  code change.
- Proposed **dataset files** take this one step further: the actual numbers (rate tables, sizing
  benchmarks) move into structured JSON that prompts, mock code, and deterministic logic can all read from
  one place, instead of being retyped in three.
- See `AGENTS_AND_SKILLS.md` and `DATASETS.md` for the full picture.

> Speaker notes: Good slide for "how would this scale to more workload types" questions.

---

## Slide 14: AWS path — multi-tier costing *[technical]*

- Beyond local Docker Compose, the planner can target AWS: it produces **priced, differently-shaped**
  tiers (containerized services vs. RDS/DynamoDB/ElastiCache managed substitutes), not just a replica-count
  scale-up.
- Renders real Terraform against AWS's own reference modules (ECS Fargate for the economy tier, EKS for
  the high-availability tier).
- **Hard safety boundary:** the allow-list permits `terraform init`/`validate`/`plan` only — `apply` and
  `destroy` are deliberately absent, so there is no code path from this feature to a real AWS bill.

> Speaker notes: Emphasize the safety boundary explicitly — this is what makes it safe to demo an AWS
> path without an AWS account or real spend risk.

---

## Slide 15: Enterprise Architecture Advisor mode *[technical]*

- When a request describes a *business*, not just an app (compliance target, team size, RPO/RTO,
  industry), the pipeline layers in an architecture recommendation: platform archetype, a weighted
  criticality score, and every mandatory control the stated compliance framework requires.
- A compliance-check step flags any gap between the recommended architecture and what the framework
  actually mandates — surfaced to the human, never silently blocking.
- Generalizes beyond canned examples — validated against a held-out scenario during development, not just
  the scenario it was designed around.
- Produced via two focused LLM calls (full high-availability posture, then a cost-reduced economy tier)
  rather than one large combined ask — a reliability fix after the combined version proved unreliable in
  practice against a real model.

> Speaker notes: Good slide if the audience includes anyone thinking about regulated-industry customers.

---

## Slide 16: Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js/TypeScript, Express + WebSocket |
| Frontend | React + Tailwind |
| LLM | Claude (Anthropic), with a deterministic mock mode for offline dev/CI |
| Audit/state store | Supabase (Postgres), local-JSON fallback for zero-config dev |
| IaC targets | Docker Compose (4 templates) + Terraform (AWS: ECS Fargate, EKS) |
| Load testing | autocannon (pure Node — no container/VM networking dependency) |

> Speaker notes: Mention this is a from-scratch TypeScript implementation of a spec originally written for
> Python/LangGraph/SQLite — same architecture and safety guarantees, different stack, by explicit steer.

---

## Slide 17: Contracts — the seam between every stage *[technical]*

- Four JSON contracts (`PlanRequest`, `CapacityPlan`, `IaCPayload`, `VerifyReport`) are the only things
  that ever cross a node boundary — frozen and validated (Zod schemas) so every stage can be built and
  tested independently.
- An LLM node's output is validated against its contract; a validation failure gets one retry with the
  error appended to the prompt, then the run fails cleanly rather than crashing.

> Speaker notes: For an engineering audience, this is the slide that shows the system is disciplined, not
> just a chain of prompts.

---

## Slide 18: Status — what's working today

- All pipeline nodes implemented and exercised by an in-process smoke test (no browser, no external LLM
  call required).
- UC-1, UC-2, UC-8 (refusal), and UC-9 (AWS/Terraform) run end-to-end in the smoke test; UC-7 (modify),
  UC-13 (scoping narrative), and UC-3/4/5/6 are demoed manually through the UI.
- See `README.md`'s "Project status" section for the current per-use-case breakdown.

> Speaker notes: Be honest about what's smoke-tested vs. manually demoed — it's a strength, not a gap, to
> be precise about this.

---

## Slide 19: Closing

**One sentence → running, verified environment. The AI plans, vetted templates constrain, a human
approves, and every action is audited.**

Questions?

> Speaker notes: Circle back to the one-line pitch from Slide 1 to close the loop.
