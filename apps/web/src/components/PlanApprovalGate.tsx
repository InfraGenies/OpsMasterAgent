import { useState } from "react";
import type { CapacityPlan, Tier } from "@ops-master/shared";
import { CapacityPlanView } from "./CapacityPlanView";

/** Gate 1 of the deploy track: approve the capacity plan itself, before any IaC exists. Tier-switching and
 * replica/memory edits live here (free, no LLM call) rather than at Gate 2, where the plan is already locked
 * in and only the generated IaC/deploy commands are under review. */
export function PlanApprovalGate({
  plan,
  onDecision,
  disabled,
}: {
  plan: CapacityPlan;
  onDecision: (action: "approve_plan" | "reject" | "edit", comment: string | null, patch?: Record<string, unknown>) => void;
  disabled?: boolean;
}) {
  const activeOption = plan.options.find((o) => o.tier === plan.recommended_tier) ?? plan.options[0];
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, { replicas: number; memory: string }>>(() =>
    Object.fromEntries(activeOption.services.map((s) => [s.name, { replicas: s.replicas, memory: s.memory }]))
  );

  function submitEdit() {
    const patch = {
      services: Object.entries(edits).map(([name, v]) => ({ name, replicas: v.replicas, memory: v.memory })),
    };
    onDecision("edit", comment || null, patch);
    setEditing(false);
  }

  function switchTier(tier: Tier) {
    if (tier === plan.recommended_tier) return;
    onDecision("edit", null, { selected_tier: tier });
  }

  return (
    <div className="rounded-xl border border-amber-600/50 bg-gradient-to-b from-amber-950/40 to-slate-900/60 p-4 space-y-3 shadow-lg shadow-amber-950/20">
      <div className="flex items-center flex-wrap gap-2">
        <span className="inline-flex items-center gap-2 text-amber-300 font-semibold text-sm">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
          Plan ready for approval — Gate 1 of 2
        </span>
      </div>

      {plan.options.length > 1 && (
        <div className="space-y-1.5">
          <div className="text-xs text-slate-400">
            Click another tier to re-check readiness for it before approving:
          </div>
          <CapacityPlanView plan={plan} selectedTier={plan.recommended_tier} onSelectTier={switchTier} />
        </div>
      )}

      {editing && (
        <div className="space-y-2 border border-slate-700/70 rounded-lg p-3 bg-slate-950/50">
          {activeOption.services.map((s) => (
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
            <button className="btn-primary btn-sm" disabled={disabled} onClick={submitEdit}>
              Update plan with these values
            </button>
            <button className="btn-ghost btn-sm" disabled={disabled} onClick={() => setEditing(false)}>
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
        <button className="btn-success" disabled={disabled} onClick={() => onDecision("approve_plan", comment || null)}>
          ✓ Approve plan — generate infrastructure code
        </button>
        <button className="btn-danger" disabled={disabled} onClick={() => onDecision("reject", comment || null)}>
          ✕ Reject with comment
        </button>
        <button className="btn-ghost" disabled={disabled} onClick={() => setEditing((v) => !v)}>
          ✎ Edit parameters
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Approving locks in this plan and moves to generating infrastructure code — you'll get a second,
        separate approval before anything actually deploys. Rejecting with a comment re-runs the planner
        with your feedback; iterate as many times as you like.
      </p>
    </div>
  );
}
