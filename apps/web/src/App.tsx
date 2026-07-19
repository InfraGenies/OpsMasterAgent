import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEvent, Run, WsEvent } from "@ops-master/shared";
import * as api from "./api";
import type { RunDetail } from "./api";
import { ApprovalGate } from "./components/ApprovalGate";
import { AuditTimeline } from "./components/AuditTimeline";
import { CapacityPlanView } from "./components/CapacityPlanView";
import { ChatInput } from "./components/ChatInput";
import { IacFileViewer } from "./components/IacFileViewer";
import { PipelineStepper } from "./components/PipelineStepper";
import { ReportView } from "./components/ReportView";
import { RunList } from "./components/RunList";
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

  async function handleSubmit(text: string) {
    setSubmitting(true);
    try {
      const { request_id } = await api.createRun(text);
      refreshRuns();
      setSelectedId(request_id);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDecision(action: "approve" | "reject" | "edit", comment: string | null, patch?: Record<string, unknown>) {
    if (!selectedId) return;
    try {
      await api.submitDecision(selectedId, action, comment, "operator (UI)", patch);
      refreshDetail(selectedId);
      refreshRuns();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  const report = detail?.run.status && ["deployed", "failed", "rolled_back", "refused"].includes(detail.run.status)
    ? reportFromEvents(events)
    : null;

  return (
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[320px_1fr]">
      <aside className="border-r border-slate-800 p-3 space-y-3">
        <div>
          <h1 className="text-sm font-semibold text-slate-100">Ops Master Agent</h1>
          <p className="text-xs text-slate-500">infra lifecycle automation</p>
        </div>
        <ChatInput onSubmit={handleSubmit} disabled={submitting} />
        <div>
          <h2 className="text-xs font-semibold text-slate-400 mb-1 uppercase tracking-wide">Runs</h2>
          <RunList runs={runs} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
      </aside>

      <main className="p-4 space-y-4 overflow-y-auto">
        {!detail && <p className="text-slate-500 text-sm">Select a run, or submit a new request to begin.</p>}

        {detail && (
          <>
            <div>
              <h2 className="text-sm font-medium text-slate-200">{detail.run.raw_text}</h2>
              <p className="text-xs text-slate-500">
                {detail.run.request_id} · {detail.run.operation} · status: {detail.run.status}
              </p>
            </div>

            <PipelineStepper events={events} />

            {detail.capacity_plan && (
              <section className="border border-slate-800 rounded-lg p-4 bg-slate-900">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Capacity Plan</h3>
                <CapacityPlanView plan={detail.capacity_plan} />
              </section>
            )}

            {detail.iac_payload && (
              <section className="border border-slate-800 rounded-lg p-4 bg-slate-900">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                  Infrastructure as Code — {detail.iac_payload.template_id}
                </h3>
                <IacFileViewer files={detail.iac_payload.files} diffFrom={detail.iac_payload.diff_from} />
              </section>
            )}

            {detail.run.status === "awaiting_approval" && detail.capacity_plan && detail.iac_payload && (
              <ApprovalGate plan={detail.capacity_plan} iac={detail.iac_payload} onDecision={handleDecision} />
            )}

            {logs.length > 0 && (
              <section className="border border-slate-800 rounded-lg p-3 bg-black">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Live log</h3>
                <pre className="text-[11px] text-slate-400 max-h-48 overflow-y-auto">{logs.join("\n")}</pre>
              </section>
            )}

            {detail.verify_report && (
              <section>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Verify</h3>
                <VerifyReportView report={detail.verify_report} />
              </section>
            )}

            {report && (
              <section>
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Deployment Report</h3>
                <ReportView markdown={report} />
              </section>
            )}

            <section>
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
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
