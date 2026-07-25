import type { PolicyFinding, PolicyReport } from "@ops-master/shared";

const SEVERITY_STYLES: Record<PolicyFinding["severity"], string> = {
  critical: "border-rose-700 text-rose-300 bg-rose-950/60",
  high: "border-rose-700 text-rose-300 bg-rose-950/60",
  medium: "border-amber-600 text-amber-300 bg-amber-950/60",
  low: "border-slate-700 text-slate-400 bg-slate-900/60",
};

export function PolicyReportView({ report }: { report: PolicyReport }) {
  return (
    <div
      className={`rounded-lg p-4 border space-y-3 ${
        report.passed ? "border-emerald-800 bg-emerald-950/20" : "border-rose-800 bg-rose-950/20"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-sm font-semibold ${report.passed ? "text-emerald-400" : "text-rose-400"}`}>
          {report.passed ? "✅ PASSED" : "⚠️ FINDINGS REMAIN"}
        </span>
        <span className="text-xs px-2 py-0.5 rounded-full border border-slate-700 text-slate-400 bg-slate-900">
          {report.attempts} attempt{report.attempts > 1 ? "s" : ""}
        </span>
      </div>

      {report.findings.length === 0 ? (
        <p className="text-sm text-slate-400">No policy or security findings.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {report.findings.map((f, i) => (
              <tr key={`${f.rule_id}-${i}`} className="border-b border-slate-900 align-top">
                <td className="py-1.5 pr-3">
                  <span className={`status-badge ${SEVERITY_STYLES[f.severity]}`}>{f.severity}</span>
                </td>
                <td className="py-1.5 pr-3 text-slate-300">
                  <span className="font-mono text-slate-500">{f.rule_id}</span>
                  <div>{f.message}</div>
                </td>
                <td className="py-1.5 text-slate-500 font-mono">{f.file ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
