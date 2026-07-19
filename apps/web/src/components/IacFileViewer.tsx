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
              className={`text-xs px-2 py-1 rounded ${
                idx === active ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {f.path}
            </button>
          ))}
        </div>
        {diffFrom && (
          <button
            onClick={() => setShowDiff((v) => !v)}
            className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
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
