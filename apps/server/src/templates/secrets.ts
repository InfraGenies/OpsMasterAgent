import { randomBytes } from "node:crypto";
import type { IaCFile } from "@ops-master/shared";

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

const NAMED_PLACEHOLDER = /__GENERATE__:([A-Za-z0-9_]+)__/g;
const BARE_PLACEHOLDER = /__GENERATE__/g;

/**
 * Freeform-path equivalent of resolveVariableSecrets: the LLM writes IaC file
 * contents directly (skills/writing-compose-iac.md / writing-terraform-iac.md),
 * so secrets live as tokens inside file text rather than a variables object.
 * `__GENERATE__:NAME__` resolves to one consistent value per NAME across every
 * file (e.g. a DB password referenced in both the app's connection string and
 * the db service's own env); bare `__GENERATE__` gets an independent value per
 * occurrence.
 */
export function resolveFreeformSecrets(files: IaCFile[]): IaCFile[] {
  const byName = new Map<string, string>();
  return files.map((file) => {
    let content = file.content.replace(NAMED_PLACEHOLDER, (_match, name: string) => {
      if (!byName.has(name)) byName.set(name, generateSecret());
      return byName.get(name)!;
    });
    content = content.replace(BARE_PLACEHOLDER, () => generateSecret());
    return { ...file, content };
  });
}
