import type { AuditEvent, NodeName } from "@ops-master/shared";

const STEPS: { key: NodeName; label: string }[] = [
  { key: "intake", label: "Intake" },
  { key: "planner", label: "Planner" },
  { key: "iac_generator", label: "IaC Generator" },
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
  idle: "bg-slate-800 text-slate-500 border-slate-700",
  pending: "bg-amber-950 text-amber-300 border-amber-700 animate-pulse",
  success: "bg-emerald-950 text-emerald-300 border-emerald-700",
  failure: "bg-red-950 text-red-300 border-red-700",
};

export function PipelineStepper({ events }: { events: AuditEvent[] }) {
  const hasRollback = events.some((e) => e.node === "rollback");
  const hasRefuse = events.some((e) => e.node === "refuse");
  const steps = STEPS.filter((s) => (s.key === "rollback" ? hasRollback : s.key === "refuse" ? hasRefuse : true));

  return (
    <div className="flex flex-wrap gap-2">
      {steps.map((step) => {
        const status = statusFor(events, step.key);
        return (
          <div
            key={step.key}
            className={`px-3 py-1.5 rounded-full border text-xs font-medium ${STYLES[status]}`}
            title={status}
          >
            {step.label}
          </div>
        );
      })}
    </div>
  );
}
