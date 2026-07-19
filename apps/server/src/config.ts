import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
  MOCK_LLM: bool(process.env.MOCK_LLM, false),

  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  LOCAL_STORE_PATH: path.resolve(SERVER_ROOT, "data", "local-store.json"),

  DEPLOY_TARGET: process.env.DEPLOY_TARGET ?? "compose",
  DEPLOYMENTS_DIR: path.resolve(SERVER_ROOT, process.env.DEPLOYMENTS_DIR ?? "./deployments"),

  APPROVAL_TIMEOUT_MINUTES: Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 30),

  SERVER_ROOT,
  PROMPTS_DIR: path.resolve(__dirname, "prompts"),
};
