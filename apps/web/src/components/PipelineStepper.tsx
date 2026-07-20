import { Fragment } from "react";
import type { AuditEvent, NodeName } from "@ops-master/shared";

const STEPS: { key: NodeName; label: string }[] = [
  { key: "intake", label: "Intake" },
  { key: "planner", label: "Planner" },
  { key: "readiness_check", label: "Readiness" },
  { key: "iac_generator", label: "IaC Generator" },
  { key: "policy_validator", label: "Policy & Security" },
  { key: "approval_gate", label: "Approval Gate" },
  { key: "deploy", label: "Deploy" },
  { key: "verify", label: "Verify" },
  { key: "rollback", label: "Rollback" },
  { key: "report", label: "Report" },
  { key: "refuse", label: "Refused" },
];

type Status = "idle" | "pending" | "success" | "failure";

function statusFor(events: AuditEvent[], node: NodeName): Status {
  const matches = events.filter((e) => e.node === node);
  if (!matches.length) return "idle";
  return matches[matches.length - 1].status as Status;
}

const STYLES: Record<Status, string> = {
  idle: "bg-slate-900/60 text-slate-600 border-slate-800",
  pending: "bg-amber-950/80 text-amber-300 border-amber-600/70 animate-pulse shadow-md shadow-amber-950/40",
  success: "bg-emerald-950/80 text-emerald-300 border-emerald-700/70",
  failure: "bg-rose-950/80 text-rose-300 border-rose-700/70",
};

const ICONS: Record<Status, string> = {
  idle: "○",
  pending: "◔",
  success: "✓",
  failure: "✕",
};

export function PipelineStepper({ events }: { events: AuditEvent[] }) {
  const hasRollback = events.some((e) => e.node === "rollback");
  const hasRefuse = events.some((e) => e.node === "refuse");
  const steps = STEPS.filter((s) => (s.key === "rollback" ? hasRollback : s.key === "refuse" ? hasRefuse : true));

  return (
    <div className="flex flex-wrap items-center gap-y-2">
      {steps.map((step, i) => {
        const status = statusFor(events, step.key);
        return (
          <Fragment key={step.key}>
            {i > 0 && <span className="mx-1.5 text-slate-700 text-xs select-none">─</span>}
            <div
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors duration-300 ${STYLES[status]}`}
              title={status}
            >
              <span className="text-[10px]">{ICONS[status]}</span>
              {step.label}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
