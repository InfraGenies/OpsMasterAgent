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
    <div className="min-h-screen grid grid-cols-1 md:grid-cols-[340px_1fr]">
      <aside className="border-r border-slate-800/80 p-4 space-y-4 md:h-screen md:overflow-y-auto md:sticky md:top-0 bg-slate-950/60">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-sm shadow-md shadow-indigo-950/50 select-none">
            ⚙️
          </div>
          <div>
            <h1 className="text-sm font-semibold bg-gradient-to-r from-slate-100 to-slate-400 bg-clip-text text-transparent">
              Ops Master Agent
            </h1>
            <p className="text-[11px] text-slate-500">infra lifecycle automation</p>
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

            {detail.iac_payload && (
              <section className="card p-4">
                <h3 className="card-title mb-2.5">
                  Infrastructure as Code — {detail.iac_payload.template_id}
                </h3>
                <IacFileViewer files={detail.iac_payload.files} diffFrom={detail.iac_payload.diff_from} />
              </section>
            )}

            {detail.run.status === "awaiting_approval" && detail.capacity_plan && detail.iac_payload && (
              <ApprovalGate plan={detail.capacity_plan} iac={detail.iac_payload} onDecision={handleDecision} />
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
