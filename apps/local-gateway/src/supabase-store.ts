import { SupabaseOutboxStore } from "../../../packages/supabase-runtime/src/index.js";
import { type LocalGatewayOutboxStore } from "./consumer.js";

export class LocalGatewaySupabaseOutboxStore extends SupabaseOutboxStore implements LocalGatewayOutboxStore {}

export function buildLocalGatewaySupabaseOutboxStoreFromEnv(env: NodeJS.ProcessEnv = process.env): LocalGatewaySupabaseOutboxStore {
  return new LocalGatewaySupabaseOutboxStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY")
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}