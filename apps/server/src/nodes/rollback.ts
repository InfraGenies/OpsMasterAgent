import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { IaCPayload, Operation } from "@ops-master/shared";
import { resolveAllowedCommand, runAllowedCommand } from "./commandAllowList.js";
import { shouldMockDeploy } from "./dockerProbe.js";

export interface RollbackInput {
  payload: IaCPayload;
  deploymentDir: string;
  projectName: string;
  operation: Operation;
  onLog: (line: string) => void;
}

export interface RollbackOutcome {
  ok: boolean;
  detail: string;
  stdout: string;
  commandExecuted: string;
}

/**
 * 05-deploy-agent.md rollback semantics:
 *  - create failure  -> down -v (full teardown, volumes included)
 *  - modify failure  -> restore the snapshotted previous files and re-apply
 *    (never -v — existing data must survive)
 *  - rollback failure itself is surfaced, never hidden
 */
export async function runRollback(input: RollbackInput): Promise<RollbackOutcome> {
  if (input.operation === "modify" && input.payload.diff_from) {
    for (const file of input.payload.diff_from) {
      const filePath = path.join(input.deploymentDir, file.path);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, "utf-8");
    }
    const restoreCommand = `docker compose -p ${input.projectName} up -d --wait`;
    const argv = resolveAllowedCommand(restoreCommand);
    if (!argv) {
      return { ok: false, detail: "internal error: restore command failed allow-list check", stdout: "", commandExecuted: restoreCommand };
    }
    if (await shouldMockDeploy()) {
      input.onLog(`[mock rollback] simulating restore: ${restoreCommand}`);
      return {
        ok: true,
        detail: "SIMULATED restore of previous environment files (mock deploy mode)",
        stdout: "[mock rollback] simulated success",
        commandExecuted: restoreCommand,
      };
    }
    const result = await runAllowedCommand("docker", argv, input.deploymentDir, input.onLog);
    return {
      ok: result.ok,
      detail: result.ok
        ? "restored previous environment files; existing data volume untouched"
        : "rollback restore itself failed — manual intervention needed",
      stdout: result.output,
      commandExecuted: restoreCommand,
    };
  }

  const argv = resolveAllowedCommand(input.payload.rollback_command);
  if (!argv) {
    return {
      ok: false,
      detail: `refused: rollback_command is not in the allow-list ("${input.payload.rollback_command}")`,
      stdout: "",
      commandExecuted: input.payload.rollback_command,
    };
  }
  if (await shouldMockDeploy()) {
    input.onLog(`[mock rollback] simulating teardown: ${input.payload.rollback_command}`);
    return {
      ok: true,
      detail: "SIMULATED teardown (mock deploy mode)",
      stdout: "[mock rollback] simulated success",
      commandExecuted: input.payload.rollback_command,
    };
  }
  const result = await runAllowedCommand("docker", argv, input.deploymentDir, input.onLog);
  return {
    ok: result.ok,
    detail: result.ok ? "environment torn down (volumes included)" : "rollback itself failed — manual intervention needed",
    stdout: result.output,
    commandExecuted: input.payload.rollback_command,
  };
}
