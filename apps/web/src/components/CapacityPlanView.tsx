import type { CapacityPlan } from "@ops-master/shared";

export function CapacityPlanView({ plan }: { plan: CapacityPlan }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-300 leading-relaxed">{plan.reasoning}</p>
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
            {plan.services.map((s) => (
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
      {plan.storage.length > 0 && (
        <div className="text-xs text-slate-400">
          Storage: {plan.storage.map((s) => `${s.name} (${s.size}, attached to ${s.attached_to})`).join("; ")}
        </div>
      )}
    </div>
  );
}
