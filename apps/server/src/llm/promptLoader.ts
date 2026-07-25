import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config.js";

/**
 * Loads an agent's system prompt verbatim from its fenced ```text block —
 * the exact convention agent-md-files/README.md prescribes, so editing the
 * prompt file changes runtime behaviour with no code change.
 */
export function loadPrompt(filename: string): string {
  const text = readFileSync(path.join(env.PROMPTS_DIR, filename), "utf-8");
  const parts = text.split("```text");
  if (parts.length < 2) {
    throw new Error(`loadPrompt: no \`\`\`text fenced block found in ${filename}`);
  }
  return parts[1].split("```")[0].trim();
}
