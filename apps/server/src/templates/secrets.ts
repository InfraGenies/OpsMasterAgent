import { randomBytes } from "node:crypto";

export function generateSecret(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Per 03-iac-generator.md rule 3: the LLM emits the placeholder "__GENERATE__"
 * for any secret value, never a literal password. The backend swaps each
 * occurrence for a real random value at render time, before anything touches
 * disk or the audit log.
 */
export function resolveVariableSecrets<T extends Record<string, unknown>>(variables: T): T {
  const resolved: Record<string, unknown> = { ...variables };
  for (const [key, value] of Object.entries(resolved)) {
    if (value === "__GENERATE__") {
      resolved[key] = generateSecret();
    }
  }
  return resolved as T;
}
