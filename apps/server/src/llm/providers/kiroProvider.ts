import { env } from "../../config.js";
import type { LLMProvider } from "./types.js";

/**
 * Scaffold for a Kiro AI (or any other OpenAI-chat-compatible) backend, wired
 * up ahead of having real credentials. Nothing here has been verified against
 * live Kiro docs yet — KIRO_API_BASE_URL is left blank on purpose (never
 * guess a vendor endpoint), and isConfigured() stays false until the user
 * fills in KIRO_API_BASE_URL + KIRO_API_KEY in .env. Once real API docs are
 * available, adjust the request/response shape below to match.
 */
export const kiroProvider: LLMProvider = {
  name: "kiro",

  isConfigured(): boolean {
    return Boolean(env.KIRO_API_KEY && env.KIRO_API_BASE_URL);
  },

  async completeRaw(system: string, user: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(
        "kiroProvider.completeRaw: KIRO_API_BASE_URL / KIRO_API_KEY not set — fill in apps/server/.env",
      );
    }

    const res = await fetch(`${env.KIRO_API_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.KIRO_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.KIRO_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`kiroProvider.completeRaw: HTTP ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error("kiroProvider.completeRaw: no message content in response");
    }
    return text;
  },
};
