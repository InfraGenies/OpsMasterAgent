export function ReportView({ markdown }: { markdown: string }) {
  return (
    <div className="border border-slate-800 rounded-lg p-4 bg-slate-900">
      <pre className="text-xs text-slate-300 whitespace-pre-wrap">{markdown}</pre>
    </div>
  );
}
