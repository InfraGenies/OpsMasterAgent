import { writeFileSync } from "node:fs";
import path from "node:path";
import type { IaCPayload } from "@ops-master/shared";
import { resolveAllowedCommand, runAllowedCommand } from "./commandAllowList.js";
import { shouldMockBuild } from "./dockerProbe.js";

export interface BuildInput {
  payload: IaCPayload;
  deploymentDir: string;
  onLog: (line: string) => void;
}

export interface BuildOutcome {
  buildOk: boolean;
  detail: string;
  stdout: string;
  mocked: boolean;
}

/**
 * Deterministic executor for IaCPayload.build_steps (nodes/iacGenerator.ts
 * populates this only on the build-sentinel path, buildRegistry.ts) — runs a
 * git-clone + npm build + docker-build + migrate sequence through the same
 * allow-list/spawn primitives nodes/deploy.ts already uses. No LLM in this
 * node. Mirrors deploy.ts's shape: always resolves to a BuildOutcome, never
 * throws for a refused/failed step.
 */
export async function runBuild(input: BuildInput): Promise<BuildOutcome> {
  const steps = input.payload.build_steps ?? [];
  if (!steps.length) {
    return { buildOk: true, detail: "no build steps for this template", stdout: "", mocked: false };
  }

  if (await shouldMockBuild()) {
    for (const step of steps) input.onLog(`[mock build] would run (cwd=${step.cwd}): ${step.command}`);
    input.onLog("[mock build] image built and migrations applied (simulated)");
    return {
      buildOk: true,
      detail: "SIMULATED build (docker/git CLI not present on this machine)",
      stdout: "[mock build] simulated success",
      mocked: true,
    };
  }

  let combinedOutput = "";
  for (const step of steps) {
    const argv = resolveAllowedCommand(step.command);
    if (!argv) {
      return {
        buildOk: false,
        detail: `refused: build step is not in the allow-list ("${step.command}")`,
        stdout: combinedOutput,
        mocked: false,
      };
    }
    // On Windows, npm/npx are .cmd batch shims, not native executables.
    // spawn() with shell:false can't run a .cmd directly — even naming
    // "npm.cmd" explicitly still fails with EINVAL (a long-standing
    // Node/Windows limitation, see nodejs/node#3675) — the documented
    // workaround is invoking through cmd.exe /c explicitly. This is NOT
    // shell:true: argv stays a plain array, nothing here is ever built by
    // string-concatenating untrusted input, and every value in it already
    // came from the fixed allow-list, never user/LLM input.
    const rawBin = step.command.split(" ")[0];
    const isWinNpm = process.platform === "win32" && (rawBin === "npm" || rawBin === "npx");
    const bin = isWinNpm ? "cmd.exe" : rawBin;
    const finalArgv = isWinNpm ? ["/c", rawBin, ...argv] : argv;
    const cwd = step.cwd === "repo" ? path.join(input.deploymentDir, "repo") : input.deploymentDir;

    // The repo's own Dockerfile can be wrong for our purposes (see
    // buildRegistry.ts's dockerfileOverride doc comment) — written right
    // before the one step that reads it, since the repo directory doesn't
    // exist until the clone step (earlier in this same sequence) has run.
    if (input.payload.dockerfile_override && step.command.startsWith("docker build")) {
      writeFileSync(path.join(cwd, "Dockerfile"), input.payload.dockerfile_override, "utf-8");
      input.onLog("[build] wrote corrected Dockerfile (see buildRegistry.ts dockerfileOverride)");
    }

    input.onLog(`[build] running: ${step.command}`);
    const result = await runAllowedCommand(bin, finalArgv, cwd, input.onLog, 600_000, step.env ?? {});
    combinedOutput += result.output + "\n";
    if (!result.ok) {
      return {
        buildOk: false,
        detail: `build step failed or timed out: ${step.command}`,
        stdout: combinedOutput,
        mocked: false,
      };
    }
  }

  return { buildOk: true, detail: `${steps.length} build step(s) completed`, stdout: combinedOutput, mocked: false };
}
