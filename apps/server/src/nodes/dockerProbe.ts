import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../config.js";

const execFileAsync = promisify(execFile);

let dockerAvailable: boolean | null = null;

/** One cached `docker compose version` probe per process lifetime. */
export async function isDockerAvailable(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  try {
    await execFileAsync("docker", ["compose", "version"], { timeout: 10000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
  }
  return dockerAvailable;
}

/**
 * MOCK_DEPLOY=true  -> always simulate deploy/verify/rollback
 * MOCK_DEPLOY=false -> always run docker for real (deploy fails if absent)
 * unset / "auto"    -> simulate only when the docker CLI is not on this
 *                      machine, so the same build works as a docker-less demo
 *                      today and does real deploys once Docker Desktop exists.
 */
export async function shouldMockDeploy(): Promise<boolean> {
  if (env.MOCK_DEPLOY === "true") return true;
  if (env.MOCK_DEPLOY === "false") return false;
  return !(await isDockerAvailable());
}

let gitAvailable: boolean | null = null;

/** One cached `git --version` probe per process lifetime. */
export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailable !== null) return gitAvailable;
  try {
    await execFileAsync("git", ["--version"], { timeout: 10000 });
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

/**
 * Deliberately separate from shouldMockDeploy(): that gate is shared by
 * every existing use case's deploy/rollback/verify, so folding a git-missing
 * check into it would silently start simulating every other use case's
 * deploy on any machine that has Docker but not git — a regression unrelated
 * to the build-sentinel feature this gate exists for. Only nodes/build.ts
 * reads this.
 */
export async function shouldMockBuild(): Promise<boolean> {
  if (env.MOCK_DEPLOY === "true") return true;
  if (env.MOCK_DEPLOY === "false") return false;
  return !(await isDockerAvailable()) || !(await isGitAvailable());
}
