import type { CapacityPlan, EnvironmentRecord, IaCFile, TemplateId } from "@ops-master/shared";

export interface EnvSnapshot {
  template_id: TemplateId;
  capacity_plan: CapacityPlan;
  files: IaCFile[];
  endpoints: string[];
}

/** Serialized into environments.files_json / endpoints_json so a future `modify` has everything needed to merge + diff. */
export function encodeSnapshot(
  snap: { template_id: TemplateId; capacity_plan: CapacityPlan; files: IaCFile[] },
  endpoints: string[]
): { files_json: string; endpoints_json: string } {
  return {
    files_json: JSON.stringify({
      template_id: snap.template_id,
      capacity_plan: snap.capacity_plan,
      files: snap.files,
    }),
    endpoints_json: JSON.stringify(endpoints),
  };
}

export function decodeSnapshot(env: EnvironmentRecord): EnvSnapshot {
  const parsed = JSON.parse(env.files_json) as Omit<EnvSnapshot, "endpoints">;
  const endpoints = JSON.parse(env.endpoints_json) as string[];
  return { ...parsed, endpoints };
}
