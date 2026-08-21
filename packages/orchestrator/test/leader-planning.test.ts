import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLeaderPlanningPrompt,
  executionRolesForAssignee,
  extractPersonaTag,
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
  assert.equal(decision.plan.variantCount, 1, "VARIANTS 를 안 쓰면 변형 없음(1)이어야 한다");
});

test("VARIANTS 를 명시하면 변형 개수로 파싱한다", () => {
  const decision = parseLeaderDecision([
    "DECISION: plan",
    "TITLE: 랜딩페이지 시안",
    "PURPOSE: 방향 비교",
    "SCOPE: 서로 다른 세 가지 톤으로",
    "DONE: 셋 다 배포된 링크로 확인 가능",
    "ASSIGNEE: claude_leader",
    "REASON: 정적 페이지 생성",
    "VARIANTS: 3"
  ].join("\n"));

  assert.equal(decision?.kind, "plan");
  if (decision?.kind !== "plan") return;
  assert.equal(decision.plan.variantCount, 3);
});

test("VARIANTS 가 4를 넘으면 4로 자른다 — 비용 폭주를 코드가 최종 방어한다", () => {
  const decision = parseLeaderDecision(
    ["DECISION: plan", "TITLE: t", "SCOPE: s", "DONE: d", "ASSIGNEE: codex_leader", "VARIANTS: 999"].join("\n")
  );
  assert.equal(decision?.kind, "plan");
  if (decision?.kind !== "plan") return;
  assert.equal(decision.plan.variantCount, 4);
});

test("VARIANTS 가 숫자가 아니거나 1 이하면 변형 없음으로 취급한다", () => {
  for (const bad of ["없음", "0", "-1", ""]) {
    const decision = parseLeaderDecision(
      ["DECISION: plan", "TITLE: t", "SCOPE: s", "DONE: d", "ASSIGNEE: codex_leader", `VARIANTS: ${bad}`].join("\n")
    );
    assert.equal(decision?.kind, "plan");
    if (decision?.kind !== "plan") continue;
    assert.equal(decision.plan.variantCount, 1, `VARIANTS: ${bad} 은 1이어야 한다`);
  }
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

// 방장·Fable 5 지적 — 소대장은 최근 40턴만 본다. 그 창 밖은 아예 몰라서 "3주 전에 왜
// 그렇게 정했지"에 답을 못 하고, 이미 끝난 작업을 새로 제안한다(라이브에서 달걀 게임).
test("지난 기록이 있으면 프롬프트에 실린다", () => {
  const prompt = buildLeaderPlanningPrompt({
    turns: [{ speaker: "방장", text: "지금 뭐 하지", isOwner: true }],
    triggeringText: "지금 뭐 하지",
    facts: {
      bots: ["ClaudeBot"],
      memberCount: 2,
      openTasks: [],
      memory: [
        { date: "2026-08-15", summary: "달걀깨기 게임 사운드 버전 완료. 점수 표시는 이미 붙어 있었다." },
        { date: "2026-08-16", summary: "3단 폴백 종주 완료." }
      ]
    }
  });

  assert.match(prompt, /지난 기록/);
  assert.match(prompt, /2026-08-15/);
  assert.match(prompt, /달걀깨기 게임 사운드 버전 완료/);
  // 끝난 일을 다시 제안하는 것이 이 기능이 막으려는 실제 실패다.
  assert.match(prompt, /이미 끝난 일을 새 작업으로 제안하지 마라/);
});

test("지난 기록이 없으면 그 자리를 비운다", () => {
  const prompt = buildLeaderPlanningPrompt({
    turns: [{ speaker: "방장", text: "뭐 해줘", isOwner: true }],
    triggeringText: "뭐 해줘",
    facts: { bots: ["ClaudeBot"], memberCount: 2, openTasks: [] }
  });

  assert.equal(prompt.includes("지난 기록"), false, "빈 칸을 만들면 모델이 채워 넣으려 든다");
});

test("지난 기록은 최근 대화와 구분된 자리에 놓인다", () => {
  // 섞이면 오래된 결정을 지금 지시로 착각해 엉뚱한 작업을 만든다.
  const prompt = buildLeaderPlanningPrompt({
    turns: [{ speaker: "방장", text: "새 지시다", isOwner: true }],
    triggeringText: "새 지시다",
    facts: { bots: [], memberCount: 1, openTasks: [], memory: [{ date: "2026-08-01", summary: "옛 결정" }] }
  });

  assert.equal(prompt.indexOf("지난 기록 끝") < prompt.indexOf("새 지시다"), true, "지난 기록이 최근 논의보다 앞에 와야 한다");
});

// 라이브 결함 — DCF 방에 "점검 파일 만들어줘"만 시켰는데 제안 제목이
// "README 줄 수 확인 + 점검 파일 생성"으로 나왔다. 지난 기록에 있던 옛 작업이 이번 범위에
// 딸려 들어갔다. 기록은 참고지 할 일 목록이 아니다.
test("지난 기록이 이번 작업 범위로 딸려 들어가지 않게 못박는다", () => {
  const prompt = buildLeaderPlanningPrompt({
    turns: [{ speaker: "방장", text: "점검 파일 만들어줘", isOwner: true }],
    triggeringText: "점검 파일 만들어줘",
    facts: {
      bots: ["ClaudeBot"],
      memberCount: 2,
      openTasks: [],
      memory: [{ date: "2026-08-16", summary: "README 줄 수 조사 작업을 했다." }]
    }
  });

  assert.match(prompt, /지난 기록은 맥락일 뿐이다/);
  assert.match(prompt, /이번 작업의 범위에는 지금 요청에서 나온 것만 담아라/);
});

// 텔레그램은 봇 API로 새 봇 계정을 못 만든다 — 그래서 "새 에이전트"는 "!이름 지시" 태그로
// 기존 봇 위의 페르소나를 부르는 방식으로 구현했다.
test("!페르소나이름 지시 형태에서 이름과 나머지 지시문을 뽑아낸다", () => {
  const tag = extractPersonaTag("!연구원 최신 AI 트렌드 조사해줘");
  assert.deepEqual(tag, { personaName: "연구원", remainingText: "최신 AI 트렌드 조사해줘" });
});

test("페르소나 태그가 없으면 undefined 다", () => {
  assert.equal(extractPersonaTag("로그인 버그 고쳐줘"), undefined);
  assert.equal(extractPersonaTag("!"), undefined, "이름 없이 느낌표만 있으면 태그가 아니다");
  assert.equal(extractPersonaTag("!연구원"), undefined, "지시문 없이 이름만 있으면 태그가 아니다");
});

test("페르소나가 지목되면 프롬프트에 담당·지시가 실리고 ASSIGNEE 를 못박는다", () => {
  const prompt = buildLeaderPlanningPrompt({
    turns: [],
    triggeringText: "최신 AI 트렌드 조사해줘",
    persona: { name: "연구원", baseRole: "claude_leader", instructions: "업계 동향을 조사하고 요약해서 보고한다" }
  });

  assert.match(prompt, /등록된 페르소나 "연구원"를 지목했다/);
  assert.match(prompt, /업계 동향을 조사하고 요약해서 보고한다/);
  assert.match(prompt, /ASSIGNEE 는 반드시 claude_leader로 정하라/);
});

test("페르소나가 없으면 그 문단 자체가 프롬프트에 없다", () => {
  const prompt = buildLeaderPlanningPrompt({ turns: [], triggeringText: "로그인 버그 고쳐줘" });
  assert.doesNotMatch(prompt, /지목했다/);
});
