import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config.js";

let client: Anthropic | undefined;

export function isMockMode(): boolean {
  return env.MOCK_LLM || !env.ANTHROPIC_API_KEY;
}

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

/** Single non-mocked call to Claude. Callers handle JSON parsing/retries. */
export async function completeRaw(system: string, user: string): Promise<string> {
  const res = await getClient().messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: user }],
  });
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("completeRaw: no text block in Anthropic response");
  }
  return textBlock.text;
}

/** Strips ```json / ``` fences defensively even though prompts say "ONLY JSON". */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : trimmed).trim();
}
