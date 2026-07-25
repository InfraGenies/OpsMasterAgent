/** One implementation per LLM backend. client.ts picks whichever is configured. */
export interface LLMProvider {
  readonly name: string;
  isConfigured(): boolean;
  completeRaw(system: string, user: string): Promise<string>;
}
