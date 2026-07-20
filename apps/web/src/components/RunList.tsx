import type { Run } from "@ops-master/shared";

const STATUS_STYLE: Record<Run["status"], { badge: string; dot: string; label: string }> = {
  running: { badge: "border-sky-800 bg-sky-950/60 text-sky-300", dot: "bg-sky-400 animate-pulse", label: "running" },
  awaiting_approval: {
    badge: "border-amber-700 bg-amber-950/60 text-amber-300",
    dot: "bg-amber-400 animate-pulse",
    label: "needs approval",
  },
  deployed: { badge: "border-emerald-800 bg-emerald-950/60 text-emerald-300", dot: "bg-emerald-400", label: "deployed" },
  failed: { badge: "border-rose-800 bg-rose-950/60 text-rose-300", dot: "bg-rose-400", label: "failed" },
  rolled_back: { badge: "border-orange-800 bg-orange-950/60 text-orange-300", dot: "bg-orange-400", label: "rolled back" },
  refused: { badge: "border-slate-700 bg-slate-900 text-slate-400", dot: "bg-slate-500", label: "refused" },
};

export function StatusBadge({ status }: { status: Run["status"] }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`status-badge ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function RunList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: Run[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (!runs.length) {
    return <p className="text-sm text-slate-400 px-2">No runs yet — submit a request above.</p>;
  }
  return (
    <ul className="space-y-2">
      {runs.map((run) => (
        <li key={run.request_id}>
          <button
            onClick={() => onSelect(run.request_id)}
            className={`w-full text-left px-3.5 py-3 rounded-lg text-sm border transition-colors duration-150 ${
              selectedId === run.request_id
                ? "border-indigo-500/70 bg-indigo-950/30 shadow-md shadow-indigo-950/30"
                : "border-slate-800/60 bg-slate-900/40 hover:bg-slate-800/60 hover:border-slate-700"
            }`}
          >
            <div className="truncate text-slate-200 font-medium">{run.raw_text}</div>
            <div className="flex items-center justify-between mt-2 gap-2">
              <span className="text-slate-400 font-mono text-xs truncate">{run.request_id}</span>
              <StatusBadge status={run.status} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
