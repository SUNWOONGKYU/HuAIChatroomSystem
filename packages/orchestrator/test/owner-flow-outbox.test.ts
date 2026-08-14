import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { handleTelegramInput } from "../src/index.js";

test("owner verify command routes an auditor bot message", () => {
  const result = handleTelegramInput(
    { kind: "command", envelope: envelope("/verify task-1"), command: { name: "/verify", args: ["task-1"] } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_verification_requested");
  assert.equal(result.outbox[0]?.target.kind, "telegram_bot");
  assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "auditor");
  assert.match(String(result.outbox[0]?.payload.text), /검증 요청: task-1/);
});

test("reverify callback routes an auditor bot message", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "task:task-1:reverify"), callback: { entity: "task", entityId: "task-1", action: "reverify" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_reverification_requested");
  assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "auditor");
  assert.match(String(result.outbox[0]?.payload.text), /재검증 요청: task-1/);
});

test("final approve callback routes platoon leader completion message", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "task:task-1:final_approve"), callback: { entity: "task", entityId: "task-1", action: "final_approve" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_final_approved");
  assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "platoon_leader");
  assert.match(String(result.outbox[0]?.payload.text), /최종 승인 완료: task-1/);
});

test("mention message strips leader mention and creates a structured proposal", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot build the mention router") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "proposal_created");
  assert.equal(result.events[0]?.payload.rawText, "build the mention router");
  assert.equal(result.events[0]?.payload.intent, "new_task");
  const proposalText = String(result.outbox[0]?.payload.text);
  assert.match(proposalText, /작업 제안/);
  assert.match(proposalText, /작업:/);
  assert.match(proposalText, /처리:/);
  assert.match(proposalText, /완료:/);
  assert.doesNotMatch(proposalText, /버튼:/);
  assert.doesNotMatch(proposalText, /build the mention router/);
});
test("multi AI mention creates collaboration proposal", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot ClaudeBot과 CodexBot이 각각 의견 내고 AuditBot이 검증해서 결론 내줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "proposal_created");
  assert.equal(result.events[0]?.payload.intent, "multi_ai_review");
  const proposalText = String(result.outbox[0]?.payload.text);
  assert.match(proposalText, /작업 제안/);
  assert.match(proposalText, /ClaudeBot과 CodexBot/);
  assert.match(proposalText, /AuditBot/);
});

test("leader mention stores Claude execution actor hint", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 클로드 분대장 불러서 상태 확인해") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "proposal_created");
  assert.equal(result.events[0]?.payload.requestedActorRole, "claude_leader");
});

test("bare continuation mention asks for task clarification", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 계속해") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events.length, 0);
  assert.match(String(result.outbox[0]?.payload.text), /어느 작업을 이어갈지/);
});

test("vague actor delegation asks for concrete work instead of creating a proposal", () => {
  for (const text of ["@platoon_bot 그러면 코덱스에게 시켜", "@platoon_bot 그러면 코덱스에게 작업시켜"]) {
    const result = handleTelegramInput(
      { kind: "message", envelope: envelope(text) },
      ownerContext(),
      ports()
    );

    assert.equal(result.accepted, true);
    assert.equal(result.events.length, 0);
    assert.match(String(result.outbox[0]?.payload.text), /CodexBot에게 넘길 작업 내용/);
  }
});
test("context-dependent error fix request asks for the missing error context", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 이거 오류 해결해") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events.length, 0);
  assert.match(String(result.outbox[0]?.payload.text), /어떤 오류인지 확인할 수 없습니다/);
  assert.match(String(result.outbox[0]?.payload.text), /오류 메시지/);
});
test("explicit proposal continuation becomes a follow-up proposal", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot proposal_abc-123 계속해") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "proposal_created");
  assert.equal(result.events[0]?.payload.intent, "task_followup");
  assert.equal(result.events[0]?.payload.targetId, "proposal_abc-123");
  assert.match(String(result.outbox[0]?.payload.text), /후속 작업 제안/);
});

function envelope(messageText?: string, callbackData?: string, botRole: "platoon_leader" | "claude_leader" | "codex_leader" | "auditor" = "platoon_leader", botUsername = "platoon_bot"): TelegramUpdateEnvelope {
  return new TelegramUpdateEnvelope(
    `bot-${botRole}`,
    botUsername,
    botRole,
    "77",
    "1001",
    "7001",
    "2001",
    false,
    messageText,
    callbackData
  );
}

function ownerContext() {
  return {
    memberships: [
      {
        telegramChatId: "1001",
        telegramUserId: "2001",
        role: "owner" as const,
        permissions: [],
        status: "active" as const
      }
    ]
  };
}

function ports() {
  return {
    makeId(prefix: string) {
      return `${prefix}-1`;
    },
    now() {
      return "2026-08-10T00:00:00.000Z";
    },
    executionDefaults: {
      roomId: "room-1",
      actorId: "actor-codex",
      adapterType: "codex" as const,
      projectPath: "C:\\Dev\\HuAIChatroomSystem",
      timeoutMs: 600000,
      gatewayId: "gateway-1"
    }
  };
}


test("owner verify command also enqueues auditor execution", () => {
  const result = handleTelegramInput(
    { kind: "command", envelope: envelope("/verify task-1"), command: { name: "/verify", args: ["task-1"] } },
    ownerContext(),
    ports()
  );
  assert.equal(result.accepted, true);
  assert.equal(result.outbox.length, 2);
  assert.equal(result.outbox[1]?.target.kind, "local_gateway");
  const request = result.outbox[1]?.payload.executionRequest as { adapterType: string; reportBotRole: string; prompt: string };
  assert.equal(request.adapterType, "codex");
  assert.equal(request.reportBotRole, "auditor");
  assert.match(request.prompt, /독립 감사자/);
});

test("auditor bot freeform message enqueues direct audit execution", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@audit_chatroom_bot 보안 점검해줘", undefined, "auditor", "audit_chatroom_bot") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_verification_requested");
  assert.equal(result.events[0]?.payload.rawText, "보안 점검해줘");
  assert.equal(result.outbox.length, 2);
  assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "auditor");
  assert.equal(result.outbox[1]?.target.kind, "local_gateway");
  const request = result.outbox[1]?.payload.executionRequest as { adapterType: string; reportBotRole: string; prompt: string };
  assert.equal(request.adapterType, "codex");
  assert.equal(request.reportBotRole, "auditor");
  assert.match(request.prompt, /보안 점검해줘/);
});

test("owner approval immediately posts execution-started message before gateway execution", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "proposal:proposal-1:approve"), callback: { entity: "proposal", entityId: "proposal-1", action: "approve" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_task_approved");
  assert.equal(result.outbox.length, 2);
  assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "platoon_leader");
  assert.match(String(result.outbox[0]?.payload.text), /작업 실행을 시작했습니다/);
  assert.match(String(result.outbox[0]?.payload.text), /AI 작업자를 배정/);
  assert.equal(result.outbox[1]?.target.kind, "local_gateway");
});

test("system improvement request becomes multi AI review", () => {
  const result = handleTelegramInput({ kind: "message", envelope: envelope("@platoon_bot 추가로 개선할 사항을 찾는 작업이다.") }, ownerContext(), ports());
  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.payload.intent, "multi_ai_review");
  assert.equal(result.events[0]?.payload.title, "개선 사항 도출");
  const proposalText = String(result.outbox[0]?.payload.text);
  assert.match(proposalText, /작업: 개선 사항 도출/);
  assert.match(proposalText, /개선 후보/);
  assert.doesNotMatch(proposalText, /AI 협의/);
});

test("task list command includes structured DB query payload", () => {
  const result = handleTelegramInput(
    { kind: "command", envelope: envelope("/tasks"), command: { name: "/tasks", args: [] } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.deepEqual(result.outbox[0]?.payload.query, { kind: "tasks", limit: 10 });
});

test("task detail command includes structured DB query payload", () => {
  const result = handleTelegramInput(
    { kind: "command", envelope: envelope("/task task-123"), command: { name: "/task", args: ["task-123"] } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.deepEqual(result.outbox[0]?.payload.query, { kind: "task", taskId: "task-123" });
});


test("task search command includes structured DB query payload", () => {
  const result = handleTelegramInput(
    { kind: "command", envelope: envelope("/search 버튼"), command: { name: "/search", args: ["버튼"] } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.deepEqual(result.outbox[0]?.payload.query, { kind: "search", term: "버튼" });
});


test("task trace command includes structured DB query payload", () => {
  const result = handleTelegramInput(
    { kind: "command", envelope: envelope("/trace 22222222-2222-4222-8222-222222222222"), command: { name: "/trace", args: ["22222222-2222-4222-8222-222222222222"] } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.deepEqual(result.outbox[0]?.payload.query, { kind: "trace", taskId: "22222222-2222-4222-8222-222222222222" });
});

test("leader mention informational question answers without proposal buttons", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 설명문 관계도 흐름도 여기 채팅장에 띄워 줄 수 있나?") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events.length, 0);
  assert.equal(result.outbox.length, 1);
  const text = String(result.outbox[0]?.payload.text);
  assert.match(text, /가능합니다/);
  assert.equal(text.includes("/trace <task_id>"), true);
  assert.doesNotMatch(text, /작업 제안/);
  assert.equal(result.outbox[0]?.payload.keyboard, undefined);
});
