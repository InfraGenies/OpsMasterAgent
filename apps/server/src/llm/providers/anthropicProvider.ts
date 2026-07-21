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
      max_tokens: 4096,
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
