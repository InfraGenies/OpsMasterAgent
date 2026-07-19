import type { IaCPayload } from "@ops-master/shared";
import { resolveAllowedCommand, runAllowedCommand } from "./commandAllowList.js";

export interface DeployInput {
  payload: IaCPayload;
  deploymentDir: string;
  onLog: (line: string) => void;
}

export interface DeployOutcome {
  deployOk: boolean;
  detail: string;
  stdout: string;
}

/**
 * 05-deploy-agent.md: deterministic executor, no LLM in this node. Asserting
 * a decision row exists is done by the orchestrator before calling this
 * (belt-and-braces alongside the graph's own interrupt_before gate).
 */
export async function runDeploy(input: DeployInput): Promise<DeployOutcome> {
  const argv = resolveAllowedCommand(input.payload.apply_command);
  if (!argv) {
    return {
      deployOk: false,
      detail: `refused: apply_command is not in the allow-list ("${input.payload.apply_command}")`,
      stdout: "",
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
