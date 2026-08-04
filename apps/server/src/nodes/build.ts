import { writeFileSync } from "node:fs";
import path from "node:path";
import type { IaCPayload } from "@ops-master/shared";
import { BUILD_REGISTRY } from "./buildRegistry.js";
import { resolveAllowedCommand, runAllowedCommand } from "./commandAllowList.js";
import { shouldMockBuild } from "./dockerProbe.js";

/**
 * True iff `cwd` is "deployment", a "repo-<key>" clone dir for a key that actually exists in
 * BUILD_REGISTRY, or that same clone dir plus the exact `dockerfileSubdir` that registry entry
 * declares (e.g. "repo-nginx-hello/nginx-hello") — never an arbitrary nested path. iac_generator is
 * the only producer of this field (never the LLM/user), but this is checked again here rather than
 * trusting the schema's regex shape alone — see contracts.ts's cwd doc comment.
 */
function isKnownCwd(cwd: string): boolean {
  if (cwd === "deployment") return true;
  const match = /^repo-([^/]+)(?:\/(.+))?$/.exec(cwd);
  if (match === null) return false;
  const [, key, subdir] = match;
  const entry = BUILD_REGISTRY[key];
  if (!entry) return false;
  return subdir === undefined ? true : subdir === entry.dockerfileSubdir;
}

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
    if (!isKnownCwd(step.cwd)) {
      return {
        buildOk: false,
        detail: `refused: build step's cwd "${step.cwd}" does not resolve to a known BUILD_REGISTRY entry`,
        stdout: combinedOutput,
        mocked: false,
      };
    }
    const cwd = step.cwd === "deployment" ? input.deploymentDir : path.join(input.deploymentDir, step.cwd);

    // The repo's own Dockerfile can be wrong for our purposes (see
    // buildRegistry.ts's dockerfileOverride doc comment) — written right
    // before the one step that reads it, since the repo directory doesn't
    // exist until that repo's own clone step (earlier in this same
    // sequence) has run. Keyed by this step's own cwd (its clone dir), not
    // by service name — a single build can now involve more than one cloned
    // repo (nodes/buildRegistry.ts's `pairedWith` mechanism), and this is
    // what keeps each repo getting only its own Dockerfile, never another
    // build-sentinel's.
    const overrideForThisBuild = input.payload.dockerfile_override?.[step.cwd];
    if (overrideForThisBuild && step.command.startsWith("docker build")) {
      writeFileSync(path.join(cwd, "Dockerfile"), overrideForThisBuild, "utf-8");
      input.onLog(`[build] wrote corrected Dockerfile for ${step.cwd} (see buildRegistry.ts dockerfileOverride)`);
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
