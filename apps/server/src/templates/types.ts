import type { CapacityPlanOption, IaCFile, IaCPayload, TemplateId } from "@ops-master/shared";

export interface RenderContext {
  requestId: string;
  /** docker compose -p project name: lowercase, [a-z0-9_-] only. */
  projectName: string;
}

export interface RenderResult {
  files: IaCFile[];
  applyCommand: string;
  rollbackCommand: string;
}

export interface TemplateDefinition {
  id: TemplateId;
  format: IaCPayload["format"];
  description: string;
  /** Which CapacityPlan services this template expects, for a friendly no_template-style error. */
  render(plan: CapacityPlanOption, variables: Record<string, unknown>, ctx: RenderContext): RenderResult;
}

export function isDbService(image: string): boolean {
  return image.startsWith("postgres") || image.startsWith("mysql");
}

export function isCacheService(image: string): boolean {
  return image.startsWith("redis");
}

export function isLbService(image: string): boolean {
  return image.startsWith("nginx");
}

export function appServices(plan: CapacityPlanOption) {
  const nonInfra = plan.services.filter((s) => !isDbService(s.image) && !isCacheService(s.image));
  const nonLb = nonInfra.filter((s) => !isLbService(s.image));
  // isLbService only means "load balancer" when it's actually fronting some
  // other app service — a lone nginx-image service is legitimately the app
  // itself (e.g. a static site served directly by nginx, which a real LLM
  // plan can produce even though no BUILD_REGISTRY sentinel was used). Only
  // exclude nginx-image services when something non-db/cache remains for
  // them to front; otherwise fall back to treating the nginx service(s) as
  // the app so a single-service static-site plan isn't misread as having 0
  // app services (confirmed live: readiness_check's template_topology_supported
  // check refused exactly this shape before this fallback existed).
  return nonLb.length > 0 ? nonLb : nonInfra;
}

export function dbService(plan: CapacityPlanOption) {
  return plan.services.find((s) => isDbService(s.image));
}

export function cacheService(plan: CapacityPlanOption) {
  return plan.services.find((s) => isCacheService(s.image));
}

export function hostPortFor(plan: CapacityPlanOption, serviceName: string, fallback: number): number {
  return plan.network.expose.find((e) => e.service === serviceName)?.host_port ?? fallback;
}
