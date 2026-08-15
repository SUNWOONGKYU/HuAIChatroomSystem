// Mini App 작업판 — 방의 작업 목록 조회 (GET). 실제 로직은 handler.ts(순수, Deno 미참조)에
// 있다 — 이 파일은 Deno.serve 배선과 실제 Supabase 호출 주입만 담당한다(miniapp-proposals 와
// 동일한 분리 패턴, handler.ts 상단 주석 참고).
//
// 인증 모델(작업 2, 소대장 승인 대기 중): RLS 를 쓰지 않고 이 Edge Function 이
// service_role 로 모든 데이터 접근을 중개한다 — 세 가지 안 중 "RLS 없이 중개" 안을
// 이미 채택한 상태로 동작한다. 어느 안이 최종 승인되어도(RLS+JWT 안이 되더라도) 이 함수의
// HTTP 계약은 그대로 유지할 수 있어 정적 페이지 쪽을 다시 만들 필요가 없다.
// migrations/20260815150000_huai_miniapp_read_policies.sql 은 아직 생성하지 않았다 —
// 그건 작업 2 승인 이후의 몫이다.
//
// 권한 확인: huai_room_members 에 (room_id, telegram_user_id, status='active') 행이
// 있어야만 그 방의 작업을 볼 수 있다. service_role 키는 RLS 를 우회하므로 이 확인은
// 반드시 이 함수 코드에서 직접 해야 한다 — DB 가 대신 막아주지 않는다.
//
// 구조 참고: buzzlab-nextjs supabase/functions/decrypt-api-key/index.ts:1-102 의
// Deno.serve + service_role 클라이언트 골격 (하는 일은 무관).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateMiniAppRequest } from "../_shared/miniapp-auth.ts";
import { assertRoomReadAccess } from "../_shared/membership.ts";
import { jsonResponse } from "../_shared/cors.ts";
import { handleMiniappTasksRequest, buildDepsFromClient, type TasksHandlerDeps } from "./handler.ts";

Deno.serve((req: Request) => {
  const deps = buildDeps();
  if (!deps) {
    console.error("miniapp-tasks: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set");
    return Promise.resolve(jsonResponse(500, { error: "server-misconfigured" }));
  }
  return handleMiniappTasksRequest(req, deps);
});

function buildDeps(): TasksHandlerDeps | undefined {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return undefined;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  return {
    authenticate: authenticateMiniAppRequest,
    checkRoomAccess: (roomId, telegramUserId) => assertRoomReadAccess(supabase, roomId, telegramUserId),
    // huai_tasks 쿼리 조립(.eq("room_id", roomId) 포함)은 handler.ts 의 buildDepsFromClient 가
    // 맡는다 — room-isolation.test.ts 가 FakeSupabaseClient 로 그 필터를 실행 검증한다.
    ...buildDepsFromClient(supabase)
  };
}
