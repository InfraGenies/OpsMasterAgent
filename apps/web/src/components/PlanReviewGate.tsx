import { useState } from "react";
import type { CapacityPlan, Tier } from "@ops-master/shared";
import { CapacityPlanView } from "./CapacityPlanView";

/** Plan-only track's review gate: no IaC/deploy exists for this run and there's no timeout — this is purely
 * "does this plan look right", with the same reject-and-reiterate mechanism ApprovalGate uses (reusing the
 * "reject" action under the hood), just framed as refinement rather than a final go/no-go. */
export function PlanReviewGate({
  plan,
  onDecision,
  disabled,
}: {
  plan: CapacityPlan;
  onDecision: (action: "accept_plan" | "reject", comment: string | null) => void;
  disabled?: boolean;
}) {
  const activeOption = plan.options.find((o) => o.tier === plan.recommended_tier) ?? plan.options[0];
  const [comment, setComment] = useState("");

  function switchTier(tier: Tier) {
    // Plan-only review has no re-render/re-check loop to trigger — tier
    // preference is just noted in the comment for the next planner pass.
    if (tier === plan.recommended_tier) return;
    setComment((prev) => (prev ? prev : `Prefer the "${tier}" tier over "${plan.recommended_tier}".`));
  }

  return (
    <div className="rounded-xl border border-indigo-800/50 bg-gradient-to-b from-indigo-950/30 to-slate-900/60 p-4 space-y-3 shadow-lg shadow-indigo-950/10">
      <div className="flex items-center flex-wrap gap-2">
        <span className="inline-flex items-center gap-2 text-indigo-300 font-semibold text-sm">
          <span className="w-2.5 h-2.5 rounded-full bg-indigo-400" />
          Plan ready for review
        </span>
      </div>

      <p className="text-xs text-slate-400">
        This is a proposal only — no infrastructure-as-code or deployment has been generated for it, and
        there's no time limit. Review it, ask for changes, or accept it whenever you're ready.
      </p>

      {plan.options.length > 1 && (
        <div className="space-y-1.5">
          <div className="text-xs text-slate-400">Compare tiers (informational — note a preference in your comment below):</div>
          <CapacityPlanView plan={plan} selectedTier={plan.recommended_tier} onSelectTier={switchTier} />
        </div>
      )}

      <textarea
        className="field w-full p-2.5 text-xs resize-none"
        rows={2}
        placeholder="Optional comment — recorded in the audit trail; used as planner feedback if you ask for changes"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        <button className="btn-success" disabled={disabled} onClick={() => onDecision("accept_plan", comment || null)}>
          ✓ Looks good, finish
        </button>
        <button className="btn-ghost" disabled={disabled} onClick={() => onDecision("reject", comment || null)}>
          ↻ Refine with comment
        </button>
      </div>
      <p className="text-xs text-slate-500">
        "Refine with comment" re-runs the planner with your feedback — refine as many times as you like.
        "Looks good, finish" closes this run out with a report; it never deploys anything.
      </p>
    </div>
  );
}
