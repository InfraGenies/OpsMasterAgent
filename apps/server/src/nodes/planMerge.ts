import type { CapacityPlan } from "@ops-master/shared";

/**
 * For operation=modify, 02-planner.md has the LLM plan ONLY the delta
 * (never touching volumes holding existing data). This merges that delta
 * onto the previous environment's plan so downstream nodes (IaC generator,
 * approval gate, deploy) always see one complete, contract-shaped
 * CapacityPlan representing the full target state.
 */
export function mergeCapacityPlan(existing: CapacityPlan, delta: CapacityPlan): CapacityPlan {
  const services = [...existing.services];
  for (const s of delta.services) {
    const idx = services.findIndex((e) => e.name === s.name);
    if (idx >= 0) services[idx] = s;
    else services.push(s);
  }

  const storage = [...existing.storage];
  for (const s of delta.storage) {
    if (!storage.some((e) => e.name === s.name)) storage.push(s);
  }

  const expose = [...existing.network.expose];
  for (const e of delta.network.expose) {
    if (!expose.some((x) => x.service === e.service)) expose.push(e);
  }
  const internal = Array.from(new Set([...existing.network.internal, ...delta.network.internal]));

  return {
    request_id: delta.request_id,
    services,
    storage,
    network: { expose, internal },
    reasoning: `${delta.reasoning} (Merged onto ${existing.services.length} existing service(s) already running; their data volumes are untouched.)`,
    feasible: delta.feasible,
    infeasibility_reason: delta.infeasibility_reason,
  };
}

function parseMemoryMi(mem: string): number {
  const match = mem.match(/^(\d+(?:\.\d+)?)\s*(Mi|Gi)$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2].toLowerCase() === "gi" ? value * 1024 : value;
}

/**
 * Backend-side safety net on top of the LLM's own feasibility call (defense
 * in depth — the graph decides routing, not the model). Can only flip
 * feasible true->false, never the reverse.
 */
export function checkSandboxLimits(
  plan: CapacityPlan,
  maxMemoryGb: number
): { feasible: boolean; reason: string | null } {
  const totalMemMi = plan.services.reduce((sum, s) => sum + parseMemoryMi(s.memory) * s.replicas, 0);
  const totalReplicas = plan.services.reduce((sum, s) => sum + s.replicas, 0);

  if (totalMemMi > maxMemoryGb * 1024) {
    return {
      feasible: false,
      reason: `total planned memory ${(totalMemMi / 1024).toFixed(2)}Gi exceeds sandbox limit ${maxMemoryGb}Gi`,
    };
  }
  if (totalReplicas > 8) {
    return { feasible: false, reason: `total planned replicas ${totalReplicas} exceeds sandbox limit of 8` };
  }
  return { feasible: true, reason: null };
}
