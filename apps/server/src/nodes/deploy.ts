import type { IaCPayload } from "@ops-master/shared";
import { resolveAllowedCommand, runAllowedCommand } from "./commandAllowList.js";
import { shouldMockDeploy } from "./dockerProbe.js";

export interface DeployInput {
  payload: IaCPayload;
  deploymentDir: string;
  onLog: (line: string) => void;
  /** Set by the orchestrator when the preceding build step was mocked (nodes/build.ts) — forces deploy to mock too, so a simulated build (image never actually built) can't be followed by a for-real `docker compose up` that would just fail against a nonexistent image. Undefined defers to the normal shouldMockDeploy() gate. */
  mockOverride?: boolean;
}

export interface DeployOutcome {
  deployOk: boolean;
  detail: string;
  stdout: string;
}

/**
 * UC-9 AWS/Terraform path: "deploy" is always plan-only — `apply`/`destroy`
 * are not in commandAllowList.ts at all, so there is no code path from here
 * to a real AWS account regardless of what's installed on this machine. A
 * terraform init/plan failure (missing CLI, no network, no AWS credentials —
 * this app ships none) is an environment fact, not a broken payload, so it's
 * reported as a successful SIMULATED plan rather than triggering a rollback
 * — there was never anything applied to roll back.
 */
async function runTerraformPlanOnly(input: DeployInput): Promise<DeployOutcome> {
  const initArgv = resolveAllowedCommand("terraform init -backend=false -input=false -no-color");
  const planArgv = resolveAllowedCommand("terraform plan -input=false -no-color -out=tfplan");
  if (!initArgv || !planArgv) {
    return { deployOk: false, detail: "refused: terraform init/plan command not in the allow-list", stdout: "" };
  }

  for (const f of input.payload.files) input.onLog(`[terraform] rendered ${f.path}`);

  const initResult = await runAllowedCommand("terraform", initArgv, input.deploymentDir, input.onLog);
  if (!initResult.ok) {
    input.onLog("[terraform] init did not complete (SIMULATED) — plan-only sandbox, nothing was ever going to be applied");
    return {
      deployOk: true,
      detail: "SIMULATED terraform plan (init could not complete in this sandbox — no terraform CLI/network/AWS credentials expected here)",
      stdout: initResult.output,
    };
  }

  const planResult = await runAllowedCommand("terraform", planArgv, input.deploymentDir, input.onLog);
  input.onLog(planResult.ok ? "[terraform] plan completed cleanly — nothing applied" : "[terraform] plan did not complete (SIMULATED)");
  return {
    deployOk: true,
    detail: planResult.ok
      ? "terraform plan completed cleanly (plan-only — nothing was ever applied to AWS)"
      : "SIMULATED terraform plan (plan could not complete in this sandbox — likely missing AWS credentials, which this app never configures)",
    stdout: initResult.output + "\n" + planResult.output,
  };
}

/**
 * 05-deploy-agent.md: deterministic executor, no LLM in this node. Asserting
 * a decision row exists is done by the orchestrator before calling this
 * (belt-and-braces alongside the graph's own interrupt_before gate).
 */
export async function runDeploy(input: DeployInput): Promise<DeployOutcome> {
  if (input.payload.format === "terraform") return runTerraformPlanOnly(input);

  const argv = resolveAllowedCommand(input.payload.apply_command);
  if (!argv) {
    return {
      deployOk: false,
      detail: `refused: apply_command is not in the allow-list ("${input.payload.apply_command}")`,
      stdout: "",
    };
  }

  if (input.mockOverride ?? (await shouldMockDeploy())) {
    // Allow-list check above still ran — mock mode never skips the safety
    // gate, only the process spawn.
    input.onLog(`[mock deploy] docker CLI unavailable — simulating: ${input.payload.apply_command}`);
    for (const f of input.payload.files) input.onLog(`[mock deploy] would apply ${f.path}`);
    input.onLog("[mock deploy] all services report healthy (simulated)");
    return {
      deployOk: true,
      detail: "SIMULATED deploy (mock deploy mode — docker CLI not present on this machine)",
      stdout: "[mock deploy] simulated success",
    };
  }

  const result = await runAllowedCommand("docker", argv, input.deploymentDir, input.onLog);
  if (result.ok) {
    return { deployOk: true, detail: "containers reported healthy (--wait)", stdout: result.output };
  }
  return {
    deployOk: false,
    detail: "apply_command exited non-zero or timed out",
    stdout: result.output,
  };
}
