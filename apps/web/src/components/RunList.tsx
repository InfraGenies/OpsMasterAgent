import type { Run } from "@ops-master/shared";

const STATUS_COLOR: Record<Run["status"], string> = {
  running: "text-blue-400",
  awaiting_approval: "text-amber-400",
  deployed: "text-emerald-400",
  failed: "text-red-400",
  rolled_back: "text-orange-400",
  refused: "text-slate-500",
};

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
    return <p className="text-xs text-slate-500 px-2">No runs yet — submit a request above.</p>;
  }
  return (
    <ul className="space-y-1">
      {runs.map((run) => (
        <li key={run.request_id}>
          <button
            onClick={() => onSelect(run.request_id)}
            className={`w-full text-left px-2 py-2 rounded-md text-xs border ${
              selectedId === run.request_id ? "border-indigo-600 bg-slate-900" : "border-transparent hover:bg-slate-900"
            }`}
          >
            <div className="truncate text-slate-200">{run.raw_text}</div>
            <div className="flex justify-between mt-0.5">
              <span className="text-slate-500">{run.request_id}</span>
              <span className={STATUS_COLOR[run.status]}>{run.status}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
