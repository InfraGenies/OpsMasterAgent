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
import { runBuild } from "../nodes/build.js";
import { runDeploy } from "../nodes/deploy.js";
import { runIacGenerator } from "../nodes/iacGenerator.js";
import { appServices, hostPortFor } from "../templates/types.js";
import { runIntake } from "../nodes/intake.js";
import { runPlanner, selectOption } from "../nodes/planner.js";
import { LLMValidationError } from "../llm/runLLMJson.js";
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

/** Both deploy-track gates keep the 30-min timeout (deployment is the eventual intent); only the plan-only track's dedicated review gate ("awaiting_plan_review") is exempt. */
const TIMEOUT_GATE_STATUSES = ["awaiting_plan_approval", "awaiting_approval"] as const;

function deploymentDirFor(requestId: string): string {
  return path.join(env.DEPLOYMENTS_DIR, requestId);
}

/**
 * runPlanner can throw LLMValidationError after exhausting runLLMJson's one
 * retry (seen in practice on the Enterprise Architecture Advisor path, whose
 * large architecture_recommendation output has more surface area to get
 * wrong) — previously that raw response was discarded entirely, so a
 * validation failure was undebuggable after the fact. Logged under `detail`,
 * not `output`, so this failure event is never mistaken for a valid
 * CapacityPlan by loadLatestNodeOutput's "latest planner output" lookup.
 */
async function runPlannerWithFailureAudit(
  store: AuditStore,
  requestId: string,
  ...args: Parameters<typeof runPlanner>
): ReturnType<typeof runPlanner> {
  try {
    return await runPlanner(...args);
  } catch (err) {
    const detail =
      err instanceof LLMValidationError
        ? `${err.message}\n\nRaw LLM response (truncated to 4000 chars):\n${err.rawResponse.slice(0, 4000)}`
        : err instanceof Error
          ? err.message
          : String(err);
    await logAudit(store, { request_id: requestId, node: "planner", actor: "agent", status: "failure", detail });
    throw err;
  }
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
  verifyReport?: Awaited<ReturnType<typeof runVerify>>,
  mockOverride?: boolean
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
    mockOverride,
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
    if (!run || !TIMEOUT_GATE_STATUSES.includes(run.status as (typeof TIMEOUT_GATE_STATUSES)[number])) return;
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
    if (!TIMEOUT_GATE_STATUSES.includes(run.status as (typeof TIMEOUT_GATE_STATUSES)[number])) continue;
    const events = await store.listAuditEvents(run.request_id);
    const gateEvent = [...events].reverse().find((e) => e.node === "approval_gate" && e.status === "pending");
    scheduleApprovalTimeout(run.request_id, gateEvent?.ts);
  }
}

// ---------------------------------------------------------------------------
// Phase 1: intake -> planner -> iac_generator -> approval gate
// ---------------------------------------------------------------------------

/**
 * Gate 1 of the deploy track: is this plan sound and deployable at all?
 * readiness_check/compliance_check need only the CapacityPlan, no IaC, so
 * they run here — before a human ever approves the plan, and before a
 * single iac_generator LLM call is spent. On approval ("approve_plan"),
 * submitDecision calls reachApprovalGate (Gate 2) directly.
 */
async function reachPlanApprovalGate(
  requestId: string,
  planRequest: PlanRequest,
  fullPlan: CapacityPlan,
  existing: ExistingEnv | null
): Promise<void> {
  const store = getStore();
  // fullPlan.recommended_tier doubles as "currently selected tier" — the
  // agent's initial pick, or the human's after a tier-switch edit (see
  // applyCapacityPlanPatch). Only this one tier's flat plan flows through
  // readiness below; all options still ride along in fullPlan for the
  // plan-approval-gate comparison UI.
  const plan = selectOption(fullPlan, fullPlan.recommended_tier);

  // readiness_check (02b-readiness-check.md): deterministic pre-flight scan,
  // runs before a single LLM call is spent on iac_generator. Refuses the run
  // the same way an infeasible plan does — no new terminal state.
  const existingEnvRecord = existing ? await store.getEnvironment(existing.envId) : null;
  const demoPortConflict = /\bport conflict\b/i.test(planRequest.raw_text);

  broadcastEvent("node_started", requestId, "readiness_check");
  const { report: readiness, portReassignments } = await runReadinessCheck({
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

  // readiness_check may have auto-reassigned a conflicting host port on the
  // live `plan` object (a reference into fullPlan.options) — re-persist the
  // corrected CapacityPlan as the new latest "planner" output so approve_plan
  // (which reloads it fresh from the audit trail) and the human at the gate
  // both see the port that will actually be used, not the stale conflicting one.
  if (portReassignments.length) {
    const detail = `port(s) auto-reassigned by readiness_check to avoid a conflict: ${portReassignments
      .map((r) => `${r.service} ${r.from}->${r.to}`)
      .join(", ")}`;
    await logAudit(store, {
      request_id: requestId,
      node: "planner",
      actor: "agent",
      status: "success",
      detail,
      output: fullPlan,
    });
    broadcastEvent("node_finished", requestId, "planner", fullPlan);
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

  await store.updateRunStatus(requestId, "awaiting_plan_approval");
  await logAudit(store, {
    request_id: requestId,
    node: "approval_gate",
    actor: "agent",
    status: "pending",
    detail: "awaiting human plan approval (Gate 1 — no IaC generated yet)",
  });
  broadcastEvent("awaiting_plan_approval", requestId, "approval_gate", { plan: fullPlan });
  scheduleApprovalTimeout(requestId);
}

/**
 * Gate 2 of the deploy track: is the generated code correct and safe?
 * Entered only after a human approves the plan at Gate 1 ("approve_plan").
 * readiness_check/compliance_check already happened at Gate 1 — this is
 * purely iac_generator/policy_validator's retry loop, then the final human
 * decision before deploy.
 */
async function reachApprovalGate(
  requestId: string,
  planRequest: PlanRequest,
  fullPlan: CapacityPlan,
  existing: ExistingEnv | null
): Promise<void> {
  const store = getStore();
  const plan = selectOption(fullPlan, fullPlan.recommended_tier);

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
      architectureRecommendation: fullPlan.architecture_recommendation ?? null,
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
    detail: "awaiting human deploy approval (Gate 2)",
  });
  broadcastEvent("awaiting_approval", requestId, "approval_gate", { plan: fullPlan, iac: iacValue, policy: policyReport });
  scheduleApprovalTimeout(requestId);
}

async function runIntakeThroughGate(
  requestId: string,
  rawText: string,
  existingEnvId: string | null,
  planOnly: boolean
): Promise<void> {
  const store = getStore();

  broadcastEvent("node_started", requestId, "intake");
  const intakeResult = await runIntake(requestId, rawText, existingEnvId, planOnly);
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
  const plannerResult = await runPlannerWithFailureAudit(store, requestId, planRequest, existingFullPlan);
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

  if (planRequest.plan_only) {
    await reachPlanReviewGate(requestId, planRequest, plannerResult.value);
    return;
  }
  await reachPlanApprovalGate(requestId, planRequest, plannerResult.value, existing);
}

export async function startRun(rawText: string, existingEnvId: string | null, planOnly = false): Promise<string> {
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

  runIntakeThroughGate(requestId, rawText, existingEnvId, planOnly).catch(async (err) => {
    console.error(`[pipeline] intake phase failed for ${requestId}:`, err);
    await store.updateRunStatus(requestId, "failed", new Date().toISOString()).catch(() => {});
    broadcastEvent("run_finished", requestId, undefined, { status: "failed", error: String(err) });
  });

  return requestId;
}

// ---------------------------------------------------------------------------
// Plan-only track: stop after the planner, no IaC/deploy ever generated.
// No approval timeout applies here — see submitDecision/reachPlanReviewGate.
// ---------------------------------------------------------------------------

/** Plan-only equivalent of reachApprovalGate: runs compliance_check (enterprise-mode only, same as the deploy track) then pauses for human review with no timeout and no IaC/deploy ever generated. */
async function reachPlanReviewGate(requestId: string, planRequest: PlanRequest, fullPlan: CapacityPlan): Promise<void> {
  const store = getStore();

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

  await store.updateRunStatus(requestId, "awaiting_plan_review");
  await logAudit(store, {
    request_id: requestId,
    node: "approval_gate",
    actor: "agent",
    status: "pending",
    detail: "awaiting human plan review (plan-only — no deployment)",
  });
  broadcastEvent("awaiting_plan_review", requestId, "approval_gate", { plan: fullPlan });
  // No scheduleApprovalTimeout call: a plan-only run has nothing dangling to
  // force a decision about, so it can sit under review indefinitely.
  void planRequest;
}

/** Human accepted the plan via "accept_plan" — closes the run out with a report, no deploy ever happens. */
async function finalizePlanOnly(requestId: string): Promise<void> {
  const store = getStore();
  const planRequest = await loadLatestNodeOutput<PlanRequest>(store, requestId, "intake");
  const fullPlan = await loadLatestNodeOutput<CapacityPlan>(store, requestId, "planner");
  if (!planRequest || !fullPlan) {
    await refuseRun(requestId, "internal error: lost pipeline state before finalizing plan");
    return;
  }
  const plan = selectOption(fullPlan, fullPlan.recommended_tier);

  await store.updateRunStatus(requestId, "plan_ready", new Date().toISOString());
  const run = await store.getRun(requestId);
  const reportMd = await runReport({
    run: run!,
    planRequest,
    capacityPlan: plan,
    auditEvents: await store.listAuditEvents(requestId),
  });
  await logAudit(store, { request_id: requestId, node: "report", actor: "agent", status: "success", detail: "plan accepted, no deployment", output: reportMd });
  broadcastEvent("run_finished", requestId, "report", { status: "plan_ready", report: reportMd });
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
    const plannerResult = await runPlannerWithFailureAudit(store, requestId, planRequest, existingFullPlan, comment ?? undefined);
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

  if (planRequest.plan_only) {
    await reachPlanReviewGate(requestId, planRequest, plan);
    return;
  }
  // Every reject/edit returns to Gate 1 for re-approval of the (possibly
  // changed) plan — never straight back to Gate 2. This also means an
  // "edit" (tier switch / replica tweak) is free (no LLM call) until the
  // human clicks "approve_plan" again.
  await reachPlanApprovalGate(requestId, planRequest, plan, existing);
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
  let plan = selectOption(fullPlan, fullPlan.recommended_tier);

  const deploymentDir = deploymentDirFor(requestId);

  // Build-sentinel path only (nodes/buildRegistry.ts): clone + npm build +
  // docker build + bring up the db + migrate, before the normal `deploy`
  // step below. Every existing template leaves build_steps null, so this
  // never runs, never logs a "build" audit event, and behavior is otherwise
  // byte-identical to before.
  let mockOverride: boolean | undefined;
  if (payload.build_steps?.length) {
    broadcastEvent("node_started", requestId, "build");
    const buildOutcome = await runBuild({
      payload,
      deploymentDir,
      onLog: (line) => broadcastEvent("log_line", requestId, "build", line),
    });
    await logAudit(store, {
      request_id: requestId,
      node: "build",
      actor: "agent",
      status: buildOutcome.buildOk ? "success" : "failure",
      detail: buildOutcome.detail,
      output: { stdout: buildOutcome.stdout.slice(-4000) },
    });
    broadcastEvent("node_finished", requestId, "build", { ok: buildOutcome.buildOk, detail: buildOutcome.detail });

    if (!buildOutcome.buildOk) {
      await doRollback(requestId, payload, planRequest.operation, "build failed", undefined, buildOutcome.mocked || undefined);
      return;
    }
    // A mocked build never actually produced an image — force the rest of
    // this chain to mock too, so it can't be followed by a for-real deploy
    // that would just fail against a nonexistent image (nodes/dockerProbe.ts:
    // shouldMockBuild vs shouldMockDeploy are deliberately separate gates).
    mockOverride = buildOutcome.mocked || undefined;
  }

  // Snapshot what's actually running, not the __BUILD__:... sentinel the
  // planner emitted — resolved_images is only ever populated on the
  // build-sentinel path (nodes/iacGenerator.ts).
  if (payload.resolved_images) {
    plan = {
      ...plan,
      services: plan.services.map((s) =>
        payload.resolved_images && s.name in payload.resolved_images ? { ...s, image: payload.resolved_images[s.name] } : s
      ),
    };
  }

  broadcastEvent("node_started", requestId, "deploy");
  const deployOutcome = await runDeploy({
    payload,
    deploymentDir,
    onLog: (line) => broadcastEvent("log_line", requestId, "deploy", line),
    mockOverride,
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
    await doRollback(requestId, payload, planRequest.operation, "deploy failed", undefined, mockOverride);
    return;
  }

  // Every compose template fronts the app service on hostPortFor(plan,
  // app.name, containerPort) — computed the identical way inside each
  // template's own render() (templates/catalog.ts). Deriving the endpoint
  // the same way here, rather than trusting plan.network.expose verbatim,
  // is what the template actually published: a real LLM plan can carry an
  // extra network.expose entry (e.g. a redundant "lb" service name) that
  // compose-web-db-v1 silently ignores in favor of its own auto-generated
  // load-balancer sidecar, which is keyed by the app service's name and
  // falls back to a different port when no matching expose entry exists —
  // checking plan.network.expose verbatim in that case verifies a port
  // nothing is actually listening on. Confirmed via a real UC-1 run: deploy
  // succeeded (container reported healthy) but verify checked the LLM's
  // stray "lb" port instead of the one nginx was actually published on.
  // Was appServices(plan)[0] — now maps every app-classified service (the
  // RealWorld fullstack pair puts 2 here: backend + frontend), each paired
  // with its own health path from payload.health_path (keyed by service
  // name). appServices() ordering already puts the backend/primary service
  // first (mockPlanner/sizing-workloads.md push it before any paired
  // frontend), which is why runVerify's smoke test (only ever probes
  // endpoints[0]) still load-tests the real API, not a static frontend.
  const appSvcs = appServices(plan);
  const endpointPairs =
    payload.format === "compose" && appSvcs.length > 0
      ? appSvcs.map((svc) => ({
          url: `http://localhost:${hostPortFor(plan, svc.name, svc.ports[0] ?? 3000)}`,
          healthPath: payload.health_path[svc.name] ?? "/",
        }))
      : plan.network.expose.map((e) => ({ url: `http://localhost:${e.host_port}`, healthPath: "/" }));
  const endpoints = endpointPairs.map((p) => p.url);

  broadcastEvent("node_started", requestId, "verify");
  const verifyReport = await runVerify({
    requestId,
    endpoints: endpointPairs,
    targetRps: planRequest.expected_load.rps,
    onLog: (line) => broadcastEvent("log_line", requestId, "verify", line),
    forceFail: /\b(demo-fail|wrong (db )?password)\b/i.test(planRequest.raw_text),
    terraformDeployDetail: payload.format === "terraform" ? deployOutcome.detail : undefined,
    terraformEndpoint: payload.format === "terraform" ? deployOutcome.terraformEndpoint : undefined,
    mockOverride,
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
    await doRollback(requestId, payload, planRequest.operation, "verify red", verifyReport, mockOverride);
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

/** Which actions make sense at each gate — a mismatched action/status pair is a clear client error, not a silent no-op.
 * "abandon" is available everywhere "reject" is: unlike "reject" (which always loops back to the planner for
 * another LLM pass), it terminates the run immediately via refuseRun, no rework. */
const ALLOWED_ACTIONS_BY_STATUS: Record<string, DecisionAction[]> = {
  awaiting_plan_approval: ["approve_plan", "reject", "edit", "abandon"],
  awaiting_approval: ["approve", "reject", "abandon"],
  awaiting_plan_review: ["accept_plan", "reject", "abandon"],
};

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
  const allowedActions = ALLOWED_ACTIONS_BY_STATUS[run.status];
  if (!allowedActions) {
    throw new HttpError(409, `run is not awaiting a decision (status=${run.status})`);
  }
  if (!allowedActions.includes(action)) {
    throw new HttpError(400, `action "${action}" is not valid while status=${run.status} (expected one of: ${allowedActions.join(", ")})`);
  }

  clearApprovalTimeout(requestId); // no-op if never armed (plan-only runs never schedule one)
  await store.writeDecision({ request_id: requestId, action, comment, actor, ts: new Date().toISOString() });
  await logAudit(store, {
    request_id: requestId,
    node: "approval_gate",
    actor: "human",
    status: "success",
    detail: `${action}${comment ? `: ${comment}` : ""}`,
  });
  broadcastEvent("node_finished", requestId, "approval_gate", { action, comment });

  if (action === "approve_plan") {
    // Flip status off "awaiting_plan_approval" synchronously, before the async work below
    // starts — reachApprovalGate can take minutes (iac_generator/policy_validator retries).
    // Leaving status unchanged during that window lets a second "approve_plan" submitted
    // before the UI's own disabled-button state naturally resets (App.tsx only disables it
    // for the HTTP round-trip, not for the fire-and-forgotten pipeline work) pass this same
    // status check again and kick off a second concurrent run.
    await store.updateRunStatus(requestId, "running");
    (async () => {
      const planRequest = await loadLatestNodeOutput<PlanRequest>(store, requestId, "intake");
      const fullPlan = await loadLatestNodeOutput<CapacityPlan>(store, requestId, "planner");
      if (!planRequest || !fullPlan) {
        await refuseRun(requestId, "internal error: lost pipeline state during plan approval");
        return;
      }
      let existing: ExistingEnv | null = null;
      if (planRequest.operation === "modify") existing = await resolveExistingEnv(store, planRequest);
      await reachApprovalGate(requestId, planRequest, fullPlan, existing);
    })().catch(async (err) => {
      console.error(`[pipeline] plan-approval phase failed for ${requestId}:`, err);
      await store.updateRunStatus(requestId, "failed", new Date().toISOString()).catch(() => {});
      broadcastEvent("run_finished", requestId, undefined, { status: "failed", error: String(err) });
    });
    return;
  }

  if (action === "approve") {
    // Same reasoning as approve_plan above: flip status off "awaiting_approval" before
    // starting the build/deploy sequence, which can run for minutes. Without this, a
    // duplicate "approve" click (e.g. because the UI still shows the gate) re-passes the
    // status check and starts a second concurrent runDeployThroughReport for the same
    // requestId — this is what caused a real build failure (colliding "git clone" into the
    // same deployment dir from two simultaneous runs).
    await store.updateRunStatus(requestId, "running");
    runDeployThroughReport(requestId).catch(async (err) => {
      console.error(`[pipeline] deploy phase failed for ${requestId}:`, err);
      await store.updateRunStatus(requestId, "failed", new Date().toISOString()).catch(() => {});
      broadcastEvent("run_finished", requestId, undefined, { status: "failed", error: String(err) });
    });
    return;
  }

  if (action === "accept_plan") {
    finalizePlanOnly(requestId).catch(async (err) => {
      console.error(`[pipeline] plan finalization failed for ${requestId}:`, err);
      await store.updateRunStatus(requestId, "failed", new Date().toISOString()).catch(() => {});
      broadcastEvent("run_finished", requestId, undefined, { status: "failed", error: String(err) });
    });
    return;
  }

  if (action === "abandon") {
    // Unlike "reject" (always another planner LLM pass, back to the same gate), this ends the
    // run outright — no rework loop, no further LLM calls. Goes straight to refuseRun's
    // "refused" terminal status, same as an infeasible plan or a timed-out gate.
    refuseRun(requestId, comment ? `abandoned by human: ${comment}` : "abandoned by human").catch(async (err) => {
      console.error(`[pipeline] abandon failed for ${requestId}:`, err);
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
