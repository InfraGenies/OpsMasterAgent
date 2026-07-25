import type { ZodType, ZodTypeDef } from "zod";
import { completeRaw, extractJson, isMockMode } from "./client.js";

export interface RunLLMJsonArgs<T> {
  /** Input intentionally left as `any`: schemas with `.default()` fields (e.g. CapacityPlanOptionSchema's cost_basis) have an Input narrower than Output T, and we only care about the parsed Output here. */
  schema: ZodType<T, ZodTypeDef, any>;
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

/** Thrown when the model's response fails schema validation on both the initial attempt and the one retry — carries the last raw response text so the caller can persist it (to the audit trail, logs, etc.) instead of it being silently discarded. */
export class LLMValidationError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: string
  ) {
    super(message);
    this.name = "LLMValidationError";
  }
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
  let lastRaw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const user =
      attempt === 0
        ? args.user
        : `${args.user}\n\nYour previous response failed validation with this error:\n${lastError}\nRespond again with ONLY corrected JSON.`;

    const raw = await completeRaw(args.system, user);
    lastRaw = raw;
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

  throw new LLMValidationError(`runLLMJson[${args.node}]: failed after retry — ${lastError}`, lastRaw);
}
