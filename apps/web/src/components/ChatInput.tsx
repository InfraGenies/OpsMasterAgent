import { useState } from "react";
import { USE_CASES } from "../useCases";

export function ChatInput({ onSubmit, disabled }: { onSubmit: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState("");

  function submit() {
    if (!text.trim() || disabled) return;
    onSubmit(text.trim());
    setText("");
  }

  return (
    <div className="card p-4 space-y-3">
      <textarea
        className="field w-full p-3.5 text-base resize-none"
        rows={5}
        placeholder="Describe the infrastructure you need, or pick an example below."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      <div className="flex flex-wrap gap-2">
        {USE_CASES.map((uc) => (
          <button
            key={uc.id}
            className="chip inline-flex items-center gap-1.5"
            onClick={() => setText(uc.text)}
            type="button"
            title={uc.status === "roadmap" ? `${uc.text}\n\n(roadmap — planner will show its reasoning even though full support isn't shipped yet)` : uc.text}
          >
            {uc.label}
            {uc.status === "roadmap" && (
              <span className="status-badge border-amber-700/70 bg-amber-950/50 text-amber-300 px-1.5 py-0.5 text-[10px] leading-none">
                roadmap
              </span>
            )}
          </button>
        ))}
      </div>
      <button className="btn-primary w-full text-base py-2.5" onClick={submit} disabled={disabled || !text.trim()}>
        {disabled ? "Submitting…" : "Submit request"}
        <span className="text-indigo-200 text-sm font-normal">Ctrl+↵</span>
      </button>
    </div>
  );
}
