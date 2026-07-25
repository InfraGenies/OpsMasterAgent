import type {
  AuditEvent,
  Decision,
  EnvironmentRecord,
  Run,
  RunStatus,
} from "@ops-master/shared";

/**
 * Persistence boundary for runs / audit / environments / decisions.
 * Two implementations: SupabaseStore (real) and LocalJsonStore (offline dev
 * fallback, see store/localStore.ts). Nothing above this interface should
 * know or care which one is active.
 */
export interface AuditStore {
  createRun(run: Run): Promise<void>;
  updateRunStatus(requestId: string, status: RunStatus, finishedAt?: string | null): Promise<void>;
  getRun(requestId: string): Promise<Run | null>;
  listRuns(): Promise<Run[]>;

  writeAuditEvent(event: AuditEvent): Promise<void>;
  listAuditEvents(requestId: string): Promise<AuditEvent[]>;

  writeDecision(decision: Decision): Promise<void>;
  getDecision(requestId: string): Promise<Decision | null>;

  upsertEnvironment(env: EnvironmentRecord): Promise<void>;
  getEnvironment(envId: string): Promise<EnvironmentRecord | null>;
  listEnvironments(): Promise<EnvironmentRecord[]>;
}
