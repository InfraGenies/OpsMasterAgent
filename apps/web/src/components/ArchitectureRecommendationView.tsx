import type { ArchitectureRecommendation, CriticalityBand, ManagedControl } from "@ops-master/shared";

const BAND_STYLES: Record<CriticalityBand, string> = {
  low: "border-slate-700 text-slate-300 bg-slate-900/60",
  medium: "border-amber-600 text-amber-300 bg-amber-950/60",
  high: "border-orange-600 text-orange-300 bg-orange-950/60",
  very_high: "border-rose-700 text-rose-300 bg-rose-950/60",
};

const CATEGORY_LABEL: Record<ManagedControl["category"], string> = {
  network: "Network",
  identity: "Identity",
  detection: "Detection",
  data_protection: "Data Protection",
  dr_ha: "DR / HA",
  compliance: "Compliance",
  cost_governance: "Cost Governance",
};

export function ArchitectureRecommendationView({ rec }: { rec: ArchitectureRecommendation }) {
  return (
    <div className="rounded-lg p-4 border border-slate-800/60 bg-slate-900/40 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-slate-100 capitalize">{rec.archetype.replace(/_/g, " ")}</span>
        <span className={`status-badge ${BAND_STYLES[rec.criticality_band]}`}>
          {rec.criticality_band.replace("_", " ")} criticality ({rec.criticality_score}/14)
        </span>
        {rec.compliance_overlay
          .filter((c) => c !== "none")
          .map((c) => (
            <span
              key={c}
              className="text-xs px-2 py-0.5 rounded-full border border-indigo-700/70 text-indigo-300 bg-indigo-950/50 uppercase"
            >
              {c.replace("_", "-")}
            </span>
          ))}
      </div>

      <p className="text-sm text-slate-300 leading-relaxed">{rec.archetype_reasoning}</p>
      <p className="text-sm text-slate-300 leading-relaxed">{rec.criticality_reasoning}</p>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-800">
              <th className="py-1 pr-4">Managed control</th>
              <th className="py-1 pr-4">Category</th>
              <th className="py-1 pr-4">Why</th>
              <th className="py-1 pr-4">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rec.managed_controls.map((c) => (
              <tr key={c.name} className="border-b border-slate-900 align-top">
                <td className="py-1.5 pr-4 text-slate-100 whitespace-nowrap">{c.name}</td>
                <td className="py-1.5 pr-4 text-slate-400 whitespace-nowrap">{CATEGORY_LABEL[c.category]}</td>
                <td className="py-1.5 pr-4 text-slate-400">{c.reasoning}</td>
                <td className="py-1.5 pr-4 text-slate-200 tabular-nums whitespace-nowrap">
                  ${c.estimated_cost_usd_monthly}/mo
                </td>
              </tr>
            ))}
          </tbody>
          {rec.managed_controls.length > 0 && (
            <tfoot>
              <tr>
                <td className="py-1.5 pr-4 font-semibold text-slate-100" colSpan={3}>
                  Total managed-controls cost
                </td>
                <td className="py-1.5 pr-4 font-semibold text-slate-100 tabular-nums whitespace-nowrap">
                  ${rec.total_controls_cost_usd_monthly}/mo
                </td>
              </tr>
            </tfoot>
          )}
        </table>
        {rec.managed_controls.length === 0 && (
          <p className="text-xs text-slate-500 mt-2">
            No additional managed controls required at this criticality/org-scale combination.
          </p>
        )}
      </div>
    </div>
  );
}
