import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AuditEvent,
  Decision,
  EnvironmentRecord,
  Run,
  RunStatus,
} from "@ops-master/shared";
import type { AuditStore } from "./types.js";

export class SupabaseStore implements AuditStore {
  private client: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  async createRun(run: Run): Promise<void> {
    const { error } = await this.client.from("runs").insert({
      request_id: run.request_id,
      raw_text: run.raw_text,
      operation: run.operation,
      status: run.status,
      created_at: run.created_at,
      finished_at: run.finished_at,
    });
    if (error) throw new Error(`SupabaseStore.createRun: ${error.message}`);
  }

  async updateRunStatus(requestId: string, status: RunStatus, finishedAt?: string | null): Promise<void> {
    const { error } = await this.client
      .from("runs")
      .update({ status, ...(finishedAt !== undefined ? { finished_at: finishedAt } : {}) })
      .eq("request_id", requestId);
    if (error) throw new Error(`SupabaseStore.updateRunStatus: ${error.message}`);
  }

  async getRun(requestId: string): Promise<Run | null> {
    const { data, error } = await this.client
      .from("runs")
      .select("*")
      .eq("request_id", requestId)
      .maybeSingle();
    if (error) throw new Error(`SupabaseStore.getRun: ${error.message}`);
    return (data as Run) ?? null;
  }

  async listRuns(): Promise<Run[]> {
    const { data, error } = await this.client
      .from("runs")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(`SupabaseStore.listRuns: ${error.message}`);
    return (data as Run[]) ?? [];
  }

  async writeAuditEvent(event: AuditEvent): Promise<void> {
    const { error } = await this.client.from("audit_events").insert({
      request_id: event.request_id,
      ts: event.ts,
      node: event.node,
      actor: event.actor,
      input_digest: event.input_digest,
      output_digest: event.output_digest,
      input_json: event.input_json ?? null,
      output_json: event.output_json ?? null,
      command_executed: event.command_executed,
      status: event.status,
      detail: event.detail,
    });
    if (error) throw new Error(`SupabaseStore.writeAuditEvent: ${error.message}`);
  }

  async listAuditEvents(requestId: string): Promise<AuditEvent[]> {
    const { data, error } = await this.client
      .from("audit_events")
      .select("*")
      .eq("request_id", requestId)
      .order("event_id", { ascending: true });
    if (error) throw new Error(`SupabaseStore.listAuditEvents: ${error.message}`);
    return (data as AuditEvent[]) ?? [];
  }

  async writeDecision(decision: Decision): Promise<void> {
    const { error } = await this.client.from("decisions").insert({
      request_id: decision.request_id,
      action: decision.action,
      comment: decision.comment,
      actor: decision.actor,
      ts: decision.ts,
    });
    if (error) throw new Error(`SupabaseStore.writeDecision: ${error.message}`);
  }

  async getDecision(requestId: string): Promise<Decision | null> {
    const { data, error } = await this.client
      .from("decisions")
      .select("*")
      .eq("request_id", requestId)
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`SupabaseStore.getDecision: ${error.message}`);
    return (data as Decision) ?? null;
  }

  async upsertEnvironment(env: EnvironmentRecord): Promise<void> {
    const { error } = await this.client.from("environments").upsert({
      env_id: env.env_id,
      request_id: env.request_id,
      name: env.name,
      target: env.target,
      files_json: env.files_json,
      endpoints_json: env.endpoints_json,
      state: env.state,
    });
    if (error) throw new Error(`SupabaseStore.upsertEnvironment: ${error.message}`);
  }

  async getEnvironment(envId: string): Promise<EnvironmentRecord | null> {
    const { data, error } = await this.client
      .from("environments")
      .select("*")
      .eq("env_id", envId)
      .maybeSingle();
    if (error) throw new Error(`SupabaseStore.getEnvironment: ${error.message}`);
    return (data as EnvironmentRecord) ?? null;
  }

  async listEnvironments(): Promise<EnvironmentRecord[]> {
    const { data, error } = await this.client.from("environments").select("*");
    if (error) throw new Error(`SupabaseStore.listEnvironments: ${error.message}`);
    return (data as EnvironmentRecord[]) ?? [];
  }
}
