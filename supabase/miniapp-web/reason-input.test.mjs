// index.html 의 [보완 요청] 사유 입력 UI 회귀 테스트.
//
// resolve-room-id.test.mjs 와 같은 이유로 같은 기법을 쓴다: index.html 은 빌드 없는
// 자기완결 파일이라 TypeScript 테스트 파이프라인이 안 닿는다. 손으로 베낀 사본을
// 테스트하면 index.html 이 나중에 바뀌었을 때 몰래 어긋날 수 있어서, 실제 파일 텍스트에서
// 함수 정의를 정규식으로 그대로 뽑아 실행하거나(순수 로직), DOM 을 안 쓰는 부분은 소스
// 텍스트 자체를 정적으로 검사한다(부팅 없이는 실행할 수 없는 이벤트 배선 부분).
//
// 실행: node --test supabase/miniapp-web/reason-input.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");

function extractFunction(source, signature) {
  const match = new RegExp(`function ${signature} \\{([\\s\\S]*?)\\n  \\}`).exec(source);
  if (!match) {
    throw new Error(`${signature} 함수를 index.html 에서 찾지 못했다 — 시그니처가 바뀌었으면 이 테스트의 정규식도 같이 고쳐야 한다.`);
  }
  return match[1];
}

// ── 1. 순수 로직 함수 추출 실행 ──

test("decisionSuccessNote: task 경로의 보완 요청은 사유가 전달된다고 정직하게 말한다", () => {
  const body = extractFunction(html, "decisionSuccessNote\\(action, res, kind\\)");
  const decisionSuccessNote = new Function("action", "res", "kind", body);

  assert.match(decisionSuccessNote("request_revision", {}, "task"), /사유가 방과 담당자에게 함께 전달됩니다/);
});

test("decisionSuccessNote: proposal 경로(제안 '수정')는 여전히 사유가 안 닿는다고 말한다 — 이번 범위 밖", () => {
  const body = extractFunction(html, "decisionSuccessNote\\(action, res, kind\\)");
  const decisionSuccessNote = new Function("action", "res", "kind", body);

  assert.match(decisionSuccessNote("request_revision", {}, "proposal"), /협업 운영센터에서 확인하고 처리합니다/);
});

test("decisionSuccessNote: 그 외 액션은 서버 note 를 그대로 쓰거나 기본 문구로 떨어진다", () => {
  const body = extractFunction(html, "decisionSuccessNote\\(action, res, kind\\)");
  const decisionSuccessNote = new Function("action", "res", "kind", body);

  assert.equal(decisionSuccessNote("final_approve", { note: "서버가 준 문구" }, "task"), "서버가 준 문구");
  assert.equal(decisionSuccessNote("approve", {}, "proposal"), "결정이 기록되었습니다.");
});

test("updateReasonCount: 공백만 있으면 보내기 버튼을 비활성화하고, 글자 수를 보여준다", () => {
  const body = extractFunction(html, "updateReasonCount\\(\\)");
  // 함수 몸통이 참조하는 자유 변수(reasonInput/reasonCount/reasonSendBtn/REASON_MAX_LENGTH)를
  // 그대로 매개변수 이름으로 받아, 실제 배포되는 이 로직을 가짜 DOM 요소로 실행한다.
  const updateReasonCount = new Function("reasonInput", "reasonCount", "reasonSendBtn", "REASON_MAX_LENGTH", body);

  const whitespaceOnly = { reasonInput: { value: "   " }, reasonCount: { textContent: "" }, reasonSendBtn: { disabled: false } };
  updateReasonCount(whitespaceOnly.reasonInput, whitespaceOnly.reasonCount, whitespaceOnly.reasonSendBtn, 2000);
  assert.equal(whitespaceOnly.reasonSendBtn.disabled, true, "공백만 있으면 보내기가 비활성화돼야 한다");
  assert.equal(whitespaceOnly.reasonCount.textContent, "3 / 2000");

  const filled = { reasonInput: { value: "로그인 버튼 색이 다릅니다" }, reasonCount: { textContent: "" }, reasonSendBtn: { disabled: true } };
  updateReasonCount(filled.reasonInput, filled.reasonCount, filled.reasonSendBtn, 2000);
  assert.equal(filled.reasonSendBtn.disabled, false, "실제 내용이 있으면 보내기가 활성화돼야 한다");

  const empty = { reasonInput: { value: "" }, reasonCount: { textContent: "" }, reasonSendBtn: { disabled: false } };
  updateReasonCount(empty.reasonInput, empty.reasonCount, empty.reasonSendBtn, 2000);
  assert.equal(empty.reasonSendBtn.disabled, true);
  assert.equal(empty.reasonCount.textContent, "0 / 2000");
});

// ── 2. 마크업/배선 정적 검사(DOM 부팅 없이는 실행 불가능한 부분) ──

test("사유 입력란 마크업이 있고, 서버 상한(2000자)과 일치하는 maxlength 를 갖는다", () => {
  assert.match(html, /<div class="field" id="reason-section" hidden>/, "사유 섹션이 기본적으로 숨겨져 있어야 한다(누르기 전엔 안 보임)");
  assert.match(html, /<textarea id="reason-input"[^>]*maxlength="2000"[^>]*>/, "textarea 의 maxlength 가 handler.ts 의 2000자 상한과 어긋난다");
  assert.match(html, /<button type="button" class="btn btn-accent" id="reason-send-btn" disabled>보내기<\/button>/, "보내기 버튼은 처음엔(빈 입력) 비활성 상태여야 한다");
  assert.match(html, /<button type="button" class="btn btn-ghost" id="reason-cancel-btn">취소<\/button>/);
});

test("[보완 요청] 버튼은 바로 전송하지 않고 사유 입력 UI를 먼저 연다", () => {
  const start = html.indexOf("function renderActions(task) {");
  const end = html.indexOf("// ── 보완 요청 사유 입력 ──");
  assert.ok(start !== -1 && end !== -1 && end > start, "renderActions 또는 보완 요청 사유 입력 섹션 경계를 못 찾았다");
  const renderActionsSource = html.slice(start, end);

  assert.match(
    renderActionsSource,
    /if \(a\.action === "request_revision"\) \{\s*openReasonInput\(task\);\s*return;\s*\}/,
    "request_revision 버튼 클릭이 openReasonInput 을 거치지 않고 바로 submitDecision 을 부르면, 사유 없이 전송될 수 있다"
  );
});

test("보내기를 누르면 서버 요청 body 에 reason 이 실린다", () => {
  const start = html.indexOf("function submitDecision(task, action, buttons, reason) {");
  const end = html.indexOf("function decisionSuccessNote(action, res, kind) {");
  assert.ok(start !== -1 && end !== -1 && end > start, "submitDecision 또는 decisionSuccessNote 경계를 못 찾았다");
  const submitDecisionSource = html.slice(start, end);

  assert.match(submitDecisionSource, /if \(reason\) body\.reason = reason;/, "reason 이 있어도 요청 body 에 안 실리면 서버가 받는 사유는 항상 빈 값이다");
});

test("보내기 클릭 핸들러는 공백만 있는 사유를 막고, 있으면 idempotency 재사용 경로(submitDecision)를 그대로 탄다", () => {
  const start = html.indexOf("reasonSendBtn.addEventListener(\"click\"");
  const end = html.indexOf("var submittedKeys = {};");
  assert.ok(start !== -1 && end !== -1 && end > start, "reasonSendBtn 클릭 핸들러 경계를 못 찾았다");
  const handlerSource = html.slice(start, end);

  assert.match(handlerSource, /var reason = reasonInput\.value\.trim\(\);/, "trim 없이 보내면 공백만 있는 사유가 통과한다");
  assert.match(handlerSource, /if \(!reason\) \{/, "빈 사유를 막는 분기가 없다");
  assert.match(
    handlerSource,
    /submitDecision\(reasonTask, "request_revision", \[reasonSendBtn, reasonCancelBtn\], reason\)/,
    "보내기가 기존 submitDecision(중복 클릭 차단·idempotency 키 재사용)을 거치지 않고 새 전송 경로를 만들면 안 된다"
  );
});
