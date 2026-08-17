import { SupabaseOutboxStore } from "../../../packages/supabase-runtime/src/index.js";
import { type LocalGatewayOutboxStore } from "./consumer.js";

export class LocalGatewaySupabaseOutboxStore extends SupabaseOutboxStore implements LocalGatewayOutboxStore {}

export function buildLocalGatewaySupabaseOutboxStoreFromEnv(env: NodeJS.ProcessEnv = process.env): LocalGatewaySupabaseOutboxStore {
  return new LocalGatewaySupabaseOutboxStore({
    url: requiredEnv(env, "SUPABASE_URL"),
    serviceRoleKey: requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY"),
    // 자기 앞으로 온 일만 집는다. 이게 없으면 방마다 띄운 게이트웨이들이 같은 큐에서
    // 아무 일이나 먼저 집어 남의 방 작업을 실패시킨다.
    gatewayId: requiredEnv(env, "LOCAL_GATEWAY_ID"),
    // "전문 보기" 버튼이 열 현황판 딥링크. 없으면 버튼 없이 앞부분만 보낸다.
    miniAppDirectLinkBaseUrl: env.BOT_SERVICE_MINIAPP_DIRECT_LINK || undefined
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}