import { createHash } from "node:crypto";
import type { NodeName } from "@ops-master/shared";
import type { AuditStore } from "../store/types.js";

function digest(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/**
 * Every node's audit write goes through here — 00-orchestrator.md: "no node
 * is trusted to log itself" is honoured by always calling this at the same
 * call sites rather than leaving it to each node implementation.
 */
export async function logAudit(
  store: AuditStore,
  args: {
    request_id: string;
    node: NodeName;
    actor: "agent" | "human";
    status: "success" | "failure" | "pending";
    detail: string;
    input?: unknown;
    output?: unknown;
    command_executed?: string | null;
  }
): Promise<void> {
  await store.writeAuditEvent({
    request_id: args.request_id,
    ts: new Date().toISOString(),
    node: args.node,
    actor: args.actor,
    input_digest: digest(args.input),
    output_digest: digest(args.output),
    input_json: args.input !== undefined ? JSON.stringify(args.input) : null,
    output_json: args.output !== undefined ? JSON.stringify(args.output) : null,
    command_executed: args.command_executed ?? null,
    status: args.status,
    detail: args.detail,
  });
}

/** Rehydrates a node's last output from the audit trail — the mechanism that makes approval-gate resume-after-restart work with no in-memory state at all. */
export async function loadLatestNodeOutput<T>(
  store: AuditStore,
  requestId: string,
  node: NodeName
): Promise<T | null> {
  const events = await store.listAuditEvents(requestId);
  const matches = events.filter((e) => e.node === node && e.output_json);
  if (!matches.length) return null;
  return JSON.parse(matches[matches.length - 1].output_json!) as T;
}
