// 완료 게이트 퀴즈가 [승인] 에만 걸리고 [보완 요청] 은 막지 않는지 확인하는 회귀 테스트.
//
// 실사용 중 발견된 버그: 예전엔 작업 상세를 열자마자 퀴즈 여부부터 확인해서, 통과해야만
// 액션 줄(승인·보완 요청 버튼)을 그렸다. 서버(miniapp-approve/handler.ts)는
// action === "final_approve" 일 때만 퀴즈를 강제하는데, 클라이언트는 두 버튼 모두를
// 퀴즈 뒤에 숨겨놓아서 — 결과가 마음에 안 들어 반려하려는 사람도 "뭐가 바뀌었는지
// 이해했냐"를 먼저 통과해야 하는 앞뒤가 안 맞는 상태였다. 방장이 실제로 이 상태에
// 걸려 [보완 요청] 버튼 자체가 안 보인다고 보고했다.
//
// resolve-room-id.test.mjs 와 같은 이유로 같은 기법을 쓴다: index.html 은 빌드 없는
// 자기완결 파일이라 실제 파일 텍스트에서 함수 정의를 그대로 뽑아 실행하거나, DOM을
// 안 쓰는 배선 부분은 소스 텍스트 자체를 정적으로 검사한다.
//
// 실행: node --test supabase/miniapp-web/quiz-gate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

test("resolveQuizThenActions 는 퀴즈 조회 없이 바로 renderActions 를 부른다 — 작업을 열자마자 버튼부터 보인다", () => {
  const start = html.indexOf("function resolveQuizThenActions(task) {");
  const end = html.indexOf("function renderQuiz(task, questions) {");
  assert.ok(start !== -1 && end !== -1 && end > start, "resolveQuizThenActions 또는 renderQuiz 경계를 못 찾았다");
  const body = html.slice(start, end);

  assert.doesNotMatch(
    body,
    /apiFetch\("\/miniapp-quiz/,
    "작업 상세를 여는 시점에 퀴즈부터 조회하면, 통과 전까지 액션 줄(보완 요청 포함)이 안 보이게 된다"
  );
  assert.match(body, /renderActions\(task\);/, "액션 줄을 즉시 그려야 한다 — 퀴즈 통과를 기다리면 안 된다");
});

test("[승인] 클릭은 checkQuizThenApprove 를 거치고, [보완 요청] 클릭은 퀴즈를 아예 안 거친다", () => {
  const start = html.indexOf("function renderActions(task) {");
  const end = html.indexOf("// 승인 버튼을 눌렀을 때만 퀴즈 통과 여부를 확인한다");
  assert.ok(start !== -1 && end !== -1 && end > start, "renderActions 또는 checkQuizThenApprove 경계를 못 찾았다");
  const body = html.slice(start, end);

  assert.match(
    body,
    /if \(a\.action === "request_revision"\) \{\s*openReasonInput\(task\);\s*return;\s*\}/,
    "보완 요청은 openReasonInput 으로 바로 가야 한다 — 퀴즈를 거치면 서버 정책(request_revision 미검사)과 어긋난다"
  );
  assert.match(
    body,
    /checkQuizThenApprove\(task, Array\.prototype\.slice\.call\(actionRow\.querySelectorAll\("button"\)\)\);/,
    "승인 버튼 클릭이 checkQuizThenApprove 를 거치지 않으면, 퀴즈 미통과 상태에서도 승인이 그대로 나가 서버 409(quiz-not-passed) 로만 뒤늦게 걸린다"
  );
  assert.doesNotMatch(
    body.slice(body.indexOf('"request_revision"'), body.indexOf('"request_revision"') + 120),
    /checkQuizThenApprove/,
    "보완 요청 분기 안에 퀴즈 확인이 섞여 있으면 원래 버그가 재발한다"
  );
});

test("checkQuizThenApprove: 퀴즈가 없거나 통과했으면 즉시 제출하고, 안 통과했으면 퀴즈를 보여준다", async () => {
  const match = new RegExp("function checkQuizThenApprove\\(task, buttons\\) \\{([\\s\\S]*?)\\n  \\}").exec(html);
  assert.ok(match, "checkQuizThenApprove 함수를 index.html 에서 찾지 못했다");
  const body = match[1];

  const calls = [];
  const stubs = {
    actionRow: { hidden: false },
    detailHint: { hidden: false },
    currentQuizTaskId: "t1",
    apiFetch: (path) => {
      calls.push(path);
      if (path.includes("taskId=passed-task")) return Promise.resolve({ hasQuiz: true, passed: true });
      if (path.includes("taskId=no-quiz-task")) return Promise.resolve({ hasQuiz: false, passed: false });
      return Promise.resolve({ hasQuiz: true, passed: false, questions: [{ q: "q1", choices: ["a", "b"], correct: 0 }] });
    },
    renderQuiz: (...args) => calls.push(["renderQuiz", ...args]),
    submitDecision: (...args) => calls.push(["submitDecision", ...args])
  };

  const fn = new Function(
    "task", "buttons", "actionRow", "detailHint", "apiFetch", "renderQuiz", "submitDecision",
    "var currentQuizTaskId = task.taskId;\n" + body
  );

  // checkQuizThenApprove 는 (다른 클릭 핸들러들과 마찬가지로) 반환값 없이
  // apiFetch(...).then(...) 을 그 자리에서 실행만 시킨다 — 완료를 기다리려면
  // 마이크로태스크가 다 돌 때까지 한 틱 흘려보내야 한다.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const buttons1 = [{ disabled: false }];
  fn({ taskId: "passed-task" }, buttons1, stubs.actionRow, stubs.detailHint, stubs.apiFetch, stubs.renderQuiz, stubs.submitDecision);
  await flush();
  assert.equal(buttons1[0].disabled, true, "조회 중에는 중복 클릭을 막아야 한다");
  assert.ok(
    calls.some((c) => Array.isArray(c) && c[0] === "submitDecision"),
    "퀴즈를 이미 통과했으면 바로 제출해야 한다"
  );
  assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "renderQuiz"), "통과한 퀴즈를 다시 보여주면 안 된다");

  calls.length = 0;
  const buttons2 = [{ disabled: false }];
  fn({ taskId: "unpassed-task" }, buttons2, stubs.actionRow, stubs.detailHint, stubs.apiFetch, stubs.renderQuiz, stubs.submitDecision);
  await flush();
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === "renderQuiz"), "미통과 퀴즈는 승인 클릭 시점에 보여줘야 한다");
  assert.ok(!calls.some((c) => Array.isArray(c) && c[0] === "submitDecision"), "미통과 퀴즈 상태에서 그대로 제출하면 안 된다");
});

test("checkQuizThenApprove: 퀴즈 조회가 실패하는 동안 다른 작업을 열었으면, 실패해도 이전 작업을 승인하지 않는다", async () => {
  // V2(codex) 검증에서 지적된 경쟁 조건 — .then() 분기는 currentQuizTaskId 로 stale
  // 요청을 걸렀지만 .catch() 분기는 안 걸러서, 조회 실패 시점에 이미 다른 작업을 열었어도
  // 예전 작업이 그대로 final_approve 로 제출될 수 있었다.
  const match = new RegExp("function checkQuizThenApprove\\(task, buttons\\) \\{([\\s\\S]*?)\\n  \\}").exec(html);
  assert.ok(match, "checkQuizThenApprove 함수를 index.html 에서 찾지 못했다");
  const body = match[1];

  const calls = [];
  const submitDecision = (...args) => calls.push(["submitDecision", ...args]);
  const renderQuiz = (...args) => calls.push(["renderQuiz", ...args]);
  const apiFetch = () => Promise.reject(new Error("network down"));
  const actionRow = { hidden: false };
  const detailHint = { hidden: false };

  // currentQuizTaskId 를 요청 대상(task.taskId="stale-task")과 다르게 고정해,
  // "조회가 끝나기 전에 사용자가 다른 작업을 열었다"를 재현한다.
  const fn = new Function(
    "task", "buttons", "actionRow", "detailHint", "apiFetch", "renderQuiz", "submitDecision",
    "var currentQuizTaskId = \"different-task\";\n" + body
  );

  const buttons = [{ disabled: false }];
  fn({ taskId: "stale-task" }, buttons, actionRow, detailHint, apiFetch, renderQuiz, submitDecision);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 0, "조회 실패 콜백에서도 currentQuizTaskId 가 다르면 아무것도 제출하면 안 된다");
});
