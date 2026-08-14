import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLeaderPlanningPrompt,
  executionRolesForAssignee,
  parseLeaderDecision,
  type RoomTurn
} from "../src/leader-planning.js";

// 소대장 판단 계층. 지금까지 이 자리에는 정규식이 앉아 있었다.

const TURNS: RoomTurn[] = [
  { speaker: "박", text: "결제 실패율이 어제부터 올라간 것 같아", isOwner: false },
  { speaker: "김", text: "재시도 로직 쪽이 의심돼", isOwner: true },
  { speaker: "박", text: "실패한 건들 로그가 제대로 안 남아", isOwner: false }
];

test("프롬프트에 논의 전체와 발언자 구분이 들어간다", () => {
  const prompt = buildLeaderPlanningPrompt({ turns: TURNS, triggeringText: "정리해서 진행해줘" });
  assert.match(prompt, /\[방장\] 재시도 로직/);
  assert.match(prompt, /\[박\] 결제 실패율/);
  assert.match(prompt, /로그가 제대로 안 남아/, "동료가 지적한 항목이 빠지면 안 된다");
  assert.match(prompt, /\[요청\] 정리해서 진행해줘/);
  assert.match(prompt, /빠뜨리지 마라/);
});

test("직전 논의가 없어도 프롬프트가 성립한다", () => {
  const prompt = buildLeaderPlanningPrompt({ turns: [], triggeringText: "로그인 버그 고쳐줘" });
  assert.match(prompt, /직전 논의 없음/);
  assert.match(prompt, /\[요청\] 로그인 버그 고쳐줘/);
});

test("소대장 계획을 파싱한다", () => {
  const decision = parseLeaderDecision(JSON.stringify({
    title: "결제 실패율 진단 및 수정",
    purpose: "실패율 원인 규명 후 재발 방지",
    scope: "재시도 로직 점검, 타임아웃 검토, 로그 누락 수정",
    completionCriteria: "원인 특정, 실패 건 100% 기록, 테스트 통과",
    assignee: "both",
    reason: "분석과 수정이 모두 필요"
  }));
  assert.equal(decision?.kind, "plan");
  if (decision?.kind !== "plan") return;
  assert.equal(decision.plan.title, "결제 실패율 진단 및 수정");
  assert.equal(decision.plan.assignee, "both");
});

test("코드펜스와 앞뒤 설명이 붙어도 살려낸다", () => {
  const raw = [
    "정리했습니다.",
    "```json",
    '{"title":"a","purpose":"b","scope":"c","completionCriteria":"d","assignee":"codex_leader","reason":"e"}',
    "```",
    "확인해 주세요."
  ].join("\n");
  const decision = parseLeaderDecision(raw);
  assert.equal(decision?.kind, "plan");
});

test("소대장이 나설 자리가 아니라고 판단하면 작업을 만들지 않는다", () => {
  const decision = parseLeaderDecision(JSON.stringify({ noAction: "사람끼리 상의 중이라 개입할 단계가 아님" }));
  assert.equal(decision?.kind, "no_action");
  if (decision?.kind !== "no_action") return;
  assert.match(decision.reason, /상의 중/);
});

test("필수 항목이 빠지면 조용히 통과시키지 않는다", () => {
  assert.equal(parseLeaderDecision(JSON.stringify({ title: "a" })), undefined, "완료조건 없는 계획은 무효다");
  assert.equal(parseLeaderDecision(JSON.stringify({ title: "a", scope: "b" })), undefined);
  assert.equal(parseLeaderDecision("전혀 JSON 이 아님"), undefined);
  assert.equal(parseLeaderDecision(""), undefined);
});

test("담당이 이상하면 실행 가능한 기본값으로 떨어진다", () => {
  const decision = parseLeaderDecision(JSON.stringify({
    title: "a", purpose: "b", scope: "c", completionCriteria: "d", assignee: "누구겠지", reason: "e"
  }));
  assert.equal(decision?.kind, "plan");
  if (decision?.kind !== "plan") return;
  assert.equal(decision.plan.assignee, "codex_leader");
});

test("both 는 두 분대장에게 각각 배분된다", () => {
  assert.deepEqual(executionRolesForAssignee("both"), ["claude_leader", "codex_leader"]);
  assert.deepEqual(executionRolesForAssignee("codex_leader"), ["codex_leader"]);
  assert.deepEqual(executionRolesForAssignee("claude_leader"), ["claude_leader"]);
});

// 실전에서 모델이 JSON 여는 따옴표를 빠뜨려 판단이 통째로 유실됐다.
// 한글 산문을 JSON 문자열에 담는 것 자체가 취약해 줄 형식을 1차로 삼는다.

test("줄 형식 계획을 파싱한다", () => {
  const decision = parseLeaderDecision([
    "DECISION: plan",
    "TITLE: 로그인 세션 풀림 원인 조사",
    "PURPOSE: 원인 파악 후 재발 방지",
    "SCOPE: 토큰 발급·갱신·만료, 세션 저장소, 인증 미들웨어 전수 확인",
    "DONE: 원인이 코드 근거(file:line)와 함께 정리됨",
    "ASSIGNEE: claude_leader",
    "REASON: 코드 읽기·분석 위주"
  ].join("\n"));

  assert.equal(decision?.kind, "plan");
  if (decision?.kind !== "plan") return;
  assert.equal(decision.plan.assignee, "claude_leader");
  assert.match(decision.plan.completionCriteria, /코드 근거/);
});

test("여러 줄에 걸친 값을 이어 붙인다", () => {
  const decision = parseLeaderDecision([
    "DECISION: plan",
    "TITLE: 제목",
    "SCOPE: 첫 항목",
    "  둘째 항목도 범위에 포함",
    "DONE: 완료 조건",
    "ASSIGNEE: both"
  ].join("\n"));

  assert.equal(decision?.kind, "plan");
  if (decision?.kind !== "plan") return;
  assert.match(decision.plan.scope, /첫 항목 둘째 항목/);
  assert.equal(decision.plan.assignee, "both");
});

test("줄 형식 answer 와 none", () => {
  const answer = parseLeaderDecision("DECISION: answer\nANSWER: 가능합니다. SVG 로 올릴 수 있습니다.");
  assert.equal(answer?.kind, "answer");

  const none = parseLeaderDecision("DECISION: none\nREASON: 사람끼리 상의 중");
  assert.equal(none?.kind, "no_action");
});

test("따옴표가 깨진 JSON 은 통과시키지 않는다", () => {
  const broken = '{"title":"제목","scope":"범위",completionCriteria":"완료","assignee":"codex_leader"}';
  assert.equal(parseLeaderDecision(broken), undefined, "깨진 출력을 억지로 해석하면 잘못된 작업이 만들어진다");
});

test("완료 조건 없는 줄 형식은 무효다", () => {
  assert.equal(parseLeaderDecision("DECISION: plan\nTITLE: 제목\nSCOPE: 범위"), undefined);
});
