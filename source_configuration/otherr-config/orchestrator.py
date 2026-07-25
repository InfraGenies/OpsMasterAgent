"""
Ops Master Agent orchestrator.

This is the piece that makes the demo "agentic" rather than a scripted
wrapper: each stage calls the Claude API with tools, and the model
decides what to write, what to validate, and how to fix its own errors
before moving on. The orchestrator's job is just to wire stages
together and print a readable trace for the demo audience - it does
not itself decide what infrastructure to generate.
"""

import json
import os
import time

import anthropic

from . import prompts, tools

# Check docs.claude.com/en/docs/about-claude/models for the current
# model string if this one is out of date by the time you run this.
MODEL = os.environ.get("OPS_AGENT_MODEL", "claude-sonnet-5")
MAX_TOOL_TURNS = 20


def _print_step(label: str):
    print(f"\n{'=' * 70}\n{label}\n{'=' * 70}")


def _print_plan_summary(plan: dict):
    print(f"Client:  {plan.get('client_name', 'Client')}")
    print(f"Tier:    {plan.get('tier', 'unspecified')}")
    print(f"Region:  {plan.get('region', 'us-east-1')}")

    included = plan.get("included_components", [])
    if included:
        print(f"\nIncluded ({len(included)}):")
        for c in included:
            print(f"  + {c.get('component')}")

    skipped = plan.get("skipped_components", [])
    if skipped:
        print(f"\nSkipped ({len(skipped)}):")
        for c in skipped:
            print(f"  - {c.get('component')}")

    task_graph = plan.get("task_graph", [])
    if task_graph:
        print(f"\nTask graph: {len(task_graph)} steps will be used to generate Terraform.")

    cost = plan.get("estimated_monthly_cost")
    if cost:
        total = cost.get("total_usd")
        print(f"\nEstimated monthly AWS cost: ${total}/mo" if total is not None else "\nEstimated monthly AWS cost:")
        for line in cost.get("breakdown", []):
            component = line.get("component")
            monthly = line.get("monthly_usd")
            assumption = line.get("assumption", "")
            suffix = f"  ({assumption})" if assumption else ""
            print(f"  ${monthly}/mo - {component}{suffix}")
        assumptions = cost.get("pricing_assumptions")
        if assumptions:
            print(f"  Assumptions: {assumptions}")

    if not included and not task_graph:
        print("\n(Planning output did not parse into the expected shape - review raw plan above.)")


def _revise_plan(client, request_text: str, plan: dict, feedback: str) -> dict:
    """
    Send the client's requested changes back to the Planning Agent and get a
    revised plan in the same JSON shape.
    """
    _print_step("REVISING PLAN based on your feedback")
    revised_raw = _run_agent_loop(
        client,
        prompts.PLAN_REVISION_SYSTEM_PROMPT,
        f"Original client request:\n{request_text}\n\n"
        f"Current plan:\n{json.dumps(plan, indent=2)}\n\n"
        f"Requested changes:\n{feedback}",
    )
    try:
        return json.loads(revised_raw)
    except json.JSONDecodeError:
        print("WARNING: plan revision output was not valid JSON, keeping previous plan")
        return plan


def _confirm_plan(client, request_text: str, plan: dict) -> tuple[bool, dict]:
    """
    Show the client a readable summary of what the Planning Agent decided and
    require an explicit go-ahead before any Terraform gets generated. The
    client can also request changes, which get sent back to the Planning
    Agent as a revision, shown again, and re-confirmed - looping until the
    client accepts or cancels.
    """
    while True:
        _print_step("PLAN READY FOR REVIEW - confirmation required before Terraform generation")
        _print_plan_summary(plan)

        answer = input(
            "\nProceed with Terraform generation for this plan? "
            "[y]es / [n]o / [e]dit (describe changes): "
        ).strip().lower()

        if answer in ("y", "yes"):
            return True, plan
        if answer in ("", "n", "no"):
            return False, plan
        if answer in ("e", "edit"):
            feedback = input("What would you like to change about the plan? ").strip()
            if not feedback:
                print("No changes described - showing the same plan again.")
                continue
            plan = _revise_plan(client, request_text, plan, feedback)
            continue
        print("Please answer 'y', 'n', or 'e'.")


def _run_agent_loop(client, system_prompt: str, user_message: str, verbose: bool = True) -> str:
    """
    Generic tool-use loop: send a message, execute any tool calls the
    model makes, feed results back, repeat until the model stops calling
    tools. Returns the final text response.
    """
    messages = [{"role": "user", "content": user_message}]

    for turn in range(MAX_TOOL_TURNS):
        response = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            system=system_prompt,
            tools=tools.TOOL_DEFINITIONS,
            messages=messages,
        )

        text_parts = [b.text for b in response.content if b.type == "text"]
        tool_calls = [b for b in response.content if b.type == "tool_use"]

        if verbose and text_parts:
            print("\n".join(text_parts))

        if response.stop_reason != "tool_use":
            return "\n".join(text_parts)

        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for call in tool_calls:
            if verbose:
                print(f"  [tool] {call.name}({json.dumps(call.input)[:200]})")
            handler = tools.DISPATCH.get(call.name)
            result = handler(call.input) if handler else {"status": "error", "error": "unknown tool"}
            if verbose:
                status = result.get("status", "?")
                print(f"  [tool result] status={status}")
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": json.dumps(result),
            })
        messages.append({"role": "user", "content": tool_results})

    return "[stopped: hit MAX_TOOL_TURNS without finishing]"


def run_pipeline(request_text: str) -> dict:
    """
    Run the full pipeline from a raw client request - a plain-English description
    (e.g. "I need a startup app with 3 developers and 3 services"), typos and all.
    There is no fixed intake schema: the Planning Agent reads and interprets the
    request itself and decides its own classification, the same way a human platform
    engineer would on a discovery call, rather than snapping it into a preset bucket.
    """
    client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env

    timings = {}

    # --- Stage 1: Planning (interprets the raw request itself) ---
    _print_step("STAGE 1: Planning Agent - interpreting request")
    t0 = time.time()
    plan_raw = _run_agent_loop(
        client,
        prompts.PLANNING_SYSTEM_PROMPT,
        f"Client request:\n{request_text}",
    )
    timings["planning_seconds"] = round(time.time() - t0, 1)
    try:
        plan = json.loads(plan_raw)
    except json.JSONDecodeError:
        print("WARNING: planning output was not valid JSON, storing raw text")
        plan = {"raw": plan_raw}

    # --- Confirmation gate: nothing gets generated without explicit sign-off on the plan.
    # The client can request edits here; each edit round-trips through the Planning Agent
    # as a revision and is shown again before Terraform generation is allowed to start. ---
    confirmed, plan = _confirm_plan(client, request_text, plan)
    if not confirmed:
        print("\nPlan not confirmed - stopping before Terraform generation.")
        return {
            "request": request_text,
            "plan": plan,
            "status": "cancelled_by_user",
            "generation_summary": None,
            "report": None,
            "timings": timings,
        }

    client_name = plan.get("client_name", "Client")
    tier = plan.get("tier", "unspecified")
    region = plan.get("region", "us-east-1")

    # --- Stage 2: Terraform generation + self-validation loop ---
    _print_step(f"STAGE 2: Terraform Generation Agent - {client_name}")
    t0 = time.time()
    gen_summary = _run_agent_loop(
        client,
        prompts.TERRAFORM_GEN_SYSTEM_PROMPT,
        f"Scoped plan:\n{json.dumps(plan, indent=2)}\n\n"
        f"Client tier: {tier}, client_name: {client_name}, region: {region}.\n"
        f"Generate and validate the Terraform now.",
    )
    timings["terraform_generation_seconds"] = round(time.time() - t0, 1)

    # --- Stage 3: Client-facing report ---
    _print_step(f"STAGE 3: Reporting Agent - {client_name}")
    t0 = time.time()
    report = _run_agent_loop(
        client,
        prompts.REPORT_SYSTEM_PROMPT,
        f"Plan JSON:\n{json.dumps(plan, indent=2)}\n\nGeneration summary:\n{gen_summary}",
        verbose=False,
    )
    timings["reporting_seconds"] = round(time.time() - t0, 1)
    print(report)

    return {
        "request": request_text,
        "plan": plan,
        "status": "completed",
        "generation_summary": gen_summary,
        "report": report,
        "timings": timings,
    }
