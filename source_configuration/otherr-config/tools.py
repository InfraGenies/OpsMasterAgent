"""
Real tool implementations for the Ops Master Agent.

These are not mocked - write_file actually writes to disk, and
run_terraform actually shells out to the terraform binary against
whatever AWS credentials are configured in the environment
(AWS_PROFILE / AWS_ACCESS_KEY_ID etc). validate and plan are safe
(read-only against AWS, no resources created). apply is gated
behind an explicit --allow-apply flag in main.py so nothing gets
created by accident during rehearsal.
"""

import json
import os
import subprocess
from pathlib import Path

OUTPUT_ROOT = Path(__file__).parent.parent / "outputs"


def _safe_path(relative_path: str) -> Path:
    """Keep all agent file writes inside outputs/ - never let the model
    write outside its sandbox, even if it hallucinates a path."""
    target = (OUTPUT_ROOT / relative_path).resolve()
    if OUTPUT_ROOT.resolve() not in target.parents and target != OUTPUT_ROOT.resolve():
        raise ValueError(f"Refusing to write outside outputs/: {relative_path}")
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def write_file(path: str, content: str) -> dict:
    """Write a file (Terraform, Helm values, Datadog config, etc.) under outputs/."""
    target = _safe_path(path)
    target.write_text(content)
    return {"status": "written", "path": str(target.relative_to(OUTPUT_ROOT.parent))}


def read_file(path: str) -> dict:
    target = _safe_path(path)
    if not target.exists():
        return {"status": "error", "error": f"{path} does not exist"}
    return {"status": "ok", "content": target.read_text()}


def list_output_files() -> dict:
    files = [str(p.relative_to(OUTPUT_ROOT)) for p in OUTPUT_ROOT.rglob("*") if p.is_file()]
    return {"files": files}


def run_terraform(working_dir: str, command: str) -> dict:
    """
    Run a real terraform command (init / validate / plan / apply / destroy)
    against the generated code. Returns stdout/stderr/exit code so the
    calling agent loop can feed errors back to Claude for self-correction.
    """
    allowed = {"init", "validate", "plan", "apply", "destroy", "fmt"}
    if command not in allowed:
        return {"status": "error", "error": f"command '{command}' not allowed"}

    # HARD GATE: apply/destroy create or destroy real AWS resources. This is
    # enforced in code, not just in the system prompt, so it holds even if
    # a future prompt change or model decision tries to call it. It only
    # unlocks when the human running this explicitly sets the env var for
    # that specific run - never on by default.
    if command in ("apply", "destroy") and os.environ.get("OPS_AGENT_ALLOW_APPLY") != "yes-i-mean-it":
        return {
            "status": "error",
            "error": (
                f"Blocked: '{command}' is disabled by default. This would create/destroy "
                f"real AWS resources. To run it, the user must explicitly set "
                f"OPS_AGENT_ALLOW_APPLY=yes-i-mean-it in the shell before running main.py, "
                f"for this run only."
            ),
        }

    cwd = _safe_path(working_dir)
    if not cwd.exists():
        return {"status": "error", "error": f"working dir {working_dir} does not exist"}

    args = ["terraform", command]
    if command in ("apply", "destroy"):
        args.append("-auto-approve")
    if command == "plan":
        args.append("-no-color")

    try:
        result = subprocess.run(
            args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=600,
        )
        return {
            "status": "ok" if result.returncode == 0 else "error",
            "returncode": result.returncode,
            "stdout": result.stdout[-6000:],  # keep context bounded
            "stderr": result.stderr[-6000:],
        }
    except FileNotFoundError:
        return {"status": "error", "error": "terraform binary not found on PATH"}
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": f"terraform {command} timed out after 600s"}


def run_kubectl(args: list) -> dict:
    """Run kubectl against whatever cluster is in the current kubeconfig context
    (use this for the local kind/k3d cluster during the demo, or a real EKS
    cluster once kubeconfig is pointed at it via `aws eks update-kubeconfig`)."""
    try:
        result = subprocess.run(
            ["kubectl"] + args,
            capture_output=True,
            text=True,
            timeout=120,
        )
        return {
            "status": "ok" if result.returncode == 0 else "error",
            "stdout": result.stdout[-4000:],
            "stderr": result.stderr[-4000:],
        }
    except FileNotFoundError:
        return {"status": "error", "error": "kubectl binary not found on PATH"}


TOOL_DEFINITIONS = [
    {
        "name": "write_file",
        "description": "Write a file (Terraform HCL, YAML, JSON) to the outputs/ directory. Path is relative to outputs/, e.g. 'startup/vpc/main.tf'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "read_file",
        "description": "Read back a previously written file under outputs/.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "list_output_files",
        "description": "List all files currently written under outputs/.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "run_terraform",
        "description": "Run a real terraform command (init/validate/plan/fmt/apply/destroy) against a directory under outputs/. Use validate and plan freely - they are read-only against AWS. apply/destroy create or destroy real resources.",
        "input_schema": {
            "type": "object",
            "properties": {
                "working_dir": {"type": "string"},
                "command": {"type": "string", "enum": ["init", "validate", "plan", "apply", "destroy", "fmt"]},
            },
            "required": ["working_dir", "command"],
        },
    },
    {
        "name": "run_kubectl",
        "description": "Run kubectl against the current kubeconfig context (local kind cluster or real EKS).",
        "input_schema": {
            "type": "object",
            "properties": {
                "args": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["args"],
        },
    },
]

DISPATCH = {
    "write_file": lambda i: write_file(i["path"], i["content"]),
    "read_file": lambda i: read_file(i["path"]),
    "list_output_files": lambda i: list_output_files(),
    "run_terraform": lambda i: run_terraform(i["working_dir"], i["command"]),
    "run_kubectl": lambda i: run_kubectl(i["args"]),
}
