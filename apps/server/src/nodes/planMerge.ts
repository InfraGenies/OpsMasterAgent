import type { CapacityPlan, CapacityPlanOption } from "@ops-master/shared";

/**
 * For operation=modify, 02-planner.md has the LLM plan ONLY the delta
 * (never touching volumes holding existing data). This merges that delta
 * onto the previous environment's plan so downstream nodes (IaC generator,
 * approval gate, deploy) always see one complete, contract-shaped
 * CapacityPlanOption representing the full target state for that tier.
 */
export function mergeCapacityPlanOption(existing: CapacityPlanOption, delta: CapacityPlanOption): CapacityPlanOption {
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
    ...delta,
    services,
    storage,
    network: { expose, internal },
    reasoning: `${delta.reasoning} (Merged onto ${existing.services.length} existing service(s) already running; their data volumes are untouched.)`,
  };
}

/** Merges each tier of a delta plan onto the matching tier of the existing plan (falling back to the existing recommended tier if a delta tier is new). */
export function mergeCapacityPlan(existing: CapacityPlan, delta: CapacityPlan): CapacityPlan {
  const existingRecommended = existing.options.find((o) => o.tier === existing.recommended_tier) ?? existing.options[0];
  const options = delta.options.map((deltaOpt) => {
    const existingOpt = existing.options.find((o) => o.tier === deltaOpt.tier) ?? existingRecommended;
    return mergeCapacityPlanOption(existingOpt, deltaOpt);
  });

  return {
    request_id: delta.request_id,
    options,
    recommended_tier: delta.recommended_tier,
    feasible: delta.feasible,
    infeasibility_reason: delta.infeasibility_reason,
    // Object literal, not a spread, so a reject/edit rework on an
    // enterprise-mode run doesn't silently drop this — the rework's own
    // planner call recomputes it fresh, but fall back to the existing plan's
    // in case a delta ever arrives without one.
    architecture_recommendation: delta.architecture_recommendation ?? existing.architecture_recommendation,
  };
}

export function parseMemoryMi(mem: string): number {
  const match = mem.match(/^(\d+(?:\.\d+)?)\s*(Mi|Gi)$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2].toLowerCase() === "gi" ? value * 1024 : value;
}

/**
 * Backend-side safety net on top of the LLM's own feasibility call (defense
 * in depth — the graph decides routing, not the model). Evaluated per tier:
 * a tier that blows the sandbox cap is dropped from `options` rather than
 * failing the whole plan, unless every tier is dropped.
 */
function tierFitsSandbox(option: CapacityPlanOption, maxMemoryGb: number): { fits: boolean; reason: string | null } {
  const totalMemMi = option.services.reduce((sum, s) => sum + parseMemoryMi(s.memory) * s.replicas, 0);
  const totalReplicas = option.services.reduce((sum, s) => sum + s.replicas, 0);

  if (totalMemMi > maxMemoryGb * 1024) {
    return {
      fits: false,
      reason: `total planned memory ${(totalMemMi / 1024).toFixed(2)}Gi exceeds sandbox limit ${maxMemoryGb}Gi`,
    };
  }
  if (totalReplicas > 8) {
    return { fits: false, reason: `total planned replicas ${totalReplicas} exceeds sandbox limit of 8` };
  }
  return { fits: true, reason: null };
}

export function checkSandboxLimits(plan: CapacityPlan, maxMemoryGb: number): CapacityPlan {
  if (!plan.feasible) return plan;

  const kept: CapacityPlanOption[] = [];
  const droppedReasons: string[] = [];
  for (const option of plan.options) {
    const { fits, reason } = tierFitsSandbox(option, maxMemoryGb);
    if (fits) kept.push(option);
    else droppedReasons.push(`${option.tier}: ${reason}`);
  }

  if (kept.length === 0) {
    return { ...plan, feasible: false, infeasibility_reason: droppedReasons.join("; ") };
  }

  const recommended_tier = kept.some((o) => o.tier === plan.recommended_tier) ? plan.recommended_tier : kept[0].tier;
  return { ...plan, options: kept, recommended_tier };
}
