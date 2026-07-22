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
  PORT: Number(process.env.PORT ?? 4100),

  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
  MOCK_LLM: bool(process.env.MOCK_LLM, false),

  // "auto" (default): use the first configured provider below (Anthropic,
  // then Kiro). "anthropic"/"kiro" forces one — falls back to mock if that
  // provider's credentials aren't set. See llm/client.ts: resolveProvider.
  LLM_PROVIDER: (process.env.LLM_PROVIDER ?? "auto").toLowerCase(),
  KIRO_API_KEY: process.env.KIRO_API_KEY ?? "",
  KIRO_API_BASE_URL: process.env.KIRO_API_BASE_URL ?? "",
  KIRO_MODEL: process.env.KIRO_MODEL ?? "",

  SUPABASE_URL: process.env.SUPABASE_URL ?? "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  LOCAL_STORE_PATH: path.resolve(SERVER_ROOT, "data", "local-store.json"),

  DEPLOY_TARGET: process.env.DEPLOY_TARGET ?? "compose",
  DEPLOYMENTS_DIR: path.resolve(SERVER_ROOT, process.env.DEPLOYMENTS_DIR ?? "./deployments"),

  // "auto" (default): simulate deploy/verify only when the docker CLI is
  // missing on this machine. "true"/"false" force one behavior.
  MOCK_DEPLOY: (process.env.MOCK_DEPLOY ?? "auto").toLowerCase(),
  // Skip the autocannon load test inside verify (health checks still run).
  SKIP_LOAD_TEST: bool(process.env.SKIP_LOAD_TEST, false),

  APPROVAL_TIMEOUT_MINUTES: Number(process.env.APPROVAL_TIMEOUT_MINUTES ?? 30),

  SERVER_ROOT,
  PROMPTS_DIR: path.resolve(__dirname, "prompts"),
  SKILLS_DIR: path.resolve(__dirname, "skills"),
};
