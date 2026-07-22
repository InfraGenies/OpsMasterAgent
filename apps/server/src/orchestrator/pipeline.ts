import path from "node:path";
import type {
  CapacityPlan,
  CapacityPlanOption,
  DecisionAction,
  EnvironmentRecord,
  IaCPayload,
  PlanRequest,
  PolicyReport,
  Tier,
} from "@ops-master/shared";
import { env } from "../config.js";
import { runComplianceCheck } from "../nodes/complianceCheck.js";
import { decodeSnapshot, encodeSnapshot } from "../nodes/envSnapshot.js";
import { runDeploy } from "../nodes/deploy.js";
import { runIacGenerator } from "../nodes/iacGenerator.js";
import { runIntake } from "../nodes/intake.js";
import { runPlanner, selectOption } from "../nodes/planner.js";
import { estimateMonthlyCost } from "../pricing/rateTable.js";
import { runPolicyValidator } from "../nodes/policyValidator.js";
import { runReadinessCheck } from "../nodes/readinessCheck.js";
import { runReport } from "../nodes/report.js";
import { runRollback } from "../nodes/rollback.js";
import { runVerify } from "../nodes/verify.js";
import { getStore, type AuditStore } from "../store/index.js";
import { broadcastEvent } from "../ws/hub.js";
import { logAudit, loadLatestNodeOutput } from "./audit.js";
import { HttpError } from "./errors.js";
import { envIdFor, generateRequestId, projectNameFor } from "./ids.js";

const timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();

function deploymentDirFor(requestId: string): string {
  return path.join(env.DEPLOYMENTS_DIR, requestId);
}

function guessOperation(rawText: string): "create" | "modify" | "destroy" {
  if (/\b(destroy|tear down|delete everything)\b/i.test(rawText)) return "destroy";
  if (/\b(add|modify|update|extend|wire)\b/i.test(rawText)) return "modify";
  return "create";
}

async function findLatestUpEnvironment(store: AuditStore): Promise<EnvironmentRecord | null> {
  const envs = (await store.listEnvironments()).filter((e) => e.state === "up");
  return envs.length ? envs[envs.length - 1] : null;
}

interface ExistingEnv {
  envId: string;
  capacityPlan: CapacityPlanOption;
  files: IaCPayload["files"];
}

async function resolveExistingEnv(store: AuditStore, planRequest: PlanRequest): Promise<ExistingEnv | null> {
  const envId = planRequest.existing_env_id ?? (await findLatestUpEnvironment(store))?.env_id ?? null;
  if (!envId) return null;
  const record = await store.getEnvironment(envId);
  if (!record) return null;
  const snap = decodeSnapshot(record);
  return { envId, capacityPlan: snap.capacity_plan, files: snap.files };
}

/** modify-flow inputs to the planner/merge need a full multi-tier CapacityPlan, but an environment snapshot only ever stores the one tier that's actually deployed — wrap it as a single-option plan so mergeCapacityPlan has something to merge each delta tier onto. */
function wrapAsSingleOptionPlan(option: CapacityPlanOption, requestId: string): CapacityPlan {
  return { request_id: requestId, options: [option], recommended_tier: option.tier, feasible: true, infeasibility_reason: null };
}

// ---------------------------------------------------------------------------
// Refusal / rollback terminal paths
// ---------------------------------------------------------------------------

async function refuseRun(requestId: string, reason: string, reasoning?: string): Promise<void> {
  const store = getStore();
  await logAudit(store, { request_id: requestId, node: "refuse", actor: "agent", status: "success", detail: reason });
  await store.updateRunStatus(requestId, "refused", new Date().toISOString());
  const run = await store.getRun(requestId);
  const reportMd = await runReport({
    run: run!,
    auditEvents: await store.listAuditEvents(requestId),
    refusalReason: reasoning ? `${reason}\n\n${reasoning}` : reason,
  });
  await logAudit(store, { request_id: requestId, node: "report", actor: "agent", status: "success", detail: "refusal report generated", output: reportMd });
  broadcastEvent("run_finished", requestId, "report", { status: "refused", report: reportMd });
}

async function doRollback(
  requestId: string,
  payload: IaCPayload,
  operation: "create" | "modify" | "destroy",
  reason: string,
  verifyReport?: Awaited<ReturnType<typeof runVerify>>
): Promise<void> {
  const store = getStore();
  const projectName = projectNameFor(requestId);
  const deploymentDir = deploymentDirFor(requestId);

  broadcastEvent("node_started", requestId, "rollback");
  const rb = await runRollback({
    payload,
    deploymentDir,
    projectName,
    operation,
    onLog: (line) => broadcastEvent("log_line", requestId, "rollback", line),
  });
  await logAudit(store, {
    request_id: requestId,
    node: "rollback",
    actor: "agent",
    status: rb.ok ? "success" : "failure",
    detail: rb.detail,
    command_executed: rb.commandExecuted,
    output: { stdout: rb.stdout.slice(-4000) },
  });
  broadcastEvent("node_finished", requestId, "rollback", { ok: rb.ok, detail: rb.detail });

  const finalStatus = operation === "modify" && rb.ok ? "failed" : "rolled_back";
  await store.updateRunStatus(requestId, finalStatus, new Date().toISOString());

  const run = await store.getRun(requestId);
  const reportMd = await runReport({
    run: run!,
    verifyReport: verifyReport ? { ...verifyReport, rolled_back: true } : undefined,
    auditEvents: await store.listAuditEvents(requestId),
    refusalReason: `${reason}. ${rb.detail}`,
  });
  await logAudit(store, { request_id: requestId, node: "report", actor: "agent", status: "success", detail: "failure report generated", output: reportMd });
  broadcastEvent("run_finished", requestId, "report", { status: finalStatus, report: reportMd, rollback: rb });
}

// ---------------------------------------------------------------------------
// Approval timeout (04-approval-gate.md: 30 min no-decision -> auto-reject)
// ---------------------------------------------------------------------------

export function scheduleApprovalTimeout(requestId: string, sinceIso?: string): void {
  const since = sinceIso ? new Date(sinceIso).getTime() : Date.now();
  const remainingMs = env.APPROVAL_TIMEOUT_MINUTES * 60_000 - (Date.now() - since);

  const fire = async () => {
    timeoutHandles.delete(requestId);
    const store = getStore();
    const run = await store.getRun(requestId);
    if (run?.status !== "awaiting_approval") return;
    await store.writeDecision({
      request_id: requestId,
      action: "reject",
      comment: "auto-expired: no decision within timeout",
      actor: "system",
      ts: new Date().toISOString(),
    });
    await logAudit(store, {
      request_id: requestId,
      node: "approval_gate",
      actor: "agent",
      status: "failure",
      detail: `auto-expired after ${env.APPROVAL_TIMEOUT_MINUTES} min with no decision — treated as rejected, nothing dangling`,
    });
    await refuseRun(requestId, "approval timed out with no human decision");
  };

  const handle = setTimeout(fire, Math.max(0, remainingMs));
  // unref: an armed approval timer must never be the only thing keeping the
  // process alive (the smoke test would otherwise hang ~30 min after
  // finishing; the real server is kept alive by its HTTP listener anyway).
  handle.unref?.();
  timeoutHandles.set(requestId, handle);
}

export function clearApprovalTimeout(requestId: string): void {
  const handle = timeoutHandles.get(requestId);
  if (handle) {
    clearTimeout(handle);
    timeoutHandles.delete(requestId);
  }
}

/** Called once at server boot so a restart doesn't lose in-flight approval timeouts (the approval state itself is already durable — this only re-arms the clock). */
export async function rehydratePendingApprovals(): Promise<void> {
  const store = getStore();
  const runs = await store.listRuns();
  for (const run of runs) {
    if (run.status !== "awaiting_approval") continue;
    const events = await store.listAuditEvents(run.request_id);
    const gateEvent = [...events].reverse().find((e) => e.node === "approval_gate" && e.status === "pending");
    scheduleApprovalTimeout(run.request_id, gateEvent?.ts);
  }
}

// ---------------------------------------------------------------------------
// Phase 1: intake -> planner -> iac_generator -> approval gate
// ---------------------------------------------------------------------------

async function reachApprovalGate(
  requestId: string,
  planRequest: PlanRequest,
  fullPlan: CapacityPlan,
  existing: ExistingEnv | null
): Promise<void> {
  const store = getStore();
  // fullPlan.recommended_tier doubles as "currently selected tier" — the
  // agent's initial pick, or the human's after a tier-switch edit (see
  // applyCapacityPlanPatch). Only this one tier's flat plan flows through
  // readiness/iac/policy below; all options still ride along in fullPlan for
  // the approval-gate comparison UI.
  const plan = selectOption(fullPlan, fullPlan.recommended_tier);

  // readiness_check (02b-readiness-check.md): deterministic pre-flight scan,
  // runs before a single LLM call is spent on iac_generator. Refuses the run
  // the same way an infeasible plan does — no new terminal state.
  const existingEnvRecord = existing ? await store.getEnvironment(existing.envId) : null;
  const demoPortConflict = /\bport conflict\b/i.test(planRequest.raw_text);

  broadcastEvent("node_started", requestId, "readiness_check");
  const readiness = await runReadinessCheck({
    requestId,
    plan,
    existingPlan: existing?.capacityPlan ?? null,
    existingEnvRecord,
    demoPortConflict,
    isEnterpriseMode: fullPlan.architecture_recommendation != null,
  });
  await logAudit(store, {
    request_id: requestId,
    node: "readiness_check",
    actor: "agent",
    status: readiness.ready ? "success" : "failure",
    detail: readiness.ready
      ? `${readiness.checks.length} check(s), all clear`
      : `blocked: ${readiness.blockers.join("; ")}`,
    output: readiness,
  });
  broadcastEvent("node_finished", requestId, "readiness_check", readiness);

  if (!readiness.ready) {
    await refuseRun(requestId, `infrastructure not ready: ${readiness.blockers.join("; ")}`);
    return;
  }

  // compliance_check (02c-compliance-check.md): Enterprise Architecture
  // Advisor only — every finding is rooted in fullPlan.architecture_recommendation
  // (a planner-time decision), so unlike policy_validator this runs once,
  // pre-flight, with no retry loop: iac_generator has no lever over which
  // managed controls were chosen, so a retry would just reproduce the same
  // report. Never refuses the run — gaps ride to the gate as a visible
  // warning, same as unresolved PolicyFindings already do.
  if (fullPlan.architecture_recommendation) {
    broadcastEvent("node_started", requestId, "compliance_check");
    const compliance = runComplianceCheck(fullPlan.architecture_recommendation, requestId);
    await logAudit(store, {
      request_id: requestId,
      node: "compliance_check",
      actor: "agent",
      status: compliance.passed ? "success" : "failure",
      detail: compliance.passed
        ? `${compliance.findings.length} control(s) checked across ${compliance.frameworks.join(", ") || "no framework"}, no unresolved gaps`
        : `${compliance.gap_count} gap(s) found across ${compliance.frameworks.join(", ")}`,
      output: compliance,
    });
    broadcastEvent("node_finished", requestId, "compliance_check", compliance);
  }

  // Demo hook (mirrors nodes/verify.ts's forceFail): lets the self-correction
  // loop be exercised end-to-end with MOCK_LLM=true and no real API key.
  const demoWeakSecret = /\bweak password\b/i.test(planRequest.raw_text);

  const MAX_ATTEMPTS = 3;
  let feedback: string | undefined;
  let iacValue!: IaCPayload;
  let policyReport!: PolicyReport;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    broadcastEvent("node_started", requestId, "iac_generator");
    const iacResult = await runIacGenerator({
      requestId,
      projectName: projectNameFor(requestId),
      plan,
      isModify: planRequest.operation === "modify",
      diffFrom: existing?.files ?? null,
      deploymentDir: deploymentDirFor(requestId),
      feedback,
      demoWeakSecret,
      enterpriseArchetype: fullPlan.architecture_recommendation?.archetype ?? null,
    });

    if (!iacResult.ok) {
      await logAudit(store, {
        request_id: requestId,
        node: "iac_generator",
        actor: "agent",
        status: "failure",
        detail: `no_template: ${iacResult.needed}`,
        input: plan,
      });
      await refuseRun(requestId, `no template in the catalogue covers this topology: ${iacResult.needed}`);
      return;
    }

    iacValue = iacResult.value;
    await logAudit(store, {
      request_id: requestId,
      node: "iac_generator",
      actor: "agent",
      status: "success",
      detail: attempt === 1 ? (iacResult.mocked ? "mocked" : "ok") : `self-correction attempt ${attempt}`,
      input: plan,
      output: iacValue,
    });
    broadcastEvent("node_finished", requestId, "iac_generator", iacValue);

    // policy_validator: deterministic scan, no LLM — 03b-policy-validator.md.
    // Loops back to iac_generator only for findings it can plausibly fix
    // (currently: a literal secret instead of "__GENERATE__"); anything else
    // is surfaced at the gate rather than spinning the loop pointlessly.
    broadcastEvent("node_started", requestId, "policy_validator");
    policyReport = runPolicyValidator(iacValue, plan, planRequest, attempt);
    await logAudit(store, {
      request_id: requestId,
      node: "policy_validator",
      actor: "agent",
      status: policyReport.passed ? "success" : "failure",
      detail: `${policyReport.findings.length} finding(s) on attempt ${attempt}`,
      output: policyReport,
    });
    broadcastEvent("node_finished", requestId, "policy_validator", policyReport);

    const fixableBlocking = policyReport.findings.filter(
      (f) => (f.severity === "critical" || f.severity === "high") && f.auto_fixable
    );
    if (policyReport.passed || attempt === MAX_ATTEMPTS || fixableBlocking.length === 0) break;
    feedback = fixableBlocking.map((f) => `[${f.rule_id}] ${f.message}`).join("\n");
  }

  await store.updateRunStatus(requestId, "awaiting_approval");
  await logAudit(store, {
    request_id: requestId,
    node: "approval_gate",
    actor: "agent",
    status: "pending",
    detail: "awaiting human decision",
  });
  broadcastEvent("awaiting_approval", requestId, "approval_gate", { plan: fullPlan, iac: iacValue, policy: policyReport });
  scheduleApprovalTimeout(requestId);
}

async function runIntakeThroughGate(requestId: string, rawText: string, existingEnvId: string | null): Promise<void> {
  const store = getStore();

  broadcastEvent("node_started", requestId, "intake");
  const intakeResult = await runIntake(requestId, rawText, existingEnvId);
  await logAudit(store, {
    request_id: requestId,
    node: "intake",
    actor: "agent",
    status: "success",
    detail: intakeResult.mocked ? "mocked" : "ok",
    input: rawText,
    output: intakeResult.value,
  });
  broadcastEvent("node_finished", requestId, "intake", intakeResult.value);

  if (!intakeResult.value.feasible_input) {
    await refuseRun(requestId, intakeResult.value.infeasibility_reason ?? "request rejected at intake");
    return;
  }
  const planRequest = intakeResult.value;

  let existing: ExistingEnv | null = null;
  if (planRequest.operation === "modify") {
    existing = await resolveExistingEnv(store, planRequest);
    if (!existing) {
      await refuseRun(requestId, "operation=modify requested but no existing environment was found to modify");
      return;
    }
  }

  broadcastEvent("node_started", requestId, "planner");
  const existingFullPlan = existing ? wrapAsSingleOptionPlan(existing.capacityPlan, requestId) : null;
  const plannerResult = await runPlanner(planRequest, existingFullPlan);
  await logAudit(store, {
    request_id: requestId,
    node: "planner",
    actor: "agent",
    status: "success",
    detail: plannerResult.mocked ? "mocked" : "ok",
    input: planRequest,
    output: plannerResult.value,
  });
  broadcastEvent("node_finished", requestId, "planner", plannerResult.value);

  if (!plannerResult.value.feasible) {
    const fallback = selectOption(plannerResult.value);
    await refuseRun(requestId, plannerResult.value.infeasibility_reason ?? "plan infeasible", fallback.reasoning);
    return;
  }

  await reachApprovalGate(requestId, planRequest, plannerResult.value, existing);
}

export async function startRun(rawText: string, existingEnvId: string | null): Promise<string> {
  const store = getStore();
  const requestId = generateRequestId();
  await store.createRun({
    request_id: requestId,
    raw_text: rawText,
    operation: guessOperation(rawText),
    status: "running",
    created_at: new Date().toISOString(),
    finished_at: null,
  });

  runIntakeThroughGate(requestId, rawText, existingEnvId).catch(async (err) => {
    console.error(`[pipeline] intake phase failed for ${requestId}:`, err);
    await store.updateRunStatus(requestId, "failed", new Date().toISOString()).catch(() => {});
    broadcastEvent("run_finished", requestId, undefined, { status: "failed", error: String(err) });
  });

  return requestId;
}

// ---------------------------------------------------------------------------
// Phase 2: human decision -> rework (reject/edit) or deploy->verify->report (approve)
// ---------------------------------------------------------------------------

/** Human edits at the approval gate: switch which tier is selected, and/or override replicas/memory/cpu on specific services within the currently-selected tier. */
function applyCapacityPlanPatch(fullPlan: CapacityPlan, patch: Record<string, unknown>): CapacityPlan {
  let plan = fullPlan;

  const selectedTier = typeof patch.selected_tier === "string" ? (patch.selected_tier as Tier) : undefined;
  if (selectedTier && plan.options.some((o) => o.tier === selectedTier)) {
    plan = { ...plan, recommended_tier: selectedTier };
  }

  const patchServices = patch.services as
    | Array<{ name: string; replicas?: number; memory?: string; cpu?: string }>
    | undefined;
  if (patchServices?.length) {
    const options = plan.options.map((opt) => {
      if (opt.tier !== plan.recommended_tier) return opt;
      const services = opt.services.map((s) => {
        const p = patchServices.find((x) => x.name === s.name);
        return p ? { ...s, replicas: p.replicas ?? s.replicas, memory: p.memory ?? s.memory, cpu: p.cpu ?? s.cpu } : s;
      });
      const cost = estimateMonthlyCost(services, opt.storage);
      return {
        ...opt,
        services,
        estimated_cost_usd_monthly: cost.totalUsdMonthly,
        cost_breakdown: cost.breakdown,
        cost_basis: "rate_table" as const,
      };
    });
    plan = { ...plan, options };
  }

  return plan;
}

async function reworkPlan(
  requestId: string,
  action: DecisionAction,
  comment: string | null,
  capacityPlanPatch?: Record<string, unknown>
): Promise<void> {
  const store = getStore();
  const planRequest = await loadLatestNodeOutput<PlanRequest>(store, requestId, "intake");
  if (!planRequest) {
    await refuseRun(requestId, "internal error: lost PlanRequest state during rework");
    return;
  }

  let existing: ExistingEnv | null = null;
  if (planRequest.operation === "modify") existing = await resolveExistingEnv(store, planRequest);

  let plan: CapacityPlan;
  if (action === "edit") {
    const previousPlan = await loadLatestNodeOutput<CapacityPlan>(store, requestId, "planner");
    if (!previousPlan) {
      await refuseRun(requestId, "internal error: lost CapacityPlan state during edit");
      return;
    }
    plan = applyCapacityPlanPatch(previousPlan, capacityPlanPatch ?? {});
    await logAudit(store, {
      request_id: requestId,
      node: "planner",
      actor: "human",
      status: "success",
      detail: "human edit applied directly to capacity plan (tier selection and/or replicas/memory/cpu)",
      output: plan,
    });
    broadcastEvent("node_finished", requestId, "planner", plan);
  } else {
    broadcastEvent("node_started", requestId, "planner");
    const existingFullPlan = existing ? wrapAsSingleOptionPlan(existing.capacityPlan, requestId) : null;
    const plannerResult = await runPlanner(planRequest, existingFullPlan, comment ?? undefined);
    await logAudit(store, {
      request_id: requestId,
      node: "planner",
      actor: "agent",
      status: "success",
      detail: `rework after rejection${comment ? `: ${comment}` : ""}`,
      input: planRequest,
      output: plannerResult.value,
    });
    broadcastEvent("node_finished", requestId, "planner", plannerResult.value);
    if (!plannerResult.value.feasible) {
      const fallback = selectOption(plannerResult.value);
      await refuseRun(requestId, plannerResult.value.infeasibility_reason ?? "plan infeasible", fallback.reasoning);
      return;
    }
    plan = plannerResult.value;
  }

  await reachApprovalGate(requestId, planRequest, plan, existing);
}

async function runDeployThroughReport(requestId: string): Promise<void> {
  const store = getStore();
  const planRequest = await loadLatestNodeOutput<PlanRequest>(store, requestId, "intake");
  const fullPlan = await loadLatestNodeOutput<CapacityPlan>(store, requestId, "planner");
  const payload = await loadLatestNodeOutput<IaCPayload>(store, requestId, "iac_generator");
  if (!planRequest || !fullPlan || !payload) {
    await refuseRun(requestId, "internal error: lost pipeline state before deploy");
    return;
  }
  const plan = selectOption(fullPlan, fullPlan.recommended_tier);

  const deploymentDir = deploymentDirFor(requestId);

  broadcastEvent("node_started", requestId, "deploy");
  const deployOutcome = await runDeploy({
    payload,
    deploymentDir,
    onLog: (line) => broadcastEvent("log_line", requestId, "deploy", line),
  });
  await logAudit(store, {
    request_id: requestId,
    node: "deploy",
    actor: "agent",
    status: deployOutcome.deployOk ? "success" : "failure",
    detail: deployOutcome.detail,
    command_executed: payload.apply_command,
    output: { stdout: deployOutcome.stdout.slice(-4000) },
  });
  broadcastEvent("node_finished", requestId, "deploy", { ok: deployOutcome.deployOk, detail: deployOutcome.detail });

  if (!deployOutcome.deployOk) {
    await doRollback(requestId, payload, planRequest.operation, "deploy failed");
    return;
  }

  const endpoints = plan.network.expose.map((e) => `http://localhost:${e.host_port}`);

  broadcastEvent("node_started", requestId, "verify");
  const verifyReport = await runVerify({
    requestId,
    endpoints,
    healthPath: "/",
    targetRps: planRequest.expected_load.rps,
    onLog: (line) => broadcastEvent("log_line", requestId, "verify", line),
    forceFail: /\b(demo-fail|wrong (db )?password)\b/i.test(planRequest.raw_text),
    terraformDeployDetail: payload.format === "terraform" ? deployOutcome.detail : undefined,
  });
  await logAudit(store, {
    request_id: requestId,
    node: "verify",
    actor: "agent",
    status: verifyReport.verdict === "green" ? "success" : "failure",
    detail: verifyReport.summary,
    output: verifyReport,
  });
  broadcastEvent("node_finished", requestId, "verify", verifyReport);

  if (verifyReport.verdict === "red") {
    await doRollback(requestId, payload, planRequest.operation, "verify red", verifyReport);
    return;
  }

  const envId = planRequest.operation === "modify" && planRequest.existing_env_id ? planRequest.existing_env_id : envIdFor(requestId);
  const { files_json, endpoints_json } = encodeSnapshot(
    { template_id: payload.template_id, capacity_plan: plan, files: payload.files },
    endpoints
  );
  await store.upsertEnvironment({
    env_id: envId,
    request_id: requestId,
    name: envId,
    target: planRequest.constraints.target,
    files_json,
    endpoints_json,
    state: "up",
  });

  await store.updateRunStatus(requestId, "deployed", new Date().toISOString());
  const run = await store.getRun(requestId);
  const reportMd = await runReport({
    run: run!,
    planRequest,
    capacityPlan: plan,
    verifyReport,
    auditEvents: await store.listAuditEvents(requestId),
  });
  await logAudit(store, { request_id: requestId, node: "report", actor: "agent", status: "success", detail: "deployment report generated", output: reportMd });
  broadcastEvent("run_finished", requestId, "report", { status: "deployed", report: reportMd, verify: verifyReport, endpoints });
}

export async function submitDecision(
  requestId: string,
  action: DecisionAction,
  comment: string | null,
  actor: string,
  capacityPlanPatch?: Record<string, unknown>
): Promise<void> {
  const store = getStore();
  const run = await store.getRun(requestId);
  if (!run) throw new HttpError(404, "run not found");
  if (run.status !== "awaiting_approval") {
    throw new HttpError(409, `run is not awaiting approval (status=${run.status})`);
  }

  clearApprovalTimeout(requestId);
  await store.writeDecision({ request_id: requestId, action, comment, actor, ts: new Date().toISOString() });
  await logAudit(store, {
    request_id: requestId,
    node: "approval_gate",
    actor: "human",
    status: "success",
    detail: `${action}${comment ? `: ${comment}` : ""}`,
  });
  broadcastEvent("node_finished", requestId, "approval_gate", { action, comment });

  if (action === "approve") {
    runDeployThroughReport(requestId).catch(async (err) => {
      console.error(`[pipeline] deploy phase failed for ${requestId}:`, err);
      await store.updateRunStatus(requestId, "failed", new Date().toISOString()).catch(() => {});
      broadcastEvent("run_finished", requestId, undefined, { status: "failed", error: String(err) });
    });
    return;
  }

  await store.updateRunStatus(requestId, "running");
  reworkPlan(requestId, action, comment, capacityPlanPatch).catch(async (err) => {
    console.error(`[pipeline] rework failed for ${requestId}:`, err);
    await store.updateRunStatus(requestId, "failed", new Date().toISOString()).catch(() => {});
    broadcastEvent("run_finished", requestId, undefined, { status: "failed", error: String(err) });
  });
}
