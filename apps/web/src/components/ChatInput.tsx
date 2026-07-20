import { useState } from "react";

const EXAMPLES: { label: string; text: string }[] = [
  { label: "Dev todo app", text: "Spin up a dev environment for a simple Node.js todo app, low traffic, single instance." },
  {
    label: "Staging @ 500 rps",
    text: "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second.",
  },
  { label: "Add Redis (modify)", text: "Add a Redis cache to the staging environment we just created and wire the app to it." },
  { label: "LB, 3 replicas", text: "I need a load-balanced Node.js web tier with Redis, 3 replicas behind Nginx, for performance testing." },
  { label: "Refusal (50k rps)", text: "Provision production with 50,000 req/s and five-nines availability." },
  {
    label: "Rollback demo",
    text: "Create a staging environment for a Node.js application with PostgreSQL, 100 requests/second, demo-fail: use the wrong db password.",
  },
];

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
        placeholder='Describe the infrastructure you need, e.g. "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second."'
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      <div className="flex flex-wrap gap-2">
        {EXAMPLES.map((ex) => (
          <button key={ex.label} className="chip" onClick={() => setText(ex.text)} type="button" title={ex.text}>
            {ex.label}
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
