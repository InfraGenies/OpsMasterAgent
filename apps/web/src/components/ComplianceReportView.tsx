import type { ComplianceControlFinding, ComplianceReport } from "@ops-master/shared";

const STATUS_STYLES: Record<ComplianceControlFinding["status"], string> = {
  satisfied: "border-emerald-700 text-emerald-300 bg-emerald-950/60",
  gap: "border-rose-700 text-rose-300 bg-rose-950/60",
  not_applicable: "border-slate-700 text-slate-400 bg-slate-900/60",
};

export function ComplianceReportView({ report }: { report: ComplianceReport }) {
  return (
    <div
      className={`rounded-lg p-4 border space-y-3 ${
        report.passed ? "border-emerald-800 bg-emerald-950/20" : "border-rose-800 bg-rose-950/20"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-sm font-semibold ${report.passed ? "text-emerald-400" : "text-rose-400"}`}>
          {report.passed ? "✅ PASSED" : "⚠️ GAPS REMAIN"}
        </span>
        {report.frameworks.map((f) => (
          <span
            key={f}
            className="text-xs px-2 py-0.5 rounded-full border border-slate-700 text-slate-400 bg-slate-900 uppercase"
          >
            {f.replace("_", "-")}
          </span>
        ))}
        {report.gap_count > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full border border-rose-700 text-rose-300 bg-rose-950/60">
            {report.gap_count} gap{report.gap_count > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {report.findings.length === 0 ? (
        <p className="text-sm text-slate-400">No compliance frameworks requested for this architecture.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {report.findings.map((f, i) => (
              <tr key={`${f.control_id}-${i}`} className="border-b border-slate-900 align-top">
                <td className="py-1.5 pr-3">
                  <span className={`status-badge ${STATUS_STYLES[f.status]}`}>{f.status}</span>
                </td>
                <td className="py-1.5 pr-3 text-slate-300">
                  <span className="font-mono text-slate-500">{f.control_id}</span>
                  <div>{f.message}</div>
                </td>
                <td className="py-1.5 text-slate-500 font-mono">{f.satisfied_by ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
