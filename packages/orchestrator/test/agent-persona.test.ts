import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { handleTelegramInput } from "../src/index.js";

// 텔레그램은 봇 API로 새 봇 계정을 못 만든다 — 그래서 "새 에이전트"는 기존 실행 담당
// 봇(claude_leader/codex_leader) 위에 얹는 이름 붙은 페르소나다. /newagent·/agents 는
// DB 를 안 읽는 오케스트레이터 계층이라, 여기서는 outbox payload 에 실리는 표식만 검증한다
// (실제 DB 기록·조회는 apps/bot-service 쪽 hydrateAgentPersonaRows 가 한다).

test("/newagent 유효한 입력이면 agentPersonaCommand 표식을 outbox 에 싣는다", () => {
  const result = handleTelegramInput(
    {
      kind: "command",
      envelope: envelope("/newagent 연구원 claude_leader 최신 AI 트렌드 조사해서 요약"),
      command: { name: "/newagent", args: ["연구원", "claude_leader", "최신", "AI", "트렌드", "조사해서", "요약"] }
    },
    membership(),
    ports()
  );

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const payload = result.outbox[0]?.payload as Record<string, unknown>;
  assert.deepEqual(payload.agentPersonaCommand, {
    action: "create",
    personaName: "연구원",
    baseRole: "claude_leader",
    instructions: "최신 AI 트렌드 조사해서 요약",
    createdByTelegramUserId: "2001"
  });
});

test("/newagent 담당이 claude_leader/codex_leader 가 아니면 사용법만 돌려주고 등록하지 않는다", () => {
  const result = handleTelegramInput(
    {
      kind: "command",
      envelope: envelope("/newagent 연구원 leader 뭔가 한다"),
      command: { name: "/newagent", args: ["연구원", "leader", "뭔가", "한다"] }
    },
    membership(),
    ports()
  );

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const payload = result.outbox[0]?.payload as Record<string, unknown>;
  assert.equal(payload.agentPersonaCommand, undefined, "잘못된 담당이면 DB 에 쓰면 안 된다");
  assert.match(String(payload.text), /사용법/);
});

test("/newagent 할 일 설명이 비어 있으면 등록하지 않는다", () => {
  const result = handleTelegramInput(
    {
      kind: "command",
      envelope: envelope("/newagent 연구원 claude_leader"),
      command: { name: "/newagent", args: ["연구원", "claude_leader"] }
    },
    membership(),
    ports()
  );

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const payload = result.outbox[0]?.payload as Record<string, unknown>;
  assert.equal(payload.agentPersonaCommand, undefined);
});

test("/newagent 이름에 공백·특수문자가 있으면 거부한다", () => {
  const result = handleTelegramInput(
    {
      kind: "command",
      envelope: envelope("/newagent \"이상한:이름\" claude_leader 뭔가 한다"),
      command: { name: "/newagent", args: ['"이상한:이름"', "claude_leader", "뭔가", "한다"] }
    },
    membership(),
    ports()
  );

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const payload = result.outbox[0]?.payload as Record<string, unknown>;
  assert.equal(payload.agentPersonaCommand, undefined);
});

test("/agents 는 목록 조회 표식을 outbox 에 싣는다", () => {
  const result = handleTelegramInput(
    { kind: "command", envelope: envelope("/agents"), command: { name: "/agents", args: [] } },
    membership(),
    ports()
  );

  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  const payload = result.outbox[0]?.payload as Record<string, unknown>;
  assert.deepEqual(payload.agentPersonaCommand, { action: "list" });
});

function envelope(messageText: string): TelegramUpdateEnvelope {
  return new TelegramUpdateEnvelope(
    "bot-leader",
    "leader_bot",
    "leader",
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

function membership() {
  return {
    memberships: [
      { telegramChatId: "1001", telegramUserId: "2001", role: "owner" as const, permissions: [], status: "active" as const }
    ]
  };
}

function ports() {
  return {
    makeId: (prefix: string) => `${prefix}-1`,
    now: () => "2026-08-19T00:00:00.000Z"
  };
}
