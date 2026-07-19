import { useState } from "react";
import type { CapacityPlan, IaCPayload } from "@ops-master/shared";

export function ApprovalGate({
  plan,
  iac,
  onDecision,
}: {
  plan: CapacityPlan;
  iac: IaCPayload;
  onDecision: (action: "approve" | "reject" | "edit", comment: string | null, patch?: Record<string, unknown>) => void;
}) {
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, { replicas: number; memory: string }>>(() =>
    Object.fromEntries(plan.services.map((s) => [s.name, { replicas: s.replicas, memory: s.memory }]))
  );

  function submitEdit() {
    const patch = {
      services: Object.entries(edits).map(([name, v]) => ({ name, replicas: v.replicas, memory: v.memory })),
    };
    onDecision("edit", comment || null, patch);
    setEditing(false);
  }

  return (
    <div className="rounded-xl border border-amber-600/50 bg-gradient-to-b from-amber-950/40 to-slate-900/60 p-4 space-y-3 shadow-lg shadow-amber-950/20">
      <div className="flex items-center flex-wrap gap-2">
        <span className="inline-flex items-center gap-2 text-amber-300 font-semibold text-sm">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400" />
          </span>
          Human approval required
        </span>
        <span
          className={`status-badge ${
            iac.validation.ok
              ? "border-emerald-700 text-emerald-300 bg-emerald-950/60"
              : "border-rose-700 text-rose-300 bg-rose-950/60"
          }`}
        >
          {iac.validation.tool}: {iac.validation.ok ? "valid" : "invalid"}
        </span>
      </div>

      <div className="text-xs text-slate-400 font-mono bg-slate-950/60 border border-slate-800 rounded-lg p-2.5 space-y-1">
        <div>
          <span className="text-slate-600 select-none">$ </span>
          <span className="text-slate-200">{iac.apply_command}</span>
        </div>
        <div>
          <span className="text-slate-600 select-none">rollback: </span>
          <span className="text-slate-400">{iac.rollback_command}</span>
        </div>
      </div>

      {editing && (
        <div className="space-y-2 border border-slate-700/70 rounded-lg p-3 bg-slate-950/50">
          {plan.services.map((s) => (
            <div key={s.name} className="flex items-center gap-3 text-xs">
              <span className="w-20 text-slate-300 font-medium">{s.name}</span>
              <label className="flex items-center gap-1.5 text-slate-500">
                replicas
                <input
                  type="number"
                  min={1}
                  className="field w-14 px-1.5 py-1 text-slate-200"
                  value={edits[s.name]?.replicas ?? s.replicas}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [s.name]: { ...prev[s.name], replicas: Number(e.target.value) } }))
                  }
                />
              </label>
              <label className="flex items-center gap-1.5 text-slate-500">
                memory
                <input
                  className="field w-16 px-1.5 py-1 text-slate-200"
                  value={edits[s.name]?.memory ?? s.memory}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [s.name]: { ...prev[s.name], memory: e.target.value } }))
                  }
                />
              </label>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <button className="btn-primary btn-sm" onClick={submitEdit}>
              Re-render with these values
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <textarea
        className="field w-full p-2.5 text-xs resize-none"
        rows={2}
        placeholder="Optional comment — recorded in the audit trail; used as planner feedback if you reject"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        <button className="btn-success" onClick={() => onDecision("approve", comment || null)}>
          ✓ Approve &amp; Deploy
        </button>
        <button className="btn-danger" onClick={() => onDecision("reject", comment || null)}>
          ✕ Reject with comment
        </button>
        <button className="btn-ghost" onClick={() => setEditing((v) => !v)}>
          ✎ Edit parameters
        </button>
      </div>
    </div>
  );
}
