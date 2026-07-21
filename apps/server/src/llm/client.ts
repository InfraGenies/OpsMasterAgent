import { env } from "../config.js";
import { anthropicProvider } from "./providers/anthropicProvider.js";
import { kiroProvider } from "./providers/kiroProvider.js";
import type { LLMProvider } from "./providers/types.js";

// Order matters for "auto": first configured provider wins. Anthropic first
// (primary), Kiro as the fallback once its credentials are supplied.
const providers: LLMProvider[] = [anthropicProvider, kiroProvider];

/** LLM_PROVIDER=auto (default) picks the first configured provider above;
 * anthropic|kiro forces one and falls back to mock if it isn't configured. */
function resolveProvider(): LLMProvider | undefined {
  if (env.LLM_PROVIDER !== "auto") {
    const forced = providers.find((p) => p.name === env.LLM_PROVIDER);
    return forced?.isConfigured() ? forced : undefined;
  }
  return providers.find((p) => p.isConfigured());
}

export function isMockMode(): boolean {
  return env.MOCK_LLM || !resolveProvider();
}

/** "mock" when no provider is configured/selected, otherwise the active provider's name. */
export function activeProviderName(): string {
  return isMockMode() ? "mock" : (resolveProvider()?.name ?? "mock");
}

/** Single non-mocked call to the active provider. Callers handle JSON parsing/retries. */
export async function completeRaw(system: string, user: string): Promise<string> {
  const provider = resolveProvider();
  if (!provider) throw new Error("completeRaw: no LLM provider configured");
  return provider.completeRaw(system, user);
}

/** Strips ```json / ``` fences defensively even though prompts say "ONLY JSON". */
export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced ? fenced[1] : trimmed).trim();
}
