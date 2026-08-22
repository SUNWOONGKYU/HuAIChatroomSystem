// handleMiniappQuizRequest 회귀 테스트. 실행 방법은
// ../_shared/proposal-payload.test.ts 상단 주석 참고.
import test from "node:test";
import assert from "node:assert/strict";
import { handleMiniappQuizRequest, type QuizHandlerDeps, type QuizRow } from "./handler";

const QUIZ: QuizRow = {
  task_id: "task-1",
  room_id: "room-1",
  summary: "index.ts에 로그인 체크를 추가했습니다.",
  questions: [
    { q: "q1", choices: ["a", "b", "c", "d"], correct: 0 },
    { q: "q2", choices: ["a", "b", "c", "d"], correct: 1 },
    { q: "q3", choices: ["a", "b", "c", "d"], correct: 2 }
  ],
  passed: false,
  attempts: 0
};

function makeDeps(overrides: Partial<QuizHandlerDeps> = {}): QuizHandlerDeps {
  return {
    authenticate: async () => ({ ok: true, telegramUserId: "111" }),
    fetchTaskRoom: async () => ({ data: { task_id: "task-1", room_id: "room-1" } }),
    checkPermission: async () => ({ data: true }),
    fetchQuiz: async () => ({ data: QUIZ }),
    markQuizPassed: async () => ({}),
    incrementQuizAttempts: async () => ({}),
    ...overrides
  };
}

function getReq(taskId: string): Request {
  return new Request(`https://x/miniapp-quiz?taskId=${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: { authorization: "tma fake" }
  });
}

function postReq(body: unknown): Request {
  return new Request("https://x/miniapp-quiz", {
    method: "POST",
    headers: { authorization: "tma fake", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("GET: 퀴즈가 없으면 hasQuiz:false", async () => {
  const deps = makeDeps({ fetchQuiz: async () => ({ data: null }) });
  const res = await handleMiniappQuizRequest(getReq("task-1"), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.hasQuiz, false);
});

test("GET: 정답(correct)은 응답에 절대 실리지 않는다", async () => {
  const deps = makeDeps();
  const res = await handleMiniappQuizRequest(getReq("task-1"), deps);
  const body = await res.json();
  assert.equal(body.hasQuiz, true);
  assert.equal(JSON.stringify(body).includes('"correct"'), false, "정답 인덱스가 클라이언트로 새면 안 된다");
  assert.equal(body.questions.length, 3);
  assert.deepEqual(body.questions[0], { q: "q1", choices: ["a", "b", "c", "d"] });
});

test("GET: 통과 전에는 summary(설명)도 감춘다 — 답을 유추할 단서를 주면 안 된다", async () => {
  const deps = makeDeps();
  const res = await handleMiniappQuizRequest(getReq("task-1"), deps);
  const body = await res.json();
  assert.equal(body.summary, undefined);
});

test("GET: 권한이 없으면 403", async () => {
  const deps = makeDeps({ checkPermission: async () => ({ data: false }) });
  const res = await handleMiniappQuizRequest(getReq("task-1"), deps);
  assert.equal(res.status, 403);
});

test("GET: task 를 찾을 수 없으면 404", async () => {
  const deps = makeDeps({ fetchTaskRoom: async () => ({ data: null }) });
  const res = await handleMiniappQuizRequest(getReq("task-1"), deps);
  assert.equal(res.status, 404);
});

test("POST: 3문항 모두 정답이면 통과로 기록하고 passed:true", async () => {
  let marked = false;
  const deps = makeDeps({ markQuizPassed: async () => { marked = true; return {}; } });
  const res = await handleMiniappQuizRequest(postReq({ taskId: "task-1", answers: [0, 1, 2] }), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.passed, true);
  assert.equal(marked, true);
});

test("POST: 하나라도 틀리면 통과 안 되고 설명(summary)과 정답 개수를 돌려준다", async () => {
  let attemptsIncremented = false;
  const deps = makeDeps({ incrementQuizAttempts: async () => { attemptsIncremented = true; return {}; } });
  const res = await handleMiniappQuizRequest(postReq({ taskId: "task-1", answers: [0, 0, 0] }), deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.passed, false);
  assert.equal(body.correctCount, 1);
  assert.equal(body.summary, QUIZ.summary);
  assert.equal(attemptsIncremented, true);
});

test("POST: 이미 통과한 퀴즈는 재제출해도 멱등하게 passed:true (오답으로 뒤집히지 않는다)", async () => {
  const deps = makeDeps({ fetchQuiz: async () => ({ data: { ...QUIZ, passed: true } }) });
  const res = await handleMiniappQuizRequest(postReq({ taskId: "task-1", answers: [3, 3, 3] }), deps);
  const body = await res.json();
  assert.equal(body.passed, true);
});

test("POST: answers 가 3개가 아니면 400", async () => {
  const deps = makeDeps();
  const res = await handleMiniappQuizRequest(postReq({ taskId: "task-1", answers: [0, 1] }), deps);
  assert.equal(res.status, 400);
});

test("POST: answers 값이 0~3 범위를 벗어나면 400", async () => {
  const deps = makeDeps();
  const res = await handleMiniappQuizRequest(postReq({ taskId: "task-1", answers: [0, 1, 9] }), deps);
  assert.equal(res.status, 400);
});

test("POST: 퀴즈가 없으면 404", async () => {
  const deps = makeDeps({ fetchQuiz: async () => ({ data: null }) });
  const res = await handleMiniappQuizRequest(postReq({ taskId: "task-1", answers: [0, 1, 2] }), deps);
  assert.equal(res.status, 404);
});

test("인증 실패는 401", async () => {
  const deps = makeDeps({ authenticate: async () => ({ ok: false, status: 401, message: "unauthorized" }) });
  const res = await handleMiniappQuizRequest(getReq("task-1"), deps);
  assert.equal(res.status, 401);
});

test("지원하지 않는 메서드는 405", async () => {
  const deps = makeDeps();
  const res = await handleMiniappQuizRequest(new Request("https://x/miniapp-quiz", { method: "DELETE", headers: { authorization: "tma fake" } }), deps);
  assert.equal(res.status, 405);
});
