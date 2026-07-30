import type { CapacityPlan, CostBasis, Tier } from "@ops-master/shared";

const TIER_LABEL: Record<Tier, string> = {
  economy: "Economy",
  balanced: "Balanced",
  high_availability: "High Availability",
};

/** Provenance labels so users don't mistake either kind of number for a live cloud billing quote. */
const COST_BASIS_LABEL: Record<CostBasis, string> = {
  rate_table: "Estimate — computed from a local rate table, not live cloud pricing",
  llm_estimate: "Estimate — model-computed, not verified against a rate table",
};

export function CapacityPlanView({
  plan,
  selectedTier,
  onSelectTier,
}: {
  plan: CapacityPlan;
  /** Which tier's detail table to show below the comparison row. Defaults to plan.recommended_tier. */
  selectedTier?: Tier;
  /** When provided, tier cards become clickable ("switch to this tier"). Omit for read-only historic views. */
  onSelectTier?: (tier: Tier) => void;
}) {
  const active = selectedTier ?? plan.recommended_tier;
  const activeOption = plan.options.find((o) => o.tier === active) ?? plan.options[0];

  return (
    <div className="space-y-3">
      <div className={`grid gap-2 ${plan.options.length === 2 ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-3"}`}>
        {plan.options.map((opt) => {
          const isActive = opt.tier === active;
          const isRecommended = opt.tier === plan.recommended_tier;
          const clickable = Boolean(onSelectTier);
          return (
            <button
              key={opt.tier}
              type="button"
              disabled={!clickable}
              onClick={() => onSelectTier?.(opt.tier)}
              className={`text-left rounded-lg border p-3 transition-colors duration-150 ${
                isActive
                  ? "border-indigo-500/70 bg-indigo-950/30 shadow-md shadow-indigo-950/30"
                  : "border-slate-800/60 bg-slate-900/40"
              } ${clickable && !isActive ? "hover:border-slate-700 hover:bg-slate-800/50 cursor-pointer" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-100 text-sm">{TIER_LABEL[opt.tier]}</span>
                {isRecommended && (
                  <span className="status-badge border-indigo-700/70 bg-indigo-950/50 text-indigo-300 px-1.5 py-0.5 text-[10px] leading-none">
                    recommended
                  </span>
                )}
              </div>
              <div className="text-xl font-bold text-slate-100 mt-1" title={COST_BASIS_LABEL[opt.cost_basis]}>
                ${opt.estimated_cost_usd_monthly}
                <span className="text-xs font-normal text-slate-400">/mo est.</span>
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">{COST_BASIS_LABEL[opt.cost_basis]}</div>
              <div className="text-xs text-slate-400 mt-1">{opt.availability_notes}</div>
              {opt.headroom_pct > 0 && (
                <div className="text-xs text-slate-500 mt-0.5">{Math.round(opt.headroom_pct * 100)}% burst headroom</div>
              )}
              {!opt.feasible && <div className="text-xs text-rose-400 mt-1">infeasible: {opt.infeasibility_reason}</div>}
            </button>
          );
        })}
      </div>

      {activeOption && (
        <div className="space-y-3">
          <p className="text-sm text-slate-300 leading-relaxed">{activeOption.reasoning}</p>

          <div className="rounded-lg border border-slate-800/60 bg-slate-900/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-slate-300">Cost breakdown</span>
              <span className="text-[10px] text-slate-500">{COST_BASIS_LABEL[activeOption.cost_basis]}</span>
            </div>
            {activeOption.cost_breakdown.length > 0 ? (
              <table className="w-full text-xs mt-2 border-collapse">
                <tbody>
                  {activeOption.cost_breakdown.map((item) => (
                    <tr key={item.label} className="border-b border-slate-900 last:border-0">
                      <td className="py-1 pr-4 text-slate-400">{item.label}</td>
                      <td className="py-1 text-right text-slate-200 tabular-nums">${item.usd_monthly}/mo</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="py-1 pr-4 font-semibold text-slate-100">Total</td>
                    <td className="py-1 text-right font-semibold text-slate-100 tabular-nums">
                      ${activeOption.estimated_cost_usd_monthly}/mo
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-slate-500 mt-2">
                No line-item breakdown available — this total was returned as a single figure, not itemized.
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-800">
                  <th className="py-1 pr-4">Service</th>
                  <th className="py-1 pr-4">Image</th>
                  <th className="py-1 pr-4">CPU</th>
                  <th className="py-1 pr-4">Memory</th>
                  <th className="py-1 pr-4">Replicas</th>
                  <th className="py-1 pr-4">Ports</th>
                </tr>
              </thead>
              <tbody>
                {activeOption.services.map((s) => (
                  <tr key={s.name} className="border-b border-slate-900">
                    <td className="py-1 pr-4 text-slate-100">{s.name}</td>
                    <td className="py-1 pr-4 text-slate-400">{s.image}</td>
                    <td className="py-1 pr-4">{s.cpu}</td>
                    <td className="py-1 pr-4">{s.memory}</td>
                    <td className="py-1 pr-4">{s.replicas}</td>
                    <td className="py-1 pr-4">{s.ports.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {activeOption.storage.length > 0 && (
            <div className="text-xs text-slate-400">
              Storage: {activeOption.storage.map((s) => `${s.name} (${s.size}, attached to ${s.attached_to})`).join("; ")}
            </div>
          )}

          {(activeOption.included_components.length > 0 || activeOption.skipped_components.length > 0) && (
            <div className="grid gap-2 sm:grid-cols-2">
              {activeOption.included_components.length > 0 && (
                <div className="rounded-lg border border-slate-800/60 bg-slate-900/40 p-3">
                  <span className="text-xs font-semibold text-slate-300">Included</span>
                  <ul className="mt-2 space-y-1.5">
                    {activeOption.included_components.map((c) => (
                      <li key={c.component} className="text-xs text-slate-400">
                        <span className="text-slate-200">{c.component}</span> — {c.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {activeOption.skipped_components.length > 0 && (
                <div className="rounded-lg border border-slate-800/60 bg-slate-900/40 p-3">
                  <span className="text-xs font-semibold text-slate-300">Skipped</span>
                  <ul className="mt-2 space-y-1.5">
                    {activeOption.skipped_components.map((c) => (
                      <li key={c.component} className="text-xs text-slate-400">
                        <span className="text-slate-200">{c.component}</span> — {c.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {activeOption.task_graph.length > 0 && (
            <div className="rounded-lg border border-slate-800/60 bg-slate-900/40 p-3">
              <span className="text-xs font-semibold text-slate-300">Provisioning steps</span>
              <ol className="mt-2 space-y-1">
                {activeOption.task_graph.map((t) => (
                  <li key={t.step} className="text-xs text-slate-400">
                    <span className="text-slate-500">{t.step}.</span> {t.task}{" "}
                    <span className="text-slate-600">({t.component})</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {(activeOption.manual_estimate_person_days > 0 || activeOption.agent_estimate_minutes > 0) && (
            <div className="text-xs text-slate-400">
              ~{activeOption.manual_estimate_person_days} person-day(s) manually vs. ~{activeOption.agent_estimate_minutes}{" "}
              min with this pipeline.
            </div>
          )}

          {activeOption.scaling_strategy && (
            <div className="text-xs text-slate-400">
              Scaling: {activeOption.scaling_strategy.min_replicas}–{activeOption.scaling_strategy.max_replicas} replicas —{" "}
              {activeOption.scaling_strategy.trigger_description}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
