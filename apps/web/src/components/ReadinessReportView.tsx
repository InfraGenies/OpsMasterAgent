import type { ReadinessCheckResult, ReadinessReport } from "@ops-master/shared";

const STATUS_STYLES: Record<ReadinessCheckResult["status"], string> = {
  pass: "border-emerald-700 text-emerald-300 bg-emerald-950/60",
  fail: "border-rose-700 text-rose-300 bg-rose-950/60",
  skipped: "border-slate-700 text-slate-400 bg-slate-900/60",
};

export function ReadinessReportView({ report }: { report: ReadinessReport }) {
  return (
    <div
      className={`rounded-lg p-4 border space-y-3 ${
        report.ready ? "border-emerald-800 bg-emerald-950/20" : "border-rose-800 bg-rose-950/20"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-sm font-semibold ${report.ready ? "text-emerald-400" : "text-rose-400"}`}>
          {report.ready ? "✅ READY" : "⛔ NOT READY"}
        </span>
      </div>

      <table className="w-full text-xs">
        <tbody>
          {report.checks.map((c) => (
            <tr key={c.name} className="border-b border-slate-900 align-top">
              <td className="py-1.5 pr-3">
                <span className={`status-badge ${STATUS_STYLES[c.status]}`}>{c.status}</span>
              </td>
              <td className="py-1.5 text-slate-300">
                <span className="font-mono text-slate-500">{c.name}</span>
                <div>{c.detail}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
