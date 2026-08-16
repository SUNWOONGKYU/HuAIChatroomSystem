import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { deriveProposalStructure, handleTelegramInput } from "../src/index.js";

// FR-007 / AC-03: 제안은 목적·범위·완료 조건으로 구조화되어야 한다.
// 완료 조건이 특히 중요하다 — 검증자가 무엇으로 합격/불합격을 판정할지가 여기서 정해진다.

test("완료 조건은 어떤 요청에서도 비어 있지 않다", () => {
  const inputs = [
    "로그인 세션 만료 버그를 고쳐줘",
    "왜 안 되는지 원인 좀 알아봐",
    "운영 문서 정리해줘",
    "이 코드 검토해줘",
    "알림 기능 추가해줘",
    "그거 해줘"
  ];
  for (const text of inputs) {
    const structure = deriveProposalStructure(text, "요청 처리");
    assert.equal(structure.completionCriteria.trim().length > 0, true, text);
    assert.equal(structure.scope.trim().length > 0, true, text);
    assert.equal(structure.purpose.trim().length > 0, true, text);
  }
});

test("요청자가 완료 조건을 직접 말하면 그것을 쓴다", () => {
  const structure = deriveProposalStructure("로그인 버그 고쳐줘. 재현 안 되면 완료", "장애 원인 수정");
  assert.match(structure.completionCriteria, /재현 안 되면 완료로 본다/);
});

test("테스트 통과 요구는 완료 조건으로 인식된다", () => {
  const structure = deriveProposalStructure("리팩터링하고 테스트 통과시켜줘", "수정 작업");
  assert.match(structure.completionCriteria, /테스트와 빌드가 통과/);
});

test("요청 종류별로 다른 완료 조건이 도출된다", () => {
  const bug = deriveProposalStructure("결제가 안 되는 오류를 고쳐줘", "장애 원인 수정");
  const research = deriveProposalStructure("이 지연의 원인을 분석해줘", "요청 처리");
  const docs = deriveProposalStructure("운영 문서를 작성해줘", "문서 및 다이어그램 갱신");
  const feature = deriveProposalStructure("알림 기능을 구현해줘", "구현 작업");

  assert.match(bug.completionCriteria, /재현되지 않고/);
  assert.match(research.completionCriteria, /조사 결과와 근거/);
  assert.match(docs.completionCriteria, /문서가 생성·갱신/);
  assert.match(feature.completionCriteria, /실제로 실행되어 확인/);
  // 서로 달라야 의미가 있다 — 전부 같은 문자열이면 구조화가 아니다.
  assert.equal(new Set([bug, research, docs, feature].map((s) => s.completionCriteria)).size, 4);
});

test("목적을 직접 말하면 그 절을 목적으로 쓴다", () => {
  const structure = deriveProposalStructure("배포 시간을 줄이기 위해 빌드 캐시를 붙여줘", "구현 작업");
  assert.match(structure.purpose, /배포 시간을 줄이기 위해/);
});

test("목적을 말하지 않으면 첫 문장이나 제목으로 대체한다", () => {
  const structure = deriveProposalStructure("알림 기능 추가해줘", "구현 작업");
  assert.equal(structure.purpose.length > 0, true);
  assert.equal(structure.purpose === structure.completionCriteria, false);
});

test("범위는 요청 원문을 보존한다", () => {
  const text = "결제 모듈의 재시도 횟수를 3회로 바꿔줘";
  assert.equal(deriveProposalStructure(text, "수정 작업").scope, text);
});

test("빈 요청도 구조를 잃지 않는다", () => {
  const structure = deriveProposalStructure("", "새 작업");
  assert.equal(structure.purpose, "새 작업");
  assert.equal(structure.scope, "새 작업");
  assert.equal(structure.completionCriteria.length > 0, true);
});

// 제목 식별력 회귀 — 라이브에서 나온 실제 결함.
//
// 한 방의 제안 150건이 제목 66개로 뭉쳤다. 원인은 요청을 13개 고정 라벨 중 하나에
// 떨어뜨리던 키워드 사다리였다. "요청 처리" 25건, "Telegram 사용자 경험 개선" 6건이
// 작업 현황판에 나란히 쌓여 서로 구분이 안 됐다. 아래 문구들은 그때 실제로 같은 라벨로
// 뭉갰던 요청들이다 — 서로 다른 제목이 나와야 한다.
test("서로 다른 요청은 서로 다른 제목을 받는다 (고정 라벨 뭉침 회귀)", () => {
  const requests = [
    "좋았어. 그러면 그 작업해 봐",
    "실행 버튼이 눌러지지도 않고 작업도 안 되고 있어",
    "로그인 세션이 반복적으로 풀리는 문제의 원인 파악",
    "최근 커밋 3개 요약",
    "방 가동 봇 개수 확인 및 보고"
  ];
  const titles = requests.map((text) => titleOf(text));

  assert.equal(new Set(titles).size, requests.length, `제목이 뭉쳤다: ${titles.join(" / ")}`);
  for (const title of titles) {
    assert.equal(title, title.trim());
    assert.equal(title.length > 0, true);
  }
});

test("제목은 요청자의 말에서 나온다 — 분류 라벨로 갈아치우지 않는다", () => {
  // 예전 사다리가 "버튼"만 보고 "Telegram 사용자 경험 개선"으로 바꿔치기하던 요청.
  const title = titleOf("실행 버튼이 눌러지지도 않고 작업도 안 되고 있어");
  assert.match(title, /실행 버튼/);
  assert.equal(title.includes("Telegram 사용자 경험 개선"), false);
});

test("긴 요청은 잘리되 어디서 잘렸는지 보인다", () => {
  const long = "배포 파이프라인에서 캐시가 무효화되지 않아 이전 빌드 산출물이 그대로 나가는 문제를 조사하고 원인을 규명한 다음 재발 방지책까지 함께 보고";
  const title = titleOf(long);

  assert.equal(title.length <= 61, true, `제목이 너무 길다(${title.length}): ${title}`);
  assert.equal(title.endsWith("…"), true);
  assert.match(title, /^배포 파이프라인/);
});

test("빈 요청은 제목 자리를 비워두지 않는다", () => {
  assert.equal(titleOf(""), "새 작업");
  assert.equal(titleOf("   "), "새 작업");
  // 요청이 어미뿐이면(필러 제거 후 남는 게 없으면) 같은 자리를 지킨다.
  assert.equal(titleOf("해줘"), "새 작업");
});

// summarizeTitle 은 내보내지 않는다. 실제 경로(/newtask → createProposalFromTelegram)가
// payload 에 싣는 title 을 그대로 읽어야 "테스트는 통과하는데 화면은 그대로"를 막을 수 있다.
function titleOf(text: string): string {
  const args = text.trim() ? text.trim().split(/\s+/) : [];
  const result = handleTelegramInput(
    { kind: "command", envelope: proposalEnvelope(`/newtask ${text}`), command: { name: "/newtask", args } },
    {
      memberships: [
        { telegramChatId: "1001", telegramUserId: "2001", role: "owner" as const, permissions: [], status: "active" as const }
      ]
    },
    {
      makeId: (prefix: string) => `${prefix}-1`,
      now: () => "2026-08-10T00:00:00.000Z",
      executionDefaults: {
        roomId: "room-1",
        actorId: "actor-codex",
        adapterType: "codex" as const,
        projectPath: "C:\\Dev\\HuAIChatroomSystem",
        timeoutMs: 600000,
        gatewayId: "gateway-1"
      }
    }
  );

  assert.equal(result.accepted, true, `제안이 만들어지지 않았다: ${text}`);
  const event = result.accepted ? result.events.find((e) => e.eventType === "proposal_created") : undefined;
  assert.ok(event, `proposal_created 이벤트가 없다: ${text}`);
  return String((event.payload as Record<string, unknown>).title);
}

function proposalEnvelope(messageText: string): TelegramUpdateEnvelope {
  return new TelegramUpdateEnvelope(
    "bot-platoon_leader",
    "platoon_bot",
    "platoon_leader",
    "77",
    "1001",
    "7001",
    "2001",
    false,
    messageText,
    undefined,
    undefined,
    undefined,
    undefined,
    []
  );
}
