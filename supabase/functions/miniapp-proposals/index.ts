// Mini App 작업판 — 방의 미결 제안 목록 조회 (GET). 실제 로직은 handler.ts(순수, Deno 미참조)에
// 있다 — 이 파일은 Deno.serve 배선과 실제 Supabase 호출 주입만 담당한다. 배경·설계 근거는
// handler.ts 와 ../_shared/proposal-payload.ts 주석 참고.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateMiniAppRequest } from "../_shared/miniapp-auth.ts";
import { assertRoomReadAccess } from "../_shared/membership.ts";
import { jsonResponse } from "../_shared/cors.ts";
import { handleMiniappProposalsRequest, type ProposalsHandlerDeps } from "./handler.ts";
import { buildDepsFromClient } from "./deps.ts";

Deno.serve((req: Request) => {
  const deps = buildDeps();
  if (!deps) {
    console.error("miniapp-proposals: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set");
    return Promise.resolve(jsonResponse(500, { error: "server-misconfigured" }));
  }
  return handleMiniappProposalsRequest(req, deps);
});

function buildDeps(): ProposalsHandlerDeps | undefined {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return undefined;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  return {
    authenticate: authenticateMiniAppRequest,
    checkRoomAccess: (roomId, telegramUserId) => assertRoomReadAccess(supabase, roomId, telegramUserId),
    // huai_events/huai_approvals 쿼리 조립(.eq("room_id", roomId) 포함)은 deps.ts 의
    // buildDepsFromClient 가 맡는다 — room-isolation.test.ts 가 FakeSupabaseClient 로 그
    // 필터가 실제로 걸리는지 실행 검증한다(handler.ts 는 이번 작업에서 건드리지 않는다).
    ...buildDepsFromClient(supabase)
  };
}
