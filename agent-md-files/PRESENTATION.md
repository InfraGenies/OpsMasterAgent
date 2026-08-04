# Ops Master Agent — Presentation Source

Feed this whole file to Claude (or any AI) with a prompt like *"Turn this into a slide deck (PPTX/Google
Slides/Markdown-based slides), one `## Slide N` section per slide, bullets as bullet points, and the
`> Speaker notes:` blockquote as the notes field."* Each slide section below is self-contained — title,
bullet content, and (where useful) a diagram or table already formatted to drop straight onto a slide.
Sourced from `README.md`, `WORKFLOW.md`, `USE_CASES.md`, `AGENTS_AND_SKILLS.md`, and `CONTRACTS.md` in this
folder — update those first if facts change, then regenerate the deck from here rather than editing slide
content independently in two places.

Organized into six sections for a senior-leadership/technical audience: **1. Problem statement**,
**2. Proposed solution**, **3. Tools & technology**, **4. Agentic flow** (slides 8–11 — can be lifted into
its own standalone document if the deck runs long; the content already lives at
[`AGENTS_AND_SKILLS.md`](AGENTS_AND_SKILLS.md) and [`WORKFLOW.md`](WORKFLOW.md), this section just restates
it as slides), **5. Planning & implementation**, **6. Actual demo**.

**Suggested deck length:** 20 slides for a pitch/judge or VP/AVP audience (skip slides marked
*[technical]*), or all 24 for an engineering audience.

---

## SECTION 1 — PROBLEM STATEMENT

## Slide 1: Title

**Ops Master Agent**
Infra Lifecycle Automation — one sentence to a running, verified environment

> Speaker notes: Open with the one-line pitch: "One sentence → running verified environment in under 3
> minutes, versus 2–3 days of tickets. The AI plans, vetted templates constrain, a human approves, and
> every action is audited."

---

## Slide 2: The problem — what standing up infrastructure looks like today

Standing up new infrastructure — a new data center rack, cloud environment, dev/staging/prod-like
environment, or edge deployment — typically means:

- Manual capacity planning spread across spreadsheets and tribal knowledge, not an auditable record.
- Slow, siloed coordination between planning, procurement, networking, security, and ops teams.
- Error-prone manual deployment steps, with configuration drift between environments.
- Verification/testing done late and manually — issues surface after time and cost are already sunk.
- Long lead times from **"we need capacity"** to **"capacity is live and verified"**: engineers spend
  **days** raising tickets, coordinating approvals, configuring infrastructure, and validating environments
  before development or testing can even begin.
- These manual handoffs introduce delays, inconsistent configurations, deployment failures, and higher
  operational cost — slowing software delivery and reducing engineering productivity.

> Speaker notes: Ground this in the audience's own experience of waiting on infra tickets — this is the
> pain, not a hypothetical. This is especially acute for physical/hybrid infrastructure (data centers,
> on-prem, edge sites), where coordination across multiple teams and physical steps compounds every delay.

---

## Slide 3: Why this matters across every dimension of "good infrastructure"

The manual process above doesn't just cost time — it quietly erodes every quality an infra team is actually
accountable for:

| Dimension | What manual process gets wrong |
|---|---|
| Performance | Sizing decisions are guesses, not formulas — no consistent reasoning trail |
| Security | Policy/security review happens late, or not at all, before something is live |
| Scalability | Replica/load-balancer decisions aren't systematically tied to stated traffic |
| Reliability | No consistent rollback story when a deploy goes wrong |
| Availability | Multi-AZ/HA tradeoffs are ad hoc, not a standard menu of options |
| Maintainability | Configuration lives in someone's head or a wiki page, not a versioned artifact |
| Compliance | Mandatory controls for a framework (PCI-DSS, HIPAA, ...) are discovered late, if at all |

> Speaker notes: This slide reframes "it's slow" as "it's slow AND it's inconsistent across every axis a
> platform team is judged on" — sets up why the solution isn't just "make it faster," it's "make it
> faster and provably consistent."

---

## SECTION 2 — PROPOSED SOLUTION

## Slide 4: The idea

**Natural language in → capacity plan → infrastructure-as-code → human approval → live deployment →
verified report.** Fully audited at every step.

- The AI does the *thinking* (sizing, template selection, reasoning shown in plain English).
- The AI never has *unsupervised write access* — it fills pre-approved templates and never executes a raw
  shell command.
- A human always clicks approve before anything real happens.

> Speaker notes: This slide is the whole pitch in three bullets — don't rush past it.

---

## Slide 5: The five-stage pitch (as originally proposed)

An agentic AI system that converts a natural-language infrastructure request (e.g. *"I need a staging
environment for a Node.js API with Postgres, ~500 req/s"*) into a fully planned, deployed, and verified
environment:

1. **Plan** — AI analyzes the request and produces a capacity plan (compute, memory, replicas, storage)
   with reasoning shown.
2. **Generate** — AI generates Infrastructure-as-Code from pre-vetted, security-approved templates — the
   AI fills parameters; it never executes arbitrary commands.
3. **Approve** — A human reviews the plan and IaC before anything deploys (human-in-the-loop safety gate).
4. **Deploy** — The agent provisions the environment automatically, with rollback on failure.
5. **Verify** — Automated health checks and smoke tests confirm the environment meets the requested
   capacity before handoff.

> Speaker notes: This is the original five-stage proposal — Section 4 (Agentic Flow) shows what the built
> pipeline actually looks like today, which grew two more deterministic checkpoints beyond this.

---

## Slide 6: The two safety rules (repeat these to judges)

1. **The LLM never writes shell commands.** It only ever fills parameters into vetted
   Terraform/Docker-Compose *templates* — the deploy executor has a hard command allow-list
   (`docker compose up/down`, `terraform init/validate/plan`; `apply`/`destroy` are gated off by default
   for the AWS path — see Slide 22).
2. **Nothing deploys without a human click.** The pipeline pauses at a hard approval gate; state is
   checkpointed so approval still works even after a server restart.

> Speaker notes: This is the governance story judges score heaviest. State it plainly, twice if needed.

---

## Slide 7: What the human sees at the approval gate

- The full capacity plan, with the AI's reasoning in plain English (not just numbers).
- The generated Docker Compose / Terraform, diffed against the previous version for a modify request.
- Any policy/security findings the validator couldn't auto-fix.
- One click: approve, reject, edit and re-plan, or abandon.

> Speaker notes: If doing a live demo, this is the slide to linger on before switching to the browser.

---

## SECTION 3 — TOOLS & TECHNOLOGY

## Slide 8: Tech stack

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
> See `README.md`'s "Architecture decisions" for the full list of what changed and why.

---

## Slide 9: Contracts — the seam between every stage *[technical]*

- Four JSON contracts (`PlanRequest`, `CapacityPlan`, `IaCPayload`, `VerifyReport`) are the only things
  that ever cross a node boundary — frozen and validated (Zod schemas) so every stage can be built and
  tested independently.
- An LLM node's output is validated against its contract; a validation failure gets one retry with the
  error appended to the prompt, then the run fails cleanly rather than crashing.
- See [`CONTRACTS.md`](CONTRACTS.md) for the full shape of each.

> Speaker notes: For an engineering audience, this is the slide that shows the system is disciplined, not
> just a chain of prompts.

---

## SECTION 4 — AGENTIC FLOW

*(This section can be split into its own standalone document if the deck runs long — the source material
already lives at [`AGENTS_AND_SKILLS.md`](AGENTS_AND_SKILLS.md) and [`WORKFLOW.md`](WORKFLOW.md).)*

## Slide 10: Pipeline flow (diagram)

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

## Slide 11: Who does what — one line per agent

| # | Agent | Role | Calls LLM? |
|---|---|---|---|
| — | Orchestrator | Owns the state machine, routes every transition, persists state so approval survives a restart | No |
| 1 | Intake | Free text → validated `PlanRequest`, or refuse unsafe/nonsensical asks | Yes |
| 2 | Planner | Sizes services (CPU/memory/replicas/storage), prices 2–3 cost tiers, reasoning shown | Yes |
| 2b | Readiness check | Pre-flight scan (docker daemon, ports, disk) before spending an LLM call on IaC | No |
| 2c | Compliance check | Enterprise mode only: checks recommended controls against the stated framework | No |
| 3 | IaC Generator | Fills a vetted template, or writes IaC from scratch when nothing fits | Yes |
| 3b | Policy Validator | Deterministic security scan, self-corrects auto-fixable findings | No |
| 4 | Approval Gate(s) | Human reviews the plan, then the generated code — hard stop, no auto-approve | No (human) |
| 4b | Build | Clones/builds a real reference app from a hardcoded, commit-pinned registry | No |
| 5 | Deploy | Executes only allow-listed commands, streams logs live | No |
| 6 | Verify | Health checks + load test against the plan's stated traffic; red → auto-rollback | Yes (summarizes) |
| 6b | Rollback | Tears down or restores previous state via the same command allow-list | No |
| 7 | Report | Final narrative: endpoints, metrics, full audit timeline | Yes |
| — | Audit Store | Durable record of every node's input/output/command/decision | No |

> Speaker notes: This table is the backbone of the "how do the agents coordinate" question — each agent
> has exactly one job and a clear LLM/no-LLM boundary. Full detail (skills used, spec file) in
> `AGENTS_AND_SKILLS.md`.

---

## Slide 12: Extensibility — skills & datasets *[technical]*

- Reusable **skill** modules (sizing formulas, IaC-writing conventions, compliance reasoning) are spliced
  into node prompts at runtime from their own files — editing a skill changes every node that uses it, no
  code change.
- Proposed **dataset files** take this one step further: the actual numbers (rate tables, sizing
  benchmarks) move into structured JSON that prompts, mock code, and deterministic logic can all read from
  one place, instead of being retyped in three.
- See `AGENTS_AND_SKILLS.md` and `DATASETS.md` for the full picture.

> Speaker notes: Good slide for "how would this scale to more workload types" questions.

---

## SECTION 5 — PLANNING & IMPLEMENTATION

## Slide 13: Full audit trail

- Every node's input, output, and any command it ran is persisted immediately — not held in memory.
- A human's approval decision can arrive **after a server restart** and the pipeline resumes correctly,
  because the next step always re-reads its input from the audit trail, not from memory.
- Nothing about "what happened and why" depends on the server having stayed up the whole time.

> Speaker notes: This is a genuine engineering differentiator, not just a compliance checkbox — say so.

---

## Slide 14: AWS path — multi-tier costing *[technical]*

- Beyond local Docker Compose, the planner can target AWS: it produces **priced, differently-shaped**
  tiers (containerized services vs. RDS/DynamoDB/ElastiCache managed substitutes), not just a replica-count
  scale-up.
- Renders real Terraform against AWS's own reference modules (ECS Fargate for the economy tier, EKS for
  the high-availability tier).
- **Default safety boundary:** the allow-list permits `terraform init`/`validate`/`plan` unconditionally;
  `apply`/`destroy` only become reachable when a machine explicitly sets `ALLOW_AWS_APPLY=true` — off
  everywhere else, including this demo's own CI/smoke test. See Slide 22 for the live-apply demo.
- **Roadmap — a second, faster real-AWS pattern (UC-14):** a single-container Fargate + ALB deploy
  (AWS's own `aws-copilot-sample-service`) — no RDS/DynamoDB/ElastiCache, stands up/tears down in a couple
  of minutes, faster than either of UC-9's tiers. The `BUILD_REGISTRY` wiring to clone/build it is already
  done (runnable today via docker-compose); what's still missing is a hand-rolled Terraform template, since
  unlike `retail-store-sample-app` this repo ships no Terraform module of its own to wrap.

> Speaker notes: Emphasize that the safety boundary is a deliberate, gated default — not an accident of
> what wasn't built yet.

---

## Slide 15: Enterprise Architecture Advisor mode *[technical]*

- When a request describes a *business*, not just an app (compliance target, team size, RPO/RTO,
  industry), the pipeline layers in an architecture recommendation: platform archetype, a weighted
  criticality score, and every mandatory control the stated compliance framework requires.
- A compliance-check step flags any gap between the recommended architecture and what the framework
  actually mandates — surfaced to the human, never silently blocking.
- Generalizes beyond canned examples — validated against a held-out scenario during development, not just
  the scenario it was designed around.

> Speaker notes: Good slide if the audience includes anyone thinking about regulated-industry customers.

---

## Slide 16: The ROI pitch, quantified

Every priced tier carries a **scoping narrative**, not just services and cost:

- **What's in vs. out, and why** — `included_components` names each service and the reason it's there;
  `skipped_components` calls out genuine tradeoffs a reviewer would want flagged.
- **The provisioning steps**, laid out as a `task_graph` a human recognizes — not a new decision, just the
  plan already made, shown as steps.
- **Manual vs. agent turnaround** — a worked example (3-developer startup, Node+Postgres+Redis): **~2.5
  person-days** for a human platform team to plan and stand this up, versus **~22 minutes** for this
  pipeline. The high-availability tier scales to ~3.5 person-days manually vs. still well under an hour here.

> Speaker notes: This is the slide that turns "AI writes YAML" into a business case — lead with the
> person-days-vs-minutes number. See `USE_CASES.md` UC-13 for the full captured example.

---

## Slide 17: Status — what's working today

- All pipeline nodes implemented and exercised by an in-process smoke test (no browser, no external LLM
  call required).
- UC-1, UC-2, UC-8 (refusal), and UC-9 (AWS/Terraform, plan-only) run end-to-end in the smoke test; UC-7
  (modify), UC-13 (scoping narrative), and UC-3/4/5/6 are demoed manually through the UI.
- Three new use cases (docker-compose, manual UI demo, not yet in the smoke script): **UC-15**
  (Vite/React static frontend) and **UC-16** (nginx-hello live-hostname demo) prove the build-sentinel path
  generalizes beyond the UC-1/UC-2 RealWorld pair — no db, no pairing, and (UC-16) the first repo whose
  Dockerfile isn't at the repo root. **UC-14** (AWS single-container Fargate+ALB) is `BUILD_REGISTRY`-wired
  but still needs a hand-rolled Terraform template before it's a real end-to-end AWS demo — see Slide 14.
- See `README.md`'s "Project status" section for the current per-use-case breakdown.

> Speaker notes: Be honest about what's smoke-tested vs. manually demoed — it's a strength, not a gap, to
> be precise about this.

---

## SECTION 6 — ACTUAL DEMO

## Slide 18: Demo plan for today

Four short segments, in order:

| # | Segment | Mode | Proves |
|---|---|---|---|
| 1 | UC-13 scoping narrative | Plan-only (no deploy) | The AI's reasoning stands on its own — sizing, cost tiers, included/skipped tradeoffs, manual-vs-agent turnaround |
| 2 | UC-2 → UC-1 | Physical deployment, local Docker | Fastest happy path, then the flagship end-to-end deploy (the exact sentence from the brief) |
| 3 | UC-7 and/or UC-8 | Physical deployment, local Docker | Lifecycle management (modify a running env) and responsible-AI governance (refusal + rollback) |
| 4 | UC-9 | **Real AWS deploy**, short-lived | The same discipline (plan → human approval → deploy → verify) against a real cloud account, torn down within the hour |

> Speaker notes: Segment 1 needs nothing running and never risks a live-demo failure — good opener if the
> room is skeptical the AI is "just calling an API." Segments 2–3 are the local Docker use cases (must-have:
> UC-2 + UC-1; add UC-7 and/or UC-8 if time allows — prioritize UC-8 if the slot gets cut short, since
> governance/refusal/rollback is the story that resonates most with a VP/AVP audience). Segment 4 is the
> one live AWS use case.

---

## Slide 19: Demo segment 1 — Plan-only mode (UC-13)

*"We're a 3-developer startup team building a Node.js API with PostgreSQL and Redis for early customers,
light traffic for now."*

- Stops after the planner (and compliance check, if enterprise-mode triggers) — **no IaC, no deploy, no
  approval-gate risk**. Nothing to fail live.
- Shows: 3 priced tiers (economy/balanced/high_availability), `included_components`/`skipped_components`
  reasoning, the `task_graph` of provisioning steps, and the manual-vs-agent turnaround estimate
  (2.5 person-days vs. ~22 minutes for the economy tier).
- Exists specifically for scoping/estimation conversations where generating deployable IaC would be
  premature.

> Speaker notes: This is the safest possible opening demo — it's pure reasoning, no infrastructure touched
> at all, so there's zero live-demo risk while still showing the AI's judgment.

---

## Slide 20: Demo segment 2 — Physical deployment on local Docker (UC-2 → UC-1)

| UC | Scenario | Proves |
|---|---|---|
| UC-2 | *"Spin up a dev environment for a simple Node.js todo app, low traffic, single instance."* | Fastest happy path — a real, browser-rendered fullstack app (not a placeholder), opener demo |
| UC-1 | *"Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second."* | The flagship: the exact sentence from the brief, end-to-end — capacity plan → compose file → approve → up → load test @ 500 rps → green report |

Both deploy real containers on this machine via Docker Compose — the same allow-listed
`docker compose up -d --wait` executor either way.

> Speaker notes: UC-1 is the moment to slow down — narrate the plan, the generated compose file, the
> approval click, then watch the containers come up live.

---

## Slide 21: Demo segment 3 — Lifecycle & governance on local Docker (UC-7 / UC-8)

| UC | Scenario | Proves |
|---|---|---|
| UC-7 | *"Add a Redis cache to the staging environment we just created and wire the app to it."* (extends UC-1) | The agent reads its own audit/state store, plans a *delta*, and shows a diff for approval — lifecycle management, not just one-shot provisioning |
| UC-8 | *"Provision production with 50,000 req/s and five-nines availability."* → refused with reasoning. Then: approve a plan with Docker Desktop stopped → auto-rollback. | Responsible-AI governance: the system says no when it should, and recovers cleanly when a deploy fails |

> Speaker notes: If time is short, UC-8 is the one to keep — governance/refusal/rollback is what a
> VP/AVP technical-leadership audience tends to weigh most heavily when evaluating platform risk.

---

## Slide 22: Demo segment 4 — Real AWS deployment (UC-9), short-lived

*"Deploy the retail-store-sample-app to AWS for a staging environment — give me a cost-conscious option and
a highly-available option, with pricing for each."*

- Same pipeline, same human approval gate — the only difference is the target: real Terraform against AWS,
  not Docker Compose.
- **By default this stays plan-only** (`terraform init`/`validate`/`plan` — the allow-list permits nothing
  else). For this demo, the machine has `ALLOW_AWS_APPLY=true` set, which additionally allows a real
  `terraform apply` of the exact plan a human already approved, using the ECS Fargate economy tier
  (stands up/tears down in minutes — the EKS high-availability tier takes ~15–20 minutes each way and
  doesn't fit a short slot).
- `verify` health-checks the real, live endpoint from `terraform output` — no load test against it
  (unnecessary risk for a fresh AWS service in a short demo).
- **Torn down within minutes:** immediately after a successful apply, `.\schedule-auto-destroy.ps1` is run
  in the deployment's folder — a cost-safety timer (default 10 min) that runs `terraform destroy`
  automatically even if the demo forgets to, so the environment can't outlive the session. A failed
  deploy/verify during the demo would trigger the same real `terraform destroy` automatically via rollback.

> Speaker notes: State explicitly that this capability is off everywhere except this one demo machine —
> every judge/contributor cloning this repo gets the safe, plan-only UC-9 by default. This is the one
> segment with real (if small — well under $1 for the demo window) AWS cost; that's a deliberate,
> disclosed tradeoff for showing the full loop against a real cloud account.

---

## Slide 23: Responsible-AI recap — refusal and rollback

- **Refusal:** the planner recognizes an infeasible ask, explains why in plain English, and proposes a
  scaled-down alternative that **would** fit — instead of silently failing or overselling capacity.
- **Rollback:** deploy or verify failure automatically tears down (or restores, for a modify) rather than
  leaving a half-provisioned environment behind. One bounded retry absorbs transient failures; a genuine
  config error still fails identically and still rolls back.
- **AWS-specific:** the same rollback path now runs a real `terraform destroy` when the live-apply demo's
  build/deploy/verify fails — and the auto-destroy timer (Slide 22) covers the success case too.
- Every step of every rollback is in the same audit trail as everything else.

> Speaker notes: Judges specifically look for "AI says no, and recovers from failure" — this slide ties
> both halves of that story together, including the new AWS teardown guarantees.

---

## Slide 24: Closing

**One sentence → running, verified environment. The AI plans, vetted templates constrain, a human
approves, and every action is audited.**

Questions?

> Speaker notes: Circle back to the one-line pitch from Slide 1 to close the loop.
