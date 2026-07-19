# Ops Master Agent — Team 8 Build Pack

Agentic AI infrastructure lifecycle automation: **one sentence → capacity plan → IaC → human approval → live deployment → verified report**, fully audited.

## What's in this pack

```
ops-master-agent/
├── README.md            ← you are here
├── INSTALLATION.md      ← tools, IS/firewall requests, verification checklist
├── USE_CASES.md         ← 7 demo scenarios with verified GitHub repos
├── WORKFLOW.md          ← flow diagram (Mermaid + ASCII) + state machine + safety rules
├── contracts/
│   └── CONTRACTS.md     ← the 4 JSON contracts — FREEZE THESE ON DAY 1
└── agents/
    ├── 00-orchestrator.md   (Ravikumar — LangGraph graph, code not prompt)
    ├── 01-intake.md         (Ravikumar — NL → PlanRequest, safety filter)
    ├── 02-planner.md        (Ravikumar + Anshul — capacity plan + sizing rules)
    ├── 03-iac-generator.md  (Ravikumar + Anshul — template filling, never free-writing)
    ├── 04-approval-gate.md  (Anshul + Ravikumar — human-only hard stop)
    ├── 05-deploy-agent.md   (Aparna — allow-listed executor + rollback)
    ├── 06-verify-agent.md   (Anirudha — health checks + k6 smoke)
    └── 07-audit-store.md    (Ravikumar + Anshul — SQLite audit/state + DB decision)
```

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

1. **Day 1–2:** Freeze `contracts/CONTRACTS.md`. Scaffold graph from `00-orchestrator.md` with stubbed nodes. Anshul writes `compose-single-v1` + `compose-web-db-v1` templates. File the Docker Desktop IS ticket (see INSTALLATION.md §0).
2. **Day 3–5:** Intake + Planner producing signed-off plans for UC-1/2/3. IaC generator filling templates, `docker compose config -q` clean.
3. **Day 6–8:** Deploy executor + rollback (Aparna). Verify suite (Anirudha). UC-1 green end-to-end from CLI.
4. **Day 9–11:** React chat + pipeline progress + approval gate UI + audit timeline.
5. **Day 12+:** UC-7 (modify) + UC-8 (refusal/rollback) + rehearse.

## The one-line pitch

> "One sentence → running verified environment in under 3 minutes, versus 2–3 days of tickets. The AI plans, vetted templates constrain, a human approves, and every action is audited."
