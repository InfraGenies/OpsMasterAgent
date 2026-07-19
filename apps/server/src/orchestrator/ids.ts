import { randomBytes } from "node:crypto";

export function generateRequestId(): string {
  const year = new Date().getFullYear();
  return `req-${year}-${randomBytes(4).toString("hex")}`;
}

/** docker compose -p project names must be lowercase [a-z0-9_-]. */
export function projectNameFor(requestId: string): string {
  return requestId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

export function envIdFor(requestId: string): string {
  return `env-${requestId}`;
}
