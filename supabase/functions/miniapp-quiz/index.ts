// Mini App 인지부채 방지 퀴즈 — 조회(GET)·채점(POST). 실제 로직은 handler.ts(순수,
// Deno 미참조)에 있다. 이 파일은 Deno.serve 배선과 실제 Supabase 호출 주입만 담당한다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateMiniAppRequest } from "../_shared/miniapp-auth.ts";
import { jsonResponse } from "../_shared/cors.ts";
import { handleMiniappQuizRequest, type QuizHandlerDeps, type QuizRow } from "./handler.ts";

Deno.serve((req: Request) => {
  const deps = buildDeps();
  if (!deps) {
    console.error("miniapp-quiz: SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set");
    return Promise.resolve(jsonResponse(500, { error: "server-misconfigured" }));
  }
  return handleMiniappQuizRequest(req, deps);
});

function buildDeps(): QuizHandlerDeps | undefined {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceRoleKey) return undefined;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  return {
    authenticate: authenticateMiniAppRequest,
    async fetchTaskRoom(taskId) {
      const { data, error } = await supabase
        .from("huai_tasks")
        .select("task_id, room_id")
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
    async fetchQuiz(taskId) {
      const { data, error } = await supabase
        .from("huai_task_quizzes")
        .select("task_id, room_id, summary, questions, passed, attempts")
        .eq("task_id", taskId)
        .maybeSingle();
      if (error) return { error: error.message };
      return { data: data as QuizRow | null };
    },
    async markQuizPassed(taskId) {
      const { error } = await supabase
        .from("huai_task_quizzes")
        .update({ passed: true, updated_at: new Date().toISOString() })
        .eq("task_id", taskId);
      if (error) return { error: error.message };
      return {};
    },
    async incrementQuizAttempts(taskId) {
      const { error } = await supabase.rpc("huai_increment_task_quiz_attempts", { p_task_id: taskId });
      if (error) return { error: error.message };
      return {};
    }
  };
}
