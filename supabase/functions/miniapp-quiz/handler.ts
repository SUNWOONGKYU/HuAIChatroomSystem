// 인지부채(Cognitive Debt) 방지 퀴즈 조회·채점. 순수 핸들러 — Deno.* 를 참조하지 않는다
// (miniapp-approve/handler.ts 와 같은 이유 — node --test 로 회귀 테스트를 돌리기 위함).
//
// GET  ?taskId=<uuid>  → 문항만 돌려준다(정답은 절대 내려보내지 않는다).
// POST { taskId, answers: number[] } → 서버(service-role)에서 채점한다. 클라이언트가
//   정답 인덱스를 알 수 없으니 채점을 우회할 수 없다.
//
// 권한: final_approve 를 누를 수 있는 사람만 퀴즈를 보고 풀 수 있다 — 이 퀴즈 자체가
// final_approve 의 선행 조건이므로(miniapp-approve/handler.ts 의 fetchTaskQuizStatus
// 게이트 참고), 그보다 넓은 권한에게 노출할 이유가 없다.
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import type { MiniAppAuthResult } from "../_shared/types.ts";

const QUIZ_PERMISSION = "task:final_approve";

export type QuizQuestion = { q: string; choices: [string, string, string, string]; correct: 0 | 1 | 2 | 3 };
export type QuizRow = {
  task_id: string;
  room_id: string;
  summary: string;
  questions: QuizQuestion[];
  passed: boolean;
  attempts: number;
};
export type TaskRoomRow = { task_id: string; room_id: string };

export type QuizHandlerDeps = {
  authenticate(req: Request): Promise<MiniAppAuthResult>;
  fetchTaskRoom(taskId: string): Promise<{ error?: string; data?: TaskRoomRow | null }>;
  checkPermission(roomId: string, telegramUserId: string, permission: string): Promise<{ error?: string; data?: boolean }>;
  fetchQuiz(taskId: string): Promise<{ error?: string; data?: QuizRow | null }>;
  markQuizPassed(taskId: string): Promise<{ error?: string }>;
  incrementQuizAttempts(taskId: string): Promise<{ error?: string }>;
};

export async function handleMiniappQuizRequest(req: Request, deps: QuizHandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflightResponse();

  const auth = await deps.authenticate(req);
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.message });

  if (req.method === "GET") {
    const url = new URL(req.url);
    const taskId = url.searchParams.get("taskId") ?? "";
    if (!taskId) return jsonResponse(400, { error: "invalid-request" });
    return handleGet(deps, auth.telegramUserId, taskId);
  }

  if (req.method === "POST") {
    let body: { taskId?: unknown; answers?: unknown };
    try {
      body = await req.json();
    } catch {
      return jsonResponse(400, { error: "invalid-json" });
    }
    const taskId = typeof body.taskId === "string" && body.taskId ? body.taskId : undefined;
    const answers = Array.isArray(body.answers) ? body.answers : undefined;
    if (!taskId || !answers || answers.length !== 3 || !answers.every((value) => Number.isInteger(value) && value >= 0 && value <= 3)) {
      return jsonResponse(400, { error: "invalid-request" });
    }
    return handleSubmit(deps, auth.telegramUserId, taskId, answers as number[]);
  }

  return jsonResponse(405, { error: "method-not-allowed" });
}

async function authorizeForTask(
  deps: QuizHandlerDeps,
  telegramUserId: string,
  taskId: string
): Promise<{ error: Response } | { roomId: string }> {
  const taskResult = await deps.fetchTaskRoom(taskId);
  if (taskResult.error) {
    console.error(`miniapp-quiz: task lookup failed: ${taskResult.error}`);
    return { error: jsonResponse(500, { error: "lookup-failed" }) };
  }
  if (!taskResult.data) return { error: jsonResponse(404, { error: "not-found" }) };

  const permResult = await deps.checkPermission(taskResult.data.room_id, telegramUserId, QUIZ_PERMISSION);
  if (permResult.error) {
    console.error(`miniapp-quiz: permission check failed: ${permResult.error}`);
    return { error: jsonResponse(500, { error: "lookup-failed" }) };
  }
  if (!permResult.data) return { error: jsonResponse(403, { error: "forbidden" }) };

  return { roomId: taskResult.data.room_id };
}

async function handleGet(deps: QuizHandlerDeps, telegramUserId: string, taskId: string): Promise<Response> {
  const authz = await authorizeForTask(deps, telegramUserId, taskId);
  if ("error" in authz) return authz.error;

  const quizResult = await deps.fetchQuiz(taskId);
  if (quizResult.error) {
    console.error(`miniapp-quiz: quiz lookup failed: ${quizResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }
  const quiz = quizResult.data;
  if (!quiz) return jsonResponse(200, { hasQuiz: false });

  return jsonResponse(200, {
    hasQuiz: true,
    passed: quiz.passed,
    attempts: quiz.attempts,
    summary: quiz.passed ? quiz.summary : undefined,
    // 정답(correct)은 절대 내려보내지 않는다 — 여기서 지운다.
    questions: quiz.questions.map((question) => ({ q: question.q, choices: question.choices }))
  });
}

async function handleSubmit(deps: QuizHandlerDeps, telegramUserId: string, taskId: string, answers: number[]): Promise<Response> {
  const authz = await authorizeForTask(deps, telegramUserId, taskId);
  if ("error" in authz) return authz.error;

  const quizResult = await deps.fetchQuiz(taskId);
  if (quizResult.error) {
    console.error(`miniapp-quiz: quiz lookup failed: ${quizResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }
  const quiz = quizResult.data;
  if (!quiz) return jsonResponse(404, { error: "no-quiz" });

  // 이미 통과한 퀴즈를 다시 제출해도 멱등하게 통과로 답한다 — 재시도로 두 번째 요청이
  // 뒤늦게 도착해도 오답 판정으로 뒤집히면 안 된다.
  if (quiz.passed) return jsonResponse(200, { passed: true });

  const correctCount = quiz.questions.filter((question, index) => question.correct === answers[index]).length;
  if (correctCount === 3) {
    const markResult = await deps.markQuizPassed(taskId);
    if (markResult.error) {
      console.error(`miniapp-quiz: mark-passed failed: ${markResult.error}`);
      return jsonResponse(500, { error: "write-failed" });
    }
    return jsonResponse(200, { passed: true });
  }

  const incrementResult = await deps.incrementQuizAttempts(taskId);
  if (incrementResult.error) {
    // 시도 횟수 기록 실패는 채점 결과 자체를 못 돌려줄 이유가 아니다 — 로그만 남긴다.
    console.error(`miniapp-quiz: increment-attempts failed: ${incrementResult.error}`);
  }
  return jsonResponse(200, { passed: false, correctCount, summary: quiz.summary });
}
