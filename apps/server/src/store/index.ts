import { env } from "../config.js";
import { SupabaseStore } from "./supabaseStore.js";
import { LocalJsonStore } from "./localStore.js";
import type { AuditStore } from "./types.js";

let store: AuditStore | undefined;

export function getStore(): AuditStore {
  if (store) return store;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("[store] using SupabaseStore");
    store = new SupabaseStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  } else {
    console.warn(
      "[store] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — falling back to LocalJsonStore " +
        "(apps/server/data/local-store.json). Set both env vars to use Supabase for real."
    );
    store = new LocalJsonStore(env.LOCAL_STORE_PATH);
  }
  return store;
}

export type { AuditStore } from "./types.js";
