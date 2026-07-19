import type { CapacityPlan, IaCFile, TemplateId } from "@ops-master/shared";

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
  format: "compose";
  description: string;
  /** Which CapacityPlan services this template expects, for a friendly no_template-style error. */
  render(plan: CapacityPlan, variables: Record<string, unknown>, ctx: RenderContext): RenderResult;
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

export function appServices(plan: CapacityPlan) {
  return plan.services.filter(
    (s) => !isDbService(s.image) && !isCacheService(s.image) && !isLbService(s.image)
  );
}

export function dbService(plan: CapacityPlan) {
  return plan.services.find((s) => isDbService(s.image));
}

export function cacheService(plan: CapacityPlan) {
  return plan.services.find((s) => isCacheService(s.image));
}

export function hostPortFor(plan: CapacityPlan, serviceName: string, fallback: number): number {
  return plan.network.expose.find((e) => e.service === serviceName)?.host_port ?? fallback;
}
