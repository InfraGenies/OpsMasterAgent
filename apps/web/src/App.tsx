import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEvent, Run, WsEvent } from "@ops-master/shared";
import * as api from "./api";
import type { RunDetail } from "./api";
import { ApprovalGate } from "./components/ApprovalGate";
import { ArchitectureRecommendationView } from "./components/ArchitectureRecommendationView";
import { AuditTimeline } from "./components/AuditTimeline";
import { CapacityPlanView } from "./components/CapacityPlanView";
import { ChatInput } from "./components/ChatInput";
import { ComplianceReportView } from "./components/ComplianceReportView";
import { IacFileViewer } from "./components/IacFileViewer";
import { PipelineStepper } from "./components/PipelineStepper";
import { PlanReviewGate } from "./components/PlanReviewGate";
import { PolicyReportView } from "./components/PolicyReportView";
import { ReadinessReportView } from "./components/ReadinessReportView";
import { ReportView } from "./components/ReportView";
import { RunList, StatusBadge } from "./components/RunList";
import { VerifyReportView } from "./components/VerifyReportView";
import { useRunSocket } from "./hooks/useRunSocket";

function reportFromEvents(events: AuditEvent[]): string | null {
  const match = [...events].reverse().find((e) => e.node === "report" && e.output_json);
  if (!match?.output_json) return null;
  try {
    return JSON.parse(match.output_json) as string;
  } catch {
    return null;
  }
}

export function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const refreshRuns = useCallback(() => {
    api.listRuns().then(setRuns).catch(console.error);
  }, []);

  const refreshDetail = useCallback((id: string) => {
    api.getRun(id).then(setDetail).catch(console.error);
    api.getAudit(id).then(setEvents).catch(console.error);
  }, []);

  useEffect(() => {
    refreshRuns();
  }, [refreshRuns]);

  useEffect(() => {
    if (!selectedId) return;
    setLogs([]);
    refreshDetail(selectedId);
  }, [selectedId, refreshDetail]);

  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      refreshRuns();
      if (event.request_id === selectedIdRef.current) {
        if (event.type === "log_line") {
          setLogs((prev) => [...prev.slice(-199), String(event.payload)]);
        } else {
          refreshDetail(event.request_id);
        }
      }
    },
    [refreshRuns, refreshDetail]
  );

  useRunSocket(handleWsEvent);

  async function handleSubmit(text: string, planOnly: boolean) {
    setSubmitting(true);
    try {
      const { request_id } = await api.createRun(text, planOnly);
      refreshRuns();
      setSelectedId(request_id);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecision(
    action: "approve" | "reject" | "edit" | "accept_plan",
    comment: string | null,
    patch?: Record<string, unknown>
  ) {
    if (!selectedId) return;
    try {
      await api.submitDecision(selectedId, action, comment, "operator (UI)", patch);
      refreshDetail(selectedId);
      refreshRuns();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  const report = detail?.run.status && ["deployed", "failed", "rolled_back", "refused", "plan_ready"].includes(detail.run.status)
    ? reportFromEvents(events)
    : null;

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[440px_1fr]">
      <aside className="border-r border-slate-800/80 p-5 space-y-5 md:h-screen md:overflow-y-auto md:sticky md:top-0 bg-slate-950/60">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-lg shadow-md shadow-indigo-950/50 select-none">
            ⚙️
          </div>
          <div>
            <h1 className="text-lg font-semibold bg-gradient-to-r from-slate-100 to-slate-300 bg-clip-text text-transparent">
              Ops Master Agent
            </h1>
            <p className="text-sm text-slate-400">infra lifecycle automation</p>
          </div>
        </div>
        <ChatInput onSubmit={handleSubmit} disabled={submitting} />
        <div>
          <h2 className="card-title mb-2">Runs</h2>
          <RunList runs={runs} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </aside>

      <main className="p-5 space-y-4 overflow-y-auto">
        {!detail && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center space-y-2 max-w-sm">
              <div className="text-3xl select-none">🛰️</div>
              <p className="text-slate-400 text-sm font-medium">No run selected</p>
              <p className="text-slate-600 text-xs">
                Submit a natural-language infrastructure request on the left, or pick an existing run to inspect its
                plan, IaC, and audit trail.
              </p>
            </div>
          </div>
        )}

        {detail && (
          <>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-slate-100 leading-snug">{detail.run.raw_text}</h2>
                <p className="text-xs text-slate-500 mt-1 font-mono">
                  {detail.run.request_id} · {detail.run.operation}
                </p>
              </div>
              <StatusBadge status={detail.run.status} />
            </div>

            <PipelineStepper events={events} />

            {detail.capacity_plan && (
              <section className="card p-4">
                <h3 className="card-title mb-2.5">Capacity Plan</h3>
                <CapacityPlanView plan={detail.capacity_plan} />
              </section>
            )}

            {detail.capacity_plan?.architecture_recommendation && (
              <section className="card p-4">
                <h3 className="card-title mb-2.5">Architecture Recommendation</h3>
                <ArchitectureRecommendationView rec={detail.capacity_plan.architecture_recommendation} />
              </section>
            )}

            {detail.readiness_report && (
              <section className="card p-4">
                <h3 className="card-title mb-2.5">Readiness</h3>
                <ReadinessReportView report={detail.readiness_report} />
              </section>
            )}

            {detail.compliance_report && (
              <section className="card p-4">
                <h3 className="card-title mb-2.5">Compliance &amp; Governance</h3>
                <ComplianceReportView report={detail.compliance_report} />
              </section>
            )}

            {detail.iac_payload && (
              <section className="card p-4">
                <h3 className="card-title mb-2.5">
                  Infrastructure as Code — {detail.iac_payload.template_id}
                </h3>
                <IacFileViewer files={detail.iac_payload.files} diffFrom={detail.iac_payload.diff_from} />
              </section>
            )}

            {detail.policy_report && (
              <section className="card p-4">
                <h3 className="card-title mb-2.5">Policy &amp; Security</h3>
                <PolicyReportView report={detail.policy_report} />
              </section>
            )}

            {detail.run.status === "awaiting_approval" && detail.capacity_plan && detail.iac_payload && (
              <ApprovalGate
                key={detail.capacity_plan.recommended_tier}
                plan={detail.capacity_plan}
                iac={detail.iac_payload}
                policy={detail.policy_report}
                onDecision={handleDecision}
              />
            )}

            {detail.run.status === "awaiting_plan_review" && detail.capacity_plan && (
              <PlanReviewGate
                key={detail.capacity_plan.recommended_tier}
                plan={detail.capacity_plan}
                onDecision={handleDecision}
              />
            )}

            {logs.length > 0 && (
              <section className="rounded-xl border border-slate-800 bg-black/80 p-3 shadow-lg shadow-black/30">
                <h3 className="card-title mb-1.5">Live log</h3>
                <pre className="text-[11px] text-emerald-400/90 font-mono max-h-48 overflow-y-auto">{logs.join("\n")}</pre>
              </section>
            )}

            {detail.verify_report && (
              <section>
                <h3 className="card-title mb-2">Verify</h3>
                <VerifyReportView report={detail.verify_report} />
              </section>
            )}

            {report && (
              <section>
                <h3 className="card-title mb-2">Deployment Report</h3>
                <ReportView markdown={report} />
              </section>
            )}

            <section>
              <h3 className="card-title mb-2">
                Audit Timeline ({events.length})
              </h3>
              <AuditTimeline events={events} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
