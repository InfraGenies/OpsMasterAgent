import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config.js";

/**
 * Loads a reusable "skill" module verbatim from its fenced ```text block —
 * same convention as promptLoader.ts's loadPrompt, but for knowledge that's
 * shared across nodes or independently editable (sizing formulas, IaC
 * writing conventions, compliance reasoning) rather than a whole node's
 * system prompt. Source of truth lives in agent-md-files/skills/*.md; this
 * reads the runtime copy under apps/server/src/skills/*.md.
 */
export function loadSkill(filename: string): string {
  const name = filename.endsWith(".md") ? filename : `${filename}.md`;
  const text = readFileSync(path.join(env.SKILLS_DIR, name), "utf-8");
  const parts = text.split("```text");
  if (parts.length < 2) {
    throw new Error(`loadSkill: no \`\`\`text fenced block found in ${name}`);
  }
  return parts[1].split("```")[0].trim();
}
