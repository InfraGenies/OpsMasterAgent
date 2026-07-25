import { useState } from "react";
import type { IaCFile } from "@ops-master/shared";
import { diffLines } from "../lib/diff";

function DiffBlock({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const lines = diffLines(oldContent, newContent);
  return (
    <pre className="text-xs bg-slate-950 rounded-md p-3 overflow-x-auto max-h-96 overflow-y-auto">
      {lines.map((l, idx) => (
        <div
          key={idx}
          className={
            l.type === "add"
              ? "bg-emerald-950 text-emerald-300"
              : l.type === "del"
                ? "bg-red-950 text-red-300"
                : "text-slate-400"
          }
        >
          {l.type === "add" ? "+ " : l.type === "del" ? "- " : "  "}
          {l.text}
        </div>
      ))}
    </pre>
  );
}

export function IacFileViewer({ files, diffFrom }: { files: IaCFile[]; diffFrom: IaCFile[] | null }) {
  const [active, setActive] = useState(0);
  const [showDiff, setShowDiff] = useState(!!diffFrom);
  if (!files.length) return null;
  const file = files[active];
  const previous = diffFrom?.find((f) => f.path === file.path);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex gap-1 flex-wrap">
          {files.map((f, idx) => (
            <button
              key={f.path}
              onClick={() => setActive(idx)}
              className={`text-xs px-2.5 py-1 rounded-md font-mono transition-colors duration-150 border ${
                idx === active
                  ? "bg-indigo-600/90 border-indigo-500 text-white shadow-sm shadow-indigo-950/50"
                  : "bg-slate-800/60 border-slate-700/60 text-slate-400 hover:bg-slate-700/60 hover:text-slate-200"
              }`}
            >
              {f.path}
            </button>
          ))}
        </div>
        {diffFrom && (
          <button onClick={() => setShowDiff((v) => !v)} className="btn-ghost btn-sm">
            {showDiff ? "show full file" : "show diff"}
          </button>
        )}
      </div>
      {showDiff && diffFrom ? (
        <DiffBlock oldContent={previous?.content ?? ""} newContent={file.content} />
      ) : (
        <pre className="text-xs bg-slate-950 rounded-md p-3 overflow-x-auto max-h-96 overflow-y-auto text-slate-300">
          {file.content}
        </pre>
      )}
    </div>
  );
}
