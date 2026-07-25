import { useState } from "react";
import type { AuditEvent } from "@ops-master/shared";

const ACTOR_ICON: Record<AuditEvent["actor"], string> = { agent: "🤖", human: "🧑" };
const STATUS_COLOR: Record<AuditEvent["status"], string> = {
  success: "text-emerald-400",
  failure: "text-red-400",
  pending: "text-amber-400",
};

function EventRow({ event }: { event: AuditEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-l-2 border-slate-800 hover:border-indigo-600/60 pl-3 py-1.5 transition-colors duration-150">
      <button className="w-full text-left rounded-md hover:bg-slate-900/60 px-1.5 py-1 -mx-1.5 transition-colors duration-150" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-center gap-2 text-xs">
          <span>{ACTOR_ICON[event.actor]}</span>
          <span className="font-medium text-slate-200">{event.node}</span>
          <span className={STATUS_COLOR[event.status]}>{event.status}</span>
          <span className="text-slate-600">{new Date(event.ts).toLocaleTimeString()}</span>
        </div>
        <div className="text-xs text-slate-400 mt-0.5">{event.detail}</div>
        {event.command_executed && (
          <code className="text-[11px] text-slate-500 block mt-0.5">$ {event.command_executed}</code>
        )}
      </button>
      {open && (event.input_json || event.output_json) && (
        <div className="mt-1 space-y-1">
          {event.input_json && (
            <details className="text-[11px]">
              <summary className="text-slate-500 cursor-pointer">input</summary>
              <pre className="bg-slate-950 rounded p-2 overflow-x-auto max-h-64 overflow-y-auto">{event.input_json}</pre>
            </details>
          )}
          {event.output_json && (
            <details className="text-[11px]">
              <summary className="text-slate-500 cursor-pointer">output</summary>
              <pre className="bg-slate-950 rounded p-2 overflow-x-auto max-h-64 overflow-y-auto">{event.output_json}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

export function AuditTimeline({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <p className="text-xs text-slate-500">No audit events yet.</p>;
  return <ul className="space-y-0.5">{events.map((e) => <EventRow key={e.event_id} event={e} />)}</ul>;
}
