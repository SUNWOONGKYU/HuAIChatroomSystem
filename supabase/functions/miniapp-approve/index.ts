// Mini App 작업 현황판 — 방장의 승인/거부/보완요청/최종승인/취소 결정 기록 (POST).
// 실제 로직은 handler.ts(순수, Deno 미참조)에 있다. 이 파일은 Deno.serve 배선과 실제
// Supabase 호출 주입만 담당한다.
//
// handler.ts 가 실제로 하는 일과 하지 않는 일(중요, 보고서 참고):
//   한다   — huai_approvals(승인 원장, append-only) 에 결정을 멱등하게 기록한다.
//            huai_events 에도 감사용 이벤트를 남긴다.
//   안 한다 — huai_tasks.status 를 직접 전이시키지 않는다.
// 이유는 handler.ts 상단 및 이 함수의 최초 설계 보고에 남겨져 있다 — 리더 쪽에서
// huai_approvals/huai_events(miniapp_decision_recorded) 를 소비하는 폴러를 붙이는 중이다.
// 그 폴러가 이 파일이 쓰는 값의 모양(컬럼·idempotency_key 포맷)에 의존하므로,
// 이 파일의 쓰기 계약은 팀장님 지시 없이 바꾸지 않는다.
//
// 권한(task 경로): schema.sql 의 huai_can_act_in_room() 을 그대로 재사용하되, request_revision
// 한 액션에 한해 owner 를 추가로 강제한다 — 근거는 handler.ts 의 requiresOwnerRoleOverride 주석.
// 권한(proposal 경로): huai_can_act_in_room() 을 아예 안 타고 owner 여부만 본다 — 근거는
// handler.ts 상단 주석.
//
// 요청 body 는 taskId 또는 proposalId 중 정확히 하나를 받는다(handler.ts 가 분기한다).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateMiniAppRequest } from "../_shared/miniapp-auth.ts";
import { jsonResponse } from "../_shared/cors.ts";
import { handleMiniappApproveRequest, type ApproveHandlerDeps } from "./handler.ts";

Deno.serve((req: Request) => {
  const deps = buildDeps();
  if (!deps) {
    console.error("miniapp-approve: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set");
    return Promise.resolve(jsonResponse(500, { error: "server-misconfigured" }));
  }
  return handleMiniappApproveRequest(req, deps);
});

function buildDeps(): ApproveHandlerDeps | undefined {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return undefined;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  return {
    authenticate: authenticateMiniAppRequest,
    async fetchTask(taskId) {
      // updated_at 이 필요하다 — handler.ts 의 idempotency_key 안정화(라운드 판별) 근거 주석 참고.
      const { data, error } = await supabase
        .from("huai_tasks")
        .select("task_id, room_id, status, updated_at")
        .eq("task_id", taskId)
        .maybeSingle();
      if (error) return { error: error.message };
      return { data };
    },
    async checkPermission(roomId, telegramUserId, permission) {
      const { data, error } = await supabase.rpc("huai_can_act_in_room", {
        p_room_id: roomId,
        p_telegram_user_id: telegramUserId,
        p_permission: permission
      });
      if (error) return { error: error.message };
      return { data: Boolean(data) };
    },
    async fetchMembershipRole(roomId, telegramUserId) {
      const { data, error } = await supabase
        .from("huai_room_members")
        .select("role")
        .eq("room_id", roomId)
        .eq("telegram_user_id", telegramUserId)
        .eq("status", "active")
        .maybeSingle();
      if (error) return { error: error.message };
      return { data };
    },
    async fetchProposalRoomId(proposalId) {
      // 제안은 huai_tasks 가 없어 room_id 를 huai_events(proposal_created) 의 payload 에서
      // 되짚는다. payload->>proposalId 는 PostgREST JSON 연산자 필터 문법이다.
      const { data, error } = await supabase
        .from("huai_events")
        .select("room_id")
        .eq("event_type", "proposal_created")
        .eq("payload->>proposalId", proposalId)
        .not("room_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return { error: error.message };
      return { data };
    },
    async checkProposalAlreadyDecided(roomId, proposalId) {
      // miniapp-proposals 의 "미결" anti-join 과 정확히 같은 조건(stage='task_approval').
      const { data, error } = await supabase
        .from("huai_approvals")
        .select("approval_id")
        .eq("room_id", roomId)
        .eq("stage", "task_approval")
        .eq("entity_ref", proposalId)
        .limit(1)
        .maybeSingle();
      if (error) return { error: error.message };
      return { data: Boolean(data) };
    },
    async insertApproval(row) {
      const { data, error } = await supabase.from("huai_approvals").insert(row).select("approval_id").maybeSingle();
      if (error) return { error: { code: (error as { code?: string }).code ?? "", message: error.message } };
      return { data };
    },
    async insertEvent(row) {
      const { error } = await supabase.from("huai_events").insert(row);
      if (error) return { error: { code: (error as { code?: string }).code ?? "", message: error.message } };
      return {};
    },
    async fetchTaskQuizStatus(taskId) {
      const { data, error } = await supabase
        .from("huai_task_quizzes")
        .select("passed")
        .eq("task_id", taskId)
        .maybeSingle();
      if (error) return { error: error.message };
      return { data: { hasQuiz: Boolean(data), passed: data?.passed === true } };
    }
  };
}
