import type { IaCPayload } from "@ops-master/shared";
import { awsCredentialEnv, isAwsApplyEnabled, resolveAllowedCommand, runAllowedCommand } from "./commandAllowList.js";
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
  /** Set only when the terraform path actually ran a real `apply` (ALLOW_AWS_APPLY=true) and it succeeded — the live URL verify.ts should health-check. Undefined for every compose deploy and for the default plan-only terraform path. */
  terraformEndpoint?: string;
}

/**
 * Exit patterns that look like a transient race (image-pull timeout,
 * port-bind race, a flaky registry/network blip) rather than a genuinely
 * broken payload (bad compose syntax, missing image, config error) — those
 * fail identically on a retry, so only these patterns get one. See
 * source_configuration/ops-master-agent-enhancements-proposal.md §6.2.
 */
const TRANSIENT_FAILURE_PATTERNS = [
  /address already in use/i,
  /port is already allocated/i,
  /i\/o timeout/i,
  /TLS handshake timeout/i,
  /Client\.Timeout exceeded/i,
  /connection reset by peer/i,
];

function looksTransient(output: string): boolean {
  return TRANSIENT_FAILURE_PATTERNS.some((p) => p.test(output));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** First matching key from `terraform output -json` across the UC-9/enterprise terraform templates' own output blocks (terraformCatalog.ts, enterpriseCatalog.ts) — each renders a differently-named URL output, so this tries them in a fixed priority order rather than assuming one name. */
function extractTerraformEndpoint(outputJson: string): string | undefined {
  let parsed: Record<string, { value?: unknown }>;
  try {
    parsed = JSON.parse(outputJson);
  } catch {
    return undefined;
  }
  for (const key of ["application_url", "retail_app_url", "alb_dns_name"]) {
    const value = parsed[key]?.value;
    if (typeof value === "string" && value) {
      return value.startsWith("http") ? value : `http://${value}`;
    }
  }
  return undefined;
}

/**
 * UC-9 AWS/Terraform path. Default (ALLOW_AWS_APPLY unset/false, every
 * environment except an explicitly configured demo machine): plan-only,
 * exactly as before — `apply`/`destroy` aren't reachable in
 * commandAllowList.ts, so there is no code path from here to a real AWS
 * account. A terraform init/plan failure in that mode is an environment
 * fact (missing CLI, no network, no AWS credentials — this app configures
 * none by default), not a broken payload, so it's reported as a successful
 * SIMULATED plan rather than triggering a rollback — there was never
 * anything applied to roll back.
 *
 * When ALLOW_AWS_APPLY=true, a clean plan is followed by a real `terraform
 * apply` of that exact saved plan file (see commandAllowList.ts's gated
 * apply/destroy rules) against whatever AWS credentials this machine has
 * configured. A real apply failure now correctly returns `deployOk: false`,
 * reaching rollback (nodes/rollback.ts) for the first time — that path was
 * unreachable dead code under the old always-`deployOk:true` plan-only
 * behavior.
 *
 * init/plan get a short timeout when the flag is off (`PLAN_ONLY_TIMEOUT_MS`)
 * regardless of whether real AWS credentials happen to be sitting in this
 * machine's environment (e.g. a demo machine mid-setup, credentials left
 * over from a prior armed run) — a plan-only run has nothing to gain from a
 * slow, real AWS round-trip succeeding, since the result is discarded and
 * reported as plan-only either way. Without this bound, valid credentials
 * present on a machine with ALLOW_AWS_APPLY=false can turn what used to be a
 * fast "no credentials" failure into a multi-minute real `terraform plan`
 * against AWS — confirmed live: this is exactly what made `npm run smoke`
 * time out after the tf-ecs-fargate-v1 module-schema bug above was fixed
 * (before that fix, `terraform init` itself always failed fast instead).
 */
const PLAN_ONLY_TIMEOUT_MS = 30_000;

async function runTerraform(input: DeployInput): Promise<DeployOutcome> {
  const initArgv = resolveAllowedCommand("terraform init -backend=false -input=false -no-color");
  const planArgv = resolveAllowedCommand("terraform plan -input=false -no-color -out=tfplan");
  if (!initArgv || !planArgv) {
    return { deployOk: false, detail: "refused: terraform init/plan command not in the allow-list", stdout: "" };
  }

  for (const f of input.payload.files) input.onLog(`[terraform] rendered ${f.path}`);

  const planOnlyTimeout = isAwsApplyEnabled() ? undefined : PLAN_ONLY_TIMEOUT_MS;
  const initResult = await runAllowedCommand(
    "terraform",
    initArgv,
    input.deploymentDir,
    input.onLog,
    planOnlyTimeout
  );
  if (!initResult.ok) {
    if (isAwsApplyEnabled()) {
      // ALLOW_AWS_APPLY=true means a real apply was actually expected here —
      // silently reporting "SIMULATED success" would hide a real, possibly
      // fixable problem (a template/module bug, not just absent
      // credentials) behind a green result during an armed live demo.
      input.onLog("[terraform] init failed — ALLOW_AWS_APPLY is on, so this is a real failure, not a simulated one");
      return { deployOk: false, detail: `terraform init failed: ${initResult.output.slice(-1000)}`, stdout: initResult.output };
    }
    input.onLog("[terraform] init did not complete (SIMULATED) — plan-only sandbox, nothing was ever going to be applied");
    return {
      deployOk: true,
      detail: "SIMULATED terraform plan (init could not complete in this sandbox — no terraform CLI/network/AWS credentials expected here)",
      stdout: initResult.output,
    };
  }

  const planResult = await runAllowedCommand("terraform", planArgv, input.deploymentDir, input.onLog, planOnlyTimeout);
  if (!planResult.ok) {
    if (isAwsApplyEnabled()) {
      input.onLog("[terraform] plan failed — ALLOW_AWS_APPLY is on, so this is a real failure, not a simulated one");
      return {
        deployOk: false,
        detail: `terraform plan failed: ${planResult.output.slice(-1000)}`,
        stdout: initResult.output + "\n" + planResult.output,
      };
    }
    input.onLog("[terraform] plan did not complete (SIMULATED)");
    return {
      deployOk: true,
      detail: "SIMULATED terraform plan (plan could not complete in this sandbox — likely missing AWS credentials, which this app never configures)",
      stdout: initResult.output + "\n" + planResult.output,
    };
  }
  input.onLog("[terraform] plan completed cleanly");

  if (!isAwsApplyEnabled()) {
    // Plan succeeded for real (valid credentials were reachable) but the app
    // deliberately stopped here because ALLOW_AWS_APPLY is off — surface the
    // self-serve path explicitly: the exact files a human could review and
    // apply by hand still exist on disk (rendered by iac_generator at Gate 2,
    // unconditionally, regardless of this flag) and the saved plan file
    // (tfplan) this "plan" command just produced applies deterministically,
    // with no surprises from re-planning at apply time.
    const selfServeHint =
      `A valid plan exists. To apply it yourself: cd "${input.deploymentDir}" && ` +
      `terraform apply -input=false -no-color -auto-approve tfplan (uses whatever AWS credentials ` +
      `your own shell has configured — independent of this app's ALLOW_AWS_APPLY setting).`;
    input.onLog(`[terraform] ALLOW_AWS_APPLY is off — nothing applied to AWS (plan-only). ${selfServeHint}`);
    return {
      deployOk: true,
      detail: `terraform plan completed cleanly (plan-only — nothing was ever applied to AWS). ${selfServeHint}`,
      stdout: initResult.output + "\n" + planResult.output,
    };
  }

  const applyArgv = resolveAllowedCommand("terraform apply -input=false -no-color -auto-approve tfplan");
  if (!applyArgv) {
    return { deployOk: false, detail: "refused: terraform apply command not in the allow-list", stdout: initResult.output + "\n" + planResult.output };
  }
  input.onLog("[terraform] ALLOW_AWS_APPLY is on — applying the saved plan to a REAL AWS account");
  const applyResult = await runAllowedCommand("terraform", applyArgv, input.deploymentDir, input.onLog, 900_000, awsCredentialEnv());
  const combinedStdout = `${initResult.output}\n${planResult.output}\n${applyResult.output}`;
  if (!applyResult.ok) {
    input.onLog("[terraform] apply failed — a real AWS deploy attempt did not succeed");
    return { deployOk: false, detail: "terraform apply failed against a real AWS account", stdout: combinedStdout };
  }

  const outputArgv = resolveAllowedCommand("terraform output -json");
  const outputResult = outputArgv
    ? await runAllowedCommand("terraform", outputArgv, input.deploymentDir, () => {}, 60_000, awsCredentialEnv())
    : undefined;
  const endpoint = outputResult?.ok ? extractTerraformEndpoint(outputResult.output) : undefined;
  input.onLog(
    endpoint
      ? `[terraform] apply succeeded — live endpoint: ${endpoint}`
      : "[terraform] apply succeeded, but no known output key found to derive a live endpoint"
  );
  return {
    deployOk: true,
    detail: endpoint
      ? `REAL AWS deploy applied — ${endpoint}`
      : "REAL AWS deploy applied (no endpoint output found to health-check)",
    stdout: combinedStdout,
    terraformEndpoint: endpoint,
  };
}

/**
 * 05-deploy-agent.md: deterministic executor, no LLM in this node. Asserting
 * a decision row exists is done by the orchestrator before calling this
 * (belt-and-braces alongside the graph's own interrupt_before gate).
 */
export async function runDeploy(input: DeployInput): Promise<DeployOutcome> {
  if (input.payload.format === "terraform") return runTerraform(input);

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
    // gate, only the process spawn. The files themselves were already
    // rendered to deploymentDir by iac_generator at the approval gate,
    // unconditionally — surface that path + the exact command so this is a
    // self-serve deploy once Docker is available, not a dead end.
    const selfServeHint =
      `Files were rendered to "${input.deploymentDir}". To deploy manually once Docker Desktop is ` +
      `running: cd "${input.deploymentDir}" && ${input.payload.apply_command}`;
    input.onLog(`[mock deploy] docker CLI unavailable — simulating: ${input.payload.apply_command}`);
    for (const f of input.payload.files) input.onLog(`[mock deploy] would apply ${f.path}`);
    input.onLog(`[mock deploy] all services report healthy (simulated). ${selfServeHint}`);
    return {
      deployOk: true,
      detail: `SIMULATED deploy (mock deploy mode — docker CLI not present on this machine). ${selfServeHint}`,
      stdout: "[mock deploy] simulated success",
    };
  }

  let result = await runAllowedCommand("docker", argv, input.deploymentDir, input.onLog);
  if (result.ok) {
    return { deployOk: true, detail: "containers reported healthy (--wait)", stdout: result.output };
  }

  // One bounded retry, only for failures that look transient — a genuine
  // config/payload error fails identically on a retry, so this never masks
  // real problems, it only absorbs a flaky pull/port-bind race.
  if (looksTransient(result.output)) {
    input.onLog("[deploy] transient-looking failure, retrying once in 3s: " + result.output.slice(-300));
    await sleep(3000);
    result = await runAllowedCommand("docker", argv, input.deploymentDir, input.onLog);
    if (result.ok) {
      return { deployOk: true, detail: "containers reported healthy (--wait, after one retry)", stdout: result.output };
    }
  }

  return {
    deployOk: false,
    detail: "apply_command exited non-zero or timed out",
    stdout: result.output,
  };
}
