# Ops Master Agent — Team 8 Build Pack

Agentic AI infrastructure lifecycle automation: **one sentence → capacity plan → IaC → human approval → live deployment → verified report**, fully audited.

## What's in this pack

```
agent-md-files/
├── README.md            ← you are here
├── INSTALLATION.md      ← tools, IS/firewall requests, verification checklist
├── USE_CASES.md         ← demo scenarios with verified GitHub repos
├── EXAMPLE-AWS-RETAIL-STORE.md ← worked AWS example (UC-9), wiki/slide-ready
├── WORKFLOW.md          ← flow diagram (Mermaid + ASCII) + state machine + safety rules
├── AGENTS_AND_SKILLS.md ← one-page index: each node's responsibility + which skill files it uses
├── DATASETS.md          ← proposal: structured data files backing skills/prompts/mock code's numbers
├── PRESENTATION.md      ← slide-by-slide source for generating a pitch/technical deck
├── CONTRACTS.md         ← the 4 JSON contracts, the seam every node passes data through
├── skills/              ← reusable knowledge modules spliced into node prompts at runtime
├── datasets/            ← example structured data files (see DATASETS.md) — not yet wired into code
├── 00-orchestrator.md   (state machine graph, code not prompt)
├── 01-intake.md         (NL → PlanRequest, safety filter)
├── 02-planner.md        (capacity plan + sizing rules)
├── 02b-readiness-check.md  (deterministic pre-flight scan, no LLM)
├── 02c-compliance-check.md (Enterprise Architecture Advisor gap check, no LLM)
├── 03-iac-generator.md  (template filling, or freeform when nothing fits)
├── 03b-policy-validator.md (deterministic security/policy scan, no LLM)
├── 04-approval-gate.md  (human-only hard stop)
├── 05-deploy-agent.md   (allow-listed executor + rollback)
├── 06-verify-agent.md   (health checks + load-test smoke)
└── 07-audit-store.md    (audit/state store + DB decision)
```

See [`AGENTS_AND_SKILLS.md`](AGENTS_AND_SKILLS.md) for the full, current node-by-node responsibility list
and [the root README](../README.md#architecture-decisions) for how each node's implementation maps to code.

## How to use these files in VS Code

1. **Drop the folder into the repo root.** Each agent md contains its system prompt in a fenced ```text block — the backend loads it at runtime:
   ```python
   def load_prompt(agent_md: str) -> str:
       text = Path(f"agents/{agent_md}").read_text()
       return text.split("```text")[1].split("```")[0].strip()
   ```
   Editing an agent's behaviour = editing its md file. No code change, instant iteration, and the prompt is version-controlled next to its spec.
2. **AI pair-programming:** point Copilot Chat / Claude Code at an agent md (`@workspace` or drag the file in) and ask it to "implement this node against CONTRACTS.md" — the specs are written to be directly consumable as build instructions.
3. **Mermaid preview:** install `bierner.markdown-mermaid` to render WORKFLOW.md's diagram inside VS Code.

## The one-line pitch

> "One sentence → running verified environment in under 3 minutes, versus 2–3 days of tickets. The AI plans, vetted templates constrain, a human approves, and every action is audited."
