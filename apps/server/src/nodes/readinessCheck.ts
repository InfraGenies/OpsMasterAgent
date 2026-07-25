import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { CapacityPlanOption, EnvironmentRecord, ReadinessCheckResult, ReadinessReport } from "@ops-master/shared";
import { env } from "../config.js";
import { projectNameFor } from "../orchestrator/ids.js";
import { appServices } from "../templates/types.js";
import { isBuildSentinel } from "./buildRegistry.js";
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

/**
 * On Docker Desktop for Windows, container ports are forwarded through a
 * WSL2/HNS proxy rather than a normal Windows-process bind on 127.0.0.1 -
 * a raw isPortFree() probe can report a port "free" even while `docker ps`
 * shows it published, because the forwarding layer isn't visible to a plain
 * socket bind the way a native process's listener would be. Cross-checking
 * `docker ps` catches exactly the ports isPortFree() is blind to.
 */
async function dockerPublishedPorts(): Promise<Set<number>> {
  try {
    const { stdout } = await execFileAsync("docker", ["ps", "--format", "{{.Ports}}"], { timeout: 10000 });
    const ports = new Set<number>();
    const re = /:(\d+)->/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stdout))) ports.add(Number(m[1]));
    return ports;
  } catch {
    return new Set();
  }
}

async function isPortBusy(port: number, published: Set<number>): Promise<boolean> {
  if (published.has(port)) return true;
  return !(await isPortFree(port));
}

/** Scans forward from the conflicting port for a nearby free one, checked the same (docker-ps + bind) way. `taken` holds ports already claimed by an earlier reassignment in this same pass, so two conflicting services never get reassigned onto each other. */
async function findFreePort(startPort: number, published: Set<number>, taken: Set<number>): Promise<number | null> {
  for (let candidate = startPort + 1; candidate < startPort + 50; candidate++) {
    if (taken.has(candidate)) continue;
    if (!(await isPortBusy(candidate, published))) return candidate;
  }
  return null;
}

export interface PortReassignment {
  service: string;
  from: number;
  to: number;
}

function isAwsPlan(plan: CapacityPlanOption): boolean {
  return plan.services.some((s) => s.managed_service);
}

/** UC-9 AWS/Terraform path — advisory only, mirrors checkDockerDaemon's skip-if-missing pattern. Never blocking: this sandbox only ever plans, so a missing CLI just means a SIMULATED plan later, not a broken request. */
async function checkTerraformCli(): Promise<ReadinessCheckResult> {
  try {
    await execFileAsync("terraform", ["-version"], { timeout: 10000 });
    return { name: "terraform_cli_reachable", status: "pass", detail: "terraform CLI reachable", blocking: false };
  } catch {
    return {
      name: "terraform_cli_reachable",
      status: "skipped",
      detail: "terraform CLI not found on this machine — plan will run in simulated mode",
      blocking: false,
    };
  }
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

/**
 * Mutates `plan.network.expose` in place when a conflicting port can be
 * swapped for a nearby free one — `plan` is the caller's selected-tier
 * CapacityPlanOption (a live reference into the full CapacityPlan's
 * `options` array, not a copy), so the fix is visible to whatever the
 * caller does with that plan next (e.g. re-persisting it as the new
 * "planner" audit output before iac_generator renders it).
 */
async function checkHostPortsFree(
  plan: CapacityPlanOption,
  existingPlan: CapacityPlanOption | null,
  demoPortConflict: boolean
): Promise<{ result: ReadinessCheckResult; reassignments: PortReassignment[] }> {
  if (demoPortConflict) {
    return {
      result: {
        name: "host_ports_free",
        status: "fail",
        detail: "port 3000 is already in use by another process (demo trigger)",
        blocking: true,
      },
      reassignments: [],
    };
  }

  const existingPorts = new Set((existingPlan?.network.expose ?? []).map((e) => e.host_port));
  const exposesToCheck = plan.network.expose.filter((e) => !existingPorts.has(e.host_port));

  const published = await dockerPublishedPorts();
  const taken = new Set(exposesToCheck.map((e) => e.host_port));
  const reassignments: PortReassignment[] = [];
  const stillBusy: number[] = [];

  for (const expose of exposesToCheck) {
    if (!(await isPortBusy(expose.host_port, published))) continue;
    const replacement = await findFreePort(expose.host_port, published, taken);
    if (replacement == null) {
      stillBusy.push(expose.host_port);
      continue;
    }
    reassignments.push({ service: expose.service, from: expose.host_port, to: replacement });
    taken.delete(expose.host_port);
    taken.add(replacement);
    expose.host_port = replacement;
  }

  if (stillBusy.length) {
    return {
      result: {
        name: "host_ports_free",
        status: "fail",
        detail: `host port(s) already in use and no free port found nearby: ${stillBusy.join(", ")}`,
        blocking: true,
      },
      reassignments,
    };
  }

  const detail = reassignments.length
    ? `auto-reassigned to avoid a conflict: ${reassignments.map((r) => `${r.service} ${r.from}->${r.to}`).join(", ")}`
    : exposesToCheck.length
      ? `${exposesToCheck.length} host port(s) free`
      : "no new host ports to check";

  return { result: { name: "host_ports_free", status: "pass", detail, blocking: true }, reassignments };
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

/** True iff the plan's app services are exactly the RealWorld build-sentinel pair (nodes/buildRegistry.ts) — the one known, vetted 2-app-service topology (compose-realworld-fullstack-v1). Every other multi-app-service shape stays unsupported below. */
function isRealworldFullstackPlan(plan: CapacityPlanOption): boolean {
  const keys = new Set(plan.services.map((s) => isBuildSentinel(s.image)).filter((k): k is string => k !== null));
  return keys.has("realworld-node-express") && keys.has("realworld-react-frontend");
}

function checkTemplateTopology(plan: CapacityPlanOption): ReadinessCheckResult {
  const appCount = appServices(plan).length;
  if (appCount === 1 || isRealworldFullstackPlan(plan)) {
    return {
      name: "template_topology_supported",
      status: "pass",
      detail: isRealworldFullstackPlan(plan)
        ? "topology matches the known RealWorld fullstack pair (compose-realworld-fullstack-v1)"
        : "topology matches a known template shape",
      blocking: true,
    };
  }
  return {
    name: "template_topology_supported",
    status: "fail",
    detail: `${appCount} app service(s) planned — the template catalogue only covers single-app-service topologies (and the RealWorld fullstack pair) today`,
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
  existingPlan: CapacityPlanOption | null
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
  plan: CapacityPlanOption;
  existingPlan: CapacityPlanOption | null;
  existingEnvRecord: EnvironmentRecord | null;
  demoPortConflict: boolean;
  /** Enterprise Architecture Advisor mode (CapacityPlan.architecture_recommendation present) — also a Terraform/AWS path, but its single illustrative compute service carries no managed_service substitution for isAwsPlan's heuristic to key off. */
  isEnterpriseMode?: boolean;
}

export async function runReadinessCheck(
  input: ReadinessCheckInput
): Promise<{ report: ReadinessReport; portReassignments: PortReassignment[] }> {
  const aws = isAwsPlan(input.plan) || (input.isEnterpriseMode ?? false);
  const hostPorts = await checkHostPortsFree(input.plan, input.existingPlan, input.demoPortConflict);
  const checks: ReadinessCheckResult[] = [
    aws ? await checkTerraformCli() : await checkDockerDaemon(),
    hostPorts.result,
    await checkDiskSpace(),
    // AWS's fixed 5-service topology is a known, deliberate shape (see
    // iacGenerator.ts's mockIacGenerator AWS branch) — the single-app-service
    // guard below only applies to the generic compose engine.
    ...(aws ? [] : [checkTemplateTopology(input.plan)]),
  ];

  const driftCheck = await checkModifyDrift(input.existingEnvRecord, input.existingPlan);
  if (driftCheck) checks.push(driftCheck);

  const blockers = checks.filter((c) => c.status === "fail" && c.blocking).map((c) => c.detail);

  return {
    report: { request_id: input.requestId, checks, ready: blockers.length === 0, blockers },
    portReassignments: hostPorts.reassignments,
  };
}
