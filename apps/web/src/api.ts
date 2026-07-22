import type {
  AuditEvent,
  CapacityPlan,
  ComplianceReport,
  Decision,
  DecisionAction,
  IaCPayload,
  PlanRequest,
  PolicyReport,
  ReadinessReport,
  Run,
  VerifyReport,
} from "@ops-master/shared";

const BASE = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export function createRun(rawText: string, existingEnvId?: string | null): Promise<{ request_id: string }> {
  return fetch(`${BASE}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw_text: rawText, existing_env_id: existingEnvId ?? null }),
  }).then((res) => json<{ request_id: string }>(res));
}

export function listRuns(): Promise<Run[]> {
  return fetch(`${BASE}/runs`).then((res) => json<Run[]>(res));
}

export interface RunDetail {
  run: Run;
  plan_request: PlanRequest | null;
  capacity_plan: CapacityPlan | null;
  readiness_report: ReadinessReport | null;
  compliance_report: ComplianceReport | null;
  iac_payload: IaCPayload | null;
  policy_report: PolicyReport | null;
  verify_report: VerifyReport | null;
  decision: Decision | null;
}

export function getRun(id: string): Promise<RunDetail> {
  return fetch(`${BASE}/runs/${id}`).then((res) => json<RunDetail>(res));
}

export function getAudit(id: string): Promise<AuditEvent[]> {
  return fetch(`${BASE}/runs/${id}/audit`).then((res) => json<AuditEvent[]>(res));
}

export function submitDecision(
  id: string,
  action: DecisionAction,
  comment: string | null,
  actor: string,
  capacityPlanPatch?: Record<string, unknown>
): Promise<{ ok: true }> {
  return fetch(`${BASE}/runs/${id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, comment, actor, capacity_plan_patch: capacityPlanPatch }),
  }).then((res) => json<{ ok: true }>(res));
}
