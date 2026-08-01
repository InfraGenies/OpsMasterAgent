import { useState } from "react";
import type { IaCPayload, PolicyReport } from "@ops-master/shared";

/** Gate 2 of the deploy track: the plan itself was already approved at Gate 1 (see PlanApprovalGate) — this
 * reviews the generated IaC and deploy commands only. No tier-switching or replica editing here; that's a
 * plan-level decision and lives at Gate 1. Rejecting sends the request back to Gate 1 with the comment.
 * The plan itself is already shown read-only by App.tsx's generic "Capacity Plan" section above this gate. */
export function ApprovalGate({
  iac,
  policy,
  onDecision,
  disabled,
}: {
  iac: IaCPayload;
  policy?: PolicyReport | null;
  onDecision: (action: "approve" | "reject" | "abandon", comment: string | null) => void;
  disabled?: boolean;
}) {
  const unresolvedBlocking = policy?.findings.filter(
    (f) => f.severity === "critical" || f.severity === "high"
  );
  const [comment, setComment] = useState("");

  return (
    <div className="rounded-xl border border-amber-600/50 bg-gradient-to-b from-amber-950/40 to-slate-900/60 p-4 space-y-3 shadow-lg shadow-amber-950/20">
      <div className="flex items-center flex-wrap gap-2">
        <span className="inline-flex items-center gap-2 text-amber-300 font-semibold text-sm">
          <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
          Ready for deploy approval — Gate 2 of 2
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
        {iac.template_id === "freeform" && (
          <span className="status-badge border-amber-700/70 text-amber-300 bg-amber-950/50">
            ✎ Custom-written by the agent — not a vetted template, review carefully
          </span>
        )}
      </div>

      {unresolvedBlocking && unresolvedBlocking.length > 0 && (
        <div className="text-xs text-rose-300 bg-rose-950/60 border border-rose-800 rounded-lg p-2.5">
          ⚠️ {unresolvedBlocking.length} unresolved policy finding{unresolvedBlocking.length > 1 ? "s" : ""} — review
          the Policy &amp; Security section below before approving.
        </div>
      )}

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

      <textarea
        className="field w-full p-2.5 text-xs resize-none"
        rows={2}
        placeholder="Optional comment — recorded in the audit trail; used as planner feedback if you reject"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        <button className="btn-success" disabled={disabled} onClick={() => onDecision("approve", comment || null)}>
          ✓ Approve &amp; Deploy
        </button>
        <button className="btn-danger" disabled={disabled} onClick={() => onDecision("reject", comment || null)}>
          ✕ Reject with comment
        </button>
        <button
          className="btn-ghost text-rose-400 hover:text-rose-300"
          disabled={disabled}
          onClick={() => onDecision("abandon", comment || null)}
        >
          ⏹ Abandon run
        </button>
      </div>
      <p className="text-xs text-slate-500">
        This is the final gate before deployment — the plan itself was already approved in the previous
        step. Rejecting here sends it back for plan re-approval with your feedback. Abandoning stops the
        run for good — nothing more will happen without starting a new request.
      </p>
    </div>
  );
}
