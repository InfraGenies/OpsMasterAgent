import type { ZodType } from "zod";
import { completeRaw, extractJson, isMockMode } from "./client.js";

export interface RunLLMJsonArgs<T> {
  schema: ZodType<T>;
  system: string;
  user: string;
  /** Deterministic stand-in used when MOCK_LLM=true or no API key is set. */
  mock: () => T;
  node: string;
}

export interface RunLLMJsonResult<T> {
  value: T;
  rawResponse: string;
  mocked: boolean;
}

/**
 * Calls Claude, parses the response as JSON, validates against `schema`.
 * On a parse/validation failure, retries once with the error appended to
 * the user turn (per 01-intake.md / orchestrator guardrail: "parse failure
 * = one retry with the validation error appended, then route to report as
 * failed").
 */
export async function runLLMJson<T>(args: RunLLMJsonArgs<T>): Promise<RunLLMJsonResult<T>> {
  if (isMockMode()) {
    const value = args.mock();
    return { value, rawResponse: JSON.stringify(value, null, 2), mocked: true };
  }

  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const user =
      attempt === 0
        ? args.user
        : `${args.user}\n\nYour previous response failed validation with this error:\n${lastError}\nRespond again with ONLY corrected JSON.`;

    const raw = await completeRaw(args.system, user);
    const jsonText = extractJson(raw);
    try {
      const parsed = JSON.parse(jsonText);
      const result = args.schema.safeParse(parsed);
      if (result.success) {
        return { value: result.data, rawResponse: raw, mocked: false };
      }
      lastError = result.error.message;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  throw new Error(`runLLMJson[${args.node}]: failed after retry — ${lastError}`);
}
