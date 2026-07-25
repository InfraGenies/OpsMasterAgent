import { env } from "../../config.js";
import type { LLMProvider } from "./types.js";

/**
 * Calls Amazon Bedrock's native Converse API directly over HTTPS, authenticating
 * via an AWS Bedrock API key (bearer token) rather than SigV4 — no aws-sdk
 * credential chain needed. Validated manually against BEDROCK_MODEL_ID =
 * us.anthropic.claude-sonnet-4-5-20250929-v1:0 in AWS_REGION = us-east-1
 * (see apps/server/src/llm/providers/bedrock_access_test.py).
 */
export const bedrockProvider: LLMProvider = {
  name: "bedrock",

  isConfigured(): boolean {
    return Boolean(env.AWS_BEARER_TOKEN_BEDROCK && env.BEDROCK_MODEL_ID && env.AWS_REGION);
  },

  async completeRaw(system: string, user: string): Promise<string> {
    const url = `https://bedrock-runtime.${env.AWS_REGION}.amazonaws.com/model/${encodeURIComponent(
      env.BEDROCK_MODEL_ID,
    )}/converse`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.AWS_BEARER_TOKEN_BEDROCK}`,
      },
      body: JSON.stringify({
        system: [{ text: system }],
        messages: [{ role: "user", content: [{ text: user }] }],
        // Same headroom as anthropicProvider: the Enterprise Architecture
        // Advisor's larger JSON output needs room beyond Bedrock's small default.
        inferenceConfig: { maxTokens: 8192 },
      }),
    });

    if (!res.ok) {
      throw new Error(`bedrockProvider.completeRaw: HTTP ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
    };
    const text = data.output?.message?.content?.[0]?.text;
    if (!text) {
      throw new Error("bedrockProvider.completeRaw: no text content in response");
    }
    return text;
  },
};
