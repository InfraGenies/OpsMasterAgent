import type { VerifyReport } from "@ops-master/shared";

export function VerifyReportView({ report }: { report: VerifyReport }) {
  const green = report.verdict === "green";
  return (
    <div
      className={`rounded-lg p-4 border space-y-3 ${
        green ? "border-emerald-800 bg-emerald-950/20" : "border-red-800 bg-red-950/20"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`text-sm font-semibold ${green ? "text-emerald-400" : "text-red-400"}`}>
          {green ? "✅ GREEN" : "❌ RED"}
        </span>
        {report.rolled_back && (
          <span className="text-xs px-2 py-0.5 rounded-full border border-orange-700 text-orange-300 bg-orange-950">
            rolled back
          </span>
        )}
      </div>
      <p className="text-sm text-slate-300">{report.summary}</p>

      <table className="w-full text-xs">
        <tbody>
          {report.checks.map((c) => (
            <tr key={c.name} className="border-b border-slate-900">
              <td className="py-1 pr-4">{c.status === "pass" ? "✅" : "❌"}</td>
              <td className="py-1 pr-4 text-slate-300">{c.name}</td>
              <td className="py-1 text-slate-500">{c.latency_ms}ms</td>
            </tr>
          ))}
        </tbody>
      </table>

      {report.smoke_test && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div className="bg-slate-900 rounded p-2">
            <div className="text-slate-500">tool</div>
            <div className="text-slate-200">{report.smoke_test.tool}</div>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <div className="text-slate-500">target / achieved rps</div>
            <div className="text-slate-200">
              {report.smoke_test.target_rps} / {report.smoke_test.achieved_rps}
            </div>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <div className="text-slate-500">p95</div>
            <div className="text-slate-200">{report.smoke_test.p95_ms}ms</div>
          </div>
          <div className="bg-slate-900 rounded p-2">
            <div className="text-slate-500">error rate</div>
            <div className="text-slate-200">{(report.smoke_test.error_rate * 100).toFixed(2)}%</div>
          </div>
        </div>
      )}

      {report.endpoints.length > 0 && (
        <div className="text-xs text-slate-400">
          Endpoints:{" "}
          {report.endpoints.map((e) => (
            <a key={e} href={e} target="_blank" rel="noreferrer" className="text-indigo-400 underline mr-2">
              {e}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
