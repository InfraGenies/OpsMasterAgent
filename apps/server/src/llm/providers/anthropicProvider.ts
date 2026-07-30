import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../config.js";
import type { LLMProvider } from "./types.js";

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export const anthropicProvider: LLMProvider = {
  name: "anthropic",

  isConfigured(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  },

  async completeRaw(system: string, user: string): Promise<string> {
    const res = await getClient().messages.create({
      model: env.ANTHROPIC_MODEL,
      // 16000 (was 8192, was 4096): confirmed live against real Bedrock that
      // the Enterprise Architecture Advisor's largest outputs (15-step
      // task_graph + alternatives_considered + managed_controls reasoning,
      // planner.ts's ENTERPRISE_MODE_NOTE) still truncated mid-JSON at 8192,
      // burning the one runLLMJson retry on an unparseable response. More
      // headroom avoids that without changing what's asked for.
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
    });
    const textBlock = res.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("anthropicProvider.completeRaw: no text block in response");
    }
    return textBlock.text;
  },
};
