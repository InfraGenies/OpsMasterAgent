# Ops Master Agent — Team 8 Build Pack

Agentic AI infrastructure lifecycle automation: **one sentence → capacity plan → IaC → human approval → live deployment → verified report**, fully audited.

## What's in this pack

```
ops-master-agent/
├── README.md            ← you are here
├── INSTALLATION.md      ← tools, IS/firewall requests, verification checklist
├── USE_CASES.md         ← 7 demo scenarios with verified GitHub repos
├── WORKFLOW.md          ← flow diagram (Mermaid + ASCII) + state machine + safety rules
├── AGENTS_AND_SKILLS.md ← one-page index: each node's responsibility + which skill files it uses
├── DATASETS.md          ← proposal: structured data files backing skills/prompts/mock code's numbers
├── PRESENTATION.md      ← slide-by-slide source for generating a pitch/technical deck
├── contracts/
│   └── CONTRACTS.md     ← the 4 JSON contracts — FREEZE THESE ON DAY 1
├── skills/              ← reusable knowledge modules spliced into node prompts at runtime
├── datasets/            ← example structured data files (see DATASETS.md) — not yet wired into code
└── agents/
    ├── 00-orchestrator.md   (InfraGenies — LangGraph graph, code not prompt)
    ├── 01-intake.md         (InfraGenies — NL → PlanRequest, safety filter)
    ├── 02-planner.md        (InfraGenies — capacity plan + sizing rules)
    ├── 03-iac-generator.md  (InfraGenies — template filling, never free-writing)
    ├── 04-approval-gate.md  (InfraGenies — human-only hard stop)
    ├── 05-deploy-agent.md   (InfraGenies — allow-listed executor + rollback)
    ├── 06-verify-agent.md   (InfraGenies — health checks + k6 smoke)
    └── 07-audit-store.md    (InfraGenies — SQLite audit/state + DB decision)
```

This original pack has since grown three more agent specs (`02b-readiness-check.md`,
`02c-compliance-check.md`, `03b-policy-validator.md`) beyond the original 7 — see
[`AGENTS_AND_SKILLS.md`](AGENTS_AND_SKILLS.md) for the full, current node-by-node responsibility list and
[the root README](../README.md#architecture-decisions) for why each was added.

## How to use these files in VS Code

1. **Drop the folder into the repo root.** Each agent md contains its system prompt in a fenced ```text block — the backend loads it at runtime:
   ```python
   def load_prompt(agent_md: str) -> str:
       text = Path(f"agents/{agent_md}").read_text()
       return text.split("```text")[1].split("```")[0].strip()
   ```
   Editing an agent's behaviour = editing its md file. No code change, instant iteration, and the prompt is version-controlled next to its spec.
2. **AI pair-programming:** point Copilot Chat / Claude Code at an agent md (`@workspace` or drag the file in) and ask it to "implement this node against contracts/CONTRACTS.md" — the specs are written to be directly consumable as build instructions.
3. **Mermaid preview:** install `bierner.markdown-mermaid` to render WORKFLOW.md's diagram inside VS Code.

## Build order (maps to the guide's Day plan)

1. **Day 1–2:** Freeze `contracts/CONTRACTS.md`. Scaffold graph from `00-orchestrator.md` with stubbed nodes. InfraGenies writes `compose-single-v1` + `compose-web-db-v1` templates. File the Docker Desktop IS ticket (see INSTALLATION.md §0).
2. **Day 3–5:** Intake + Planner producing signed-off plans for UC-1/2/3. IaC generator filling templates, `docker compose config -q` clean.
3. **Day 6–8:** Deploy executor + rollback (InfraGenies). Verify suite (InfraGenies). UC-1 green end-to-end from CLI.
4. **Day 9–11:** React chat + pipeline progress + approval gate UI + audit timeline.
5. **Day 12+:** UC-7 (modify) + UC-8 (refusal/rollback) + rehearse.

## The one-line pitch

> "One sentence → running verified environment in under 3 minutes, versus 2–3 days of tickets. The AI plans, vetted templates constrain, a human approves, and every action is audited."
