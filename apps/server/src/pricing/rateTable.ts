import type { ServiceSpec, StorageSpec } from "@ops-master/shared";

/**
 * Local, illustrative sandbox rates (per proposal §2: "a local rate table is
 * enough for MVP — no live cloud pricing API needed yet, structured so
 * swapping in a real one later is a drop-in behind estimated_cost_usd_monthly").
 * Roughly shaped like generic on-demand container-hosting pricing, not tied
 * to any one cloud — the AWS-specific table for the Terraform path lives
 * separately in pricing/awsRateTable.ts since managed services price
 * differently from raw CPU/RAM.
 */
const USD_PER_VCPU_HOUR = 0.04;
const USD_PER_GIB_RAM_HOUR = 0.005;
const USD_PER_GIB_STORAGE_MONTH = 0.1;
const HOURS_PER_MONTH = 730;

function parseCpuCores(cpu: string): number {
  const n = Number(cpu);
  return Number.isFinite(n) ? n : 1;
}

function parseSizeGi(size: string): number {
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(Mi|Gi)$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2].toLowerCase() === "gi" ? value : value / 1024;
}

/** Rounded whole-dollar monthly estimate — precision beyond that is false confidence for a rate-table figure. */
export function estimateMonthlyCost(services: ServiceSpec[], storage: StorageSpec[]): number {
  const computeUsd = services.reduce((sum, s) => {
    const cores = parseCpuCores(s.cpu) * s.replicas;
    const ramGi = parseSizeGi(s.memory) * s.replicas;
    return sum + (cores * USD_PER_VCPU_HOUR + ramGi * USD_PER_GIB_RAM_HOUR) * HOURS_PER_MONTH;
  }, 0);
  const storageUsd = storage.reduce((sum, s) => sum + parseSizeGi(s.size) * USD_PER_GIB_STORAGE_MONTH, 0);
  return Math.round(computeUsd + storageUsd);
}
