import { useState } from "react";

const EXAMPLES = [
  "Spin up a dev environment for a simple Node.js todo app, low traffic, single instance.",
  "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second.",
  "Add a Redis cache to the staging environment we just created and wire the app to it.",
  "Provision production with 50,000 req/s and five-nines availability.",
];

export function ChatInput({ onSubmit, disabled }: { onSubmit: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState("");

  function submit() {
    if (!text.trim() || disabled) return;
    onSubmit(text.trim());
    setText("");
  }

  return (
    <div className="border border-slate-800 rounded-lg p-3 bg-slate-900">
      <textarea
        className="w-full bg-slate-950 border border-slate-800 rounded-md p-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-indigo-500"
        rows={3}
        placeholder='Describe the infrastructure you need, e.g. "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second."'
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      <div className="flex items-center justify-between mt-2">
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className="text-[11px] px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-400"
              onClick={() => setText(ex)}
              type="button"
            >
              {ex.slice(0, 28)}…
            </button>
          ))}
        </div>
        <button
          className="px-4 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-sm font-medium"
          onClick={submit}
          disabled={disabled || !text.trim()}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
