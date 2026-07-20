import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { CapacityPlan, EnvironmentRecord, ReadinessCheckResult, ReadinessReport } from "@ops-master/shared";
import { env } from "../config.js";
import { projectNameFor } from "../orchestrator/ids.js";
import { appServices } from "../templates/types.js";
import { isDockerAvailable } from "./dockerProbe.js";

const execFileAsync = promisify(execFile);
const MIN_FREE_BYTES = 500 * 1024 * 1024;

/**
 * Deterministic pre-flight scan run before iac_generator (02b-readiness-check.md)
 * — no LLM. Catches the class of failure that would otherwise only surface
 * as a deploy failure + rollback several steps later: port collisions, a
 * stopped Docker daemon, low disk space, and topologies no template covers.
 */

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function checkDockerDaemon(): Promise<ReadinessCheckResult> {
  if (!(await isDockerAvailable())) {
    return {
      name: "docker_daemon_reachable",
      status: "skipped",
      detail: "docker CLI not found on this machine — deploy will run in simulated mode",
      blocking: false,
    };
  }
  try {
    await execFileAsync("docker", ["info"], { timeout: 10000 });
    return { name: "docker_daemon_reachable", status: "pass", detail: "docker daemon reachable", blocking: true };
  } catch {
    return {
      name: "docker_daemon_reachable",
      status: "fail",
      detail: "docker CLI is installed but the daemon isn't reachable — start Docker Desktop before approving this deployment",
      blocking: true,
    };
  }
}

async function checkHostPortsFree(
  plan: CapacityPlan,
  existingPlan: CapacityPlan | null,
  demoPortConflict: boolean
): Promise<ReadinessCheckResult> {
  if (demoPortConflict) {
    return {
      name: "host_ports_free",
      status: "fail",
      detail: "port 3000 is already in use by another process (demo trigger)",
      blocking: true,
    };
  }

  const existingPorts = new Set((existingPlan?.network.expose ?? []).map((e) => e.host_port));
  const portsToCheck = plan.network.expose.map((e) => e.host_port).filter((p) => !existingPorts.has(p));

  const busy: number[] = [];
  for (const port of portsToCheck) {
    if (!(await isPortFree(port))) busy.push(port);
  }

  if (busy.length) {
    return {
      name: "host_ports_free",
      status: "fail",
      detail: `host port(s) already in use: ${busy.join(", ")}`,
      blocking: true,
    };
  }
  return {
    name: "host_ports_free",
    status: "pass",
    detail: portsToCheck.length ? `${portsToCheck.length} host port(s) free` : "no new host ports to check",
    blocking: true,
  };
}

async function checkDiskSpace(): Promise<ReadinessCheckResult> {
  try {
    const stats = await statfs(env.SERVER_ROOT);
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes < MIN_FREE_BYTES) {
      return {
        name: "disk_space_available",
        status: "fail",
        detail: `only ${(freeBytes / 1e6).toFixed(0)}MB free on the deployments volume (need at least ${MIN_FREE_BYTES / 1e6}MB)`,
        blocking: true,
      };
    }
    return {
      name: "disk_space_available",
      status: "pass",
      detail: `${(freeBytes / 1e9).toFixed(1)}GB free`,
      blocking: true,
    };
  } catch (err) {
    return {
      name: "disk_space_available",
      status: "skipped",
      detail: `could not determine free disk space: ${err instanceof Error ? err.message : String(err)}`,
      blocking: false,
    };
  }
}

function checkTemplateTopology(plan: CapacityPlan): ReadinessCheckResult {
  const appCount = appServices(plan).length;
  if (appCount !== 1) {
    return {
      name: "template_topology_supported",
      status: "fail",
      detail: `${appCount} app service(s) planned — the template catalogue only covers single-app-service topologies today`,
      blocking: true,
    };
  }
  return {
    name: "template_topology_supported",
    status: "pass",
    detail: "topology matches a known template shape",
    blocking: true,
  };
}

/**
 * Advisory only, not blocking — see 02b-readiness-check.md for why: modify
 * redeploys under a project name derived from the *new* request, not the
 * one the environment is actually running under, so a live/snapshot
 * mismatch here may reflect that gap rather than real drift.
 */
async function checkModifyDrift(
  existingEnvRecord: EnvironmentRecord | null,
  existingPlan: CapacityPlan | null
): Promise<ReadinessCheckResult | null> {
  if (!existingEnvRecord || !existingPlan) return null;
  if (!(await isDockerAvailable())) {
    return {
      name: "modify_state_matches_snapshot",
      status: "skipped",
      detail: "docker CLI not found — cannot compare live state to the stored snapshot",
      blocking: false,
    };
  }

  const projectName = projectNameFor(existingEnvRecord.request_id);
  try {
    const { stdout } = await execFileAsync("docker", ["compose", "-p", projectName, "ps", "--format", "json"], {
      timeout: 15000,
    });
    const liveNames = new Set(
      stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { Service: string }).Service)
    );
    const expectedNames = existingPlan.services.map((s) => s.name);
    const missing = expectedNames.filter((n) => !liveNames.has(n));

    if (missing.length) {
      return {
        name: "modify_state_matches_snapshot",
        status: "fail",
        detail: `expected running service(s) not found live: ${missing.join(", ")} — the environment may have drifted from its recorded snapshot`,
        blocking: false,
      };
    }
    return {
      name: "modify_state_matches_snapshot",
      status: "pass",
      detail: "live containers match the recorded snapshot",
      blocking: false,
    };
  } catch (err) {
    return {
      name: "modify_state_matches_snapshot",
      status: "skipped",
      detail: `could not query live state: ${err instanceof Error ? err.message : String(err)}`,
      blocking: false,
    };
  }
}

export interface ReadinessCheckInput {
  requestId: string;
  plan: CapacityPlan;
  existingPlan: CapacityPlan | null;
  existingEnvRecord: EnvironmentRecord | null;
  demoPortConflict: boolean;
}

export async function runReadinessCheck(input: ReadinessCheckInput): Promise<ReadinessReport> {
  const checks: ReadinessCheckResult[] = [
    await checkDockerDaemon(),
    await checkHostPortsFree(input.plan, input.existingPlan, input.demoPortConflict),
    await checkDiskSpace(),
    checkTemplateTopology(input.plan),
  ];

  const driftCheck = await checkModifyDrift(input.existingEnvRecord, input.existingPlan);
  if (driftCheck) checks.push(driftCheck);

  const blockers = checks.filter((c) => c.status === "fail" && c.blocking).map((c) => c.detail);

  return {
    request_id: input.requestId,
    checks,
    ready: blockers.length === 0,
    blockers,
  };
}
