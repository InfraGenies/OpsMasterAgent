import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AuditEvent,
  Decision,
  EnvironmentRecord,
  Run,
  RunStatus,
} from "@ops-master/shared";
import type { AuditStore } from "./types.js";

interface LocalData {
  runs: Run[];
  audit_events: AuditEvent[];
  decisions: Decision[];
  environments: EnvironmentRecord[];
  next_event_id: number;
}

const EMPTY: LocalData = { runs: [], audit_events: [], decisions: [], environments: [], next_event_id: 1 };

/**
 * Dev-only fallback so the pipeline is runnable/smoke-testable without a
 * live Supabase project. Not concurrency-safe, not for the real demo —
 * swap SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in and the server picks
 * SupabaseStore automatically (see store/index.ts).
 */
export class LocalJsonStore implements AuditStore {
  private path: string;
  private data: LocalData;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      this.data = JSON.parse(readFileSync(path, "utf-8"));
    } else {
      mkdirSync(dirname(path), { recursive: true });
      this.data = { ...EMPTY };
      this.persist();
    }
  }

  private persist() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), "utf-8");
  }

  async createRun(run: Run): Promise<void> {
    this.data.runs.push(run);
    this.persist();
  }

  async updateRunStatus(requestId: string, status: RunStatus, finishedAt?: string | null): Promise<void> {
    const run = this.data.runs.find((r) => r.request_id === requestId);
    if (run) {
      run.status = status;
      if (finishedAt !== undefined) run.finished_at = finishedAt;
      this.persist();
    }
  }

  async getRun(requestId: string): Promise<Run | null> {
    return this.data.runs.find((r) => r.request_id === requestId) ?? null;
  }

  async listRuns(): Promise<Run[]> {
    return [...this.data.runs].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  async writeAuditEvent(event: AuditEvent): Promise<void> {
    this.data.audit_events.push({ ...event, event_id: this.data.next_event_id++ });
    this.persist();
  }

  async listAuditEvents(requestId: string): Promise<AuditEvent[]> {
    return this.data.audit_events.filter((e) => e.request_id === requestId);
  }

  async writeDecision(decision: Decision): Promise<void> {
    this.data.decisions.push(decision);
    this.persist();
  }

  async getDecision(requestId: string): Promise<Decision | null> {
    const matches = this.data.decisions.filter((d) => d.request_id === requestId);
    return matches.length ? matches[matches.length - 1] : null;
  }

  async upsertEnvironment(env: EnvironmentRecord): Promise<void> {
    const idx = this.data.environments.findIndex((e) => e.env_id === env.env_id);
    if (idx >= 0) this.data.environments[idx] = env;
    else this.data.environments.push(env);
    this.persist();
  }

  async getEnvironment(envId: string): Promise<EnvironmentRecord | null> {
    return this.data.environments.find((e) => e.env_id === envId) ?? null;
  }

  async listEnvironments(): Promise<EnvironmentRecord[]> {
    return [...this.data.environments];
  }
}
