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
    <div className="border border-amber-800 rounded-lg p-4 bg-amber-950/20 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-amber-400 font-semibold text-sm">🛑 Human approval required</span>
        <span
          className={`text-xs px-2 py-0.5 rounded-full border ${
            iac.validation.ok
              ? "border-emerald-700 text-emerald-300 bg-emerald-950"
              : "border-red-700 text-red-300 bg-red-950"
          }`}
        >
          {iac.validation.tool}: {iac.validation.ok ? "valid" : "invalid"}
        </span>
      </div>
      <div className="text-xs text-slate-400">
        will run: <code className="text-slate-200">{iac.apply_command}</code>
        <br />
        rollback: <code className="text-slate-200">{iac.rollback_command}</code>
      </div>

      {editing && (
        <div className="space-y-2 border border-slate-800 rounded-md p-2">
          {plan.services.map((s) => (
            <div key={s.name} className="flex items-center gap-2 text-xs">
              <span className="w-20 text-slate-300">{s.name}</span>
              <label className="flex items-center gap-1">
                replicas
                <input
                  type="number"
                  min={1}
                  className="w-14 bg-slate-950 border border-slate-700 rounded px-1"
                  value={edits[s.name]?.replicas ?? s.replicas}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [s.name]: { ...prev[s.name], replicas: Number(e.target.value) } }))
                  }
                />
              </label>
              <label className="flex items-center gap-1">
                memory
                <input
                  className="w-16 bg-slate-950 border border-slate-700 rounded px-1"
                  value={edits[s.name]?.memory ?? s.memory}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [s.name]: { ...prev[s.name], memory: e.target.value } }))
                  }
                />
              </label>
            </div>
          ))}
          <div className="flex gap-2">
            <button className="text-xs px-2 py-1 rounded bg-indigo-600" onClick={submitEdit}>
              Re-render with these values
            </button>
            <button className="text-xs px-2 py-1 rounded bg-slate-800" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <textarea
        className="w-full bg-slate-950 border border-slate-800 rounded-md p-2 text-xs resize-none"
        rows={2}
        placeholder="Optional comment (used as feedback if you reject)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />

      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-sm font-medium"
          onClick={() => onDecision("approve", comment || null)}
        >
          Approve &amp; Deploy
        </button>
        <button
          className="px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-sm font-medium"
          onClick={() => onDecision("reject", comment || null)}
        >
          Reject with comment
        </button>
        <button
          className="px-3 py-1.5 rounded-md bg-slate-700 hover:bg-slate-600 text-sm font-medium"
          onClick={() => setEditing((v) => !v)}
        >
          Edit parameters
        </button>
      </div>
    </div>
  );
}
