import assert from "node:assert/strict";
import test from "node:test";
import { TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { handleTelegramInput,
  isLeaderPlanningAttempt
} from "../src/index.js";

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

test("소대장 멘션은 즉시 제안이 아니라 판단 실행을 요청한다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot build the mention router") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  // 정규식으로 제목을 고르던 자리에 실제 판단이 들어갔다.
  // 방의 직전 논의를 읽고 목적·범위·완료조건·담당을 재구성한 뒤에 제안이 올라간다.
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.ok(gateway, "판단 실행이 게이트웨이로 나가야 한다");
  const request = gateway.payload.executionRequest as { attemptId: string; adapterType: string; reportBotRole: string };
  assert.equal(isLeaderPlanningAttempt(request.attemptId), true);
  assert.equal(request.adapterType, "claude_code");
  assert.equal(request.reportBotRole, "platoon_leader");
  assert.equal(result.events[0]?.payload.stage, "leader_planning_requested");
  assert.equal(result.events[0]?.payload.triggeringText, "build the mention router");
  assert.equal(
    result.outbox.some((item) => item.payload.keyboard),
    false,
    "판단 전에는 승인 버튼을 올리지 않는다"
  );
});

test("다중 AI 요청도 소대장이 판단해 배분한다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot ClaudeBot과 CodexBot이 각각 의견 내고 AuditBot이 검증해서 결론 내줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  // 누구에게 시킬지는 정규식이 봇 이름을 찾는 게 아니라 소대장이 판단한다.
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.ok(gateway, "판단 실행이 게이트웨이로 나가야 한다");
  assert.equal(isLeaderPlanningAttempt((gateway.payload.executionRequest as { attemptId: string }).attemptId), true);
  assert.match(String(gateway.payload.triggeringText), /ClaudeBot과 CodexBot/);
});

test("담당 지목이 있어도 소대장이 판단해 배분한다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot Claude Code로 이 코드 점검해줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  // 예전에는 정규식이 "Claude" 를 찾아 담당을 못박았다.
  // 이제는 요청 원문을 소대장에게 넘기고 소대장이 배분을 판단한다.
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.ok(gateway);
  assert.match(String(gateway.payload.triggeringText), /Claude Code/);
  assert.equal(isLeaderPlanningAttempt((gateway.payload.executionRequest as { attemptId: string }).attemptId), true);
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

test("context-dependent fix request with attachment becomes a work proposal", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 이거 오류 해결해", undefined, "platoon_leader", "platoon_bot", { attachmentKinds: ["photo"] }) },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "proposal_created");
  assert.equal(result.events[0]?.payload.intent, "new_task");
  assert.match(String(result.events[0]?.payload.rawText), /첨부: photo/);
  assert.match(String(result.outbox[0]?.payload.text), /작업 제안/);
});

test("bare continuation reply to a proposal message becomes a follow-up proposal", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("진행해", undefined, "platoon_leader", "platoon_bot", { replyToMessageText: "작업 실행을 시작했습니다: proposal_abc-123" }) },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "proposal_created");
  assert.equal(result.events[0]?.payload.intent, "task_followup");
  assert.equal(result.events[0]?.payload.targetId, "proposal_abc-123");
  assert.match(String(result.outbox[0]?.payload.text), /후속 작업 제안/);
});

test("context-dependent fix request reply to a proposal message becomes a follow-up proposal", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("이거 오류 해결해", undefined, "platoon_leader", "platoon_bot", { replyToMessageText: "작업 실행을 시작했습니다: proposal_abc-123" }) },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "proposal_created");
  assert.equal(result.events[0]?.payload.intent, "task_followup");
  assert.equal(result.events[0]?.payload.targetId, "proposal_abc-123");
});

test("caption text and reply context are parsed from Telegram updates", () => {
  const parsed = TelegramUpdateEnvelope.parse("bot-platoon", "platoon_bot", "platoon_leader", {
    update_id: 77,
    message: {
      message_id: 7001,
      chat: { id: 1001 },
      from: { id: 2001, is_bot: false },
      caption: "@platoon_bot 이거 오류 해결해",
      photo: [{ file_id: "photo-file" }],
      reply_to_message: { message_id: 6001, text: "작업 실행을 시작했습니다: proposal_abc-123" }
    }
  });

  assert.equal(parsed.messageText, "@platoon_bot 이거 오류 해결해");
  assert.equal(parsed.replyToMessageId, "6001");
  assert.match(parsed.replyToMessageText ?? "", /proposal_abc-123/);
  assert.deepEqual(parsed.attachmentKinds, ["photo"]);
});

test("기존 작업 후속 요청은 연결을 잃지 않는다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot proposal_abc 이어서 진행해줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  // 소대장이 판단하더라도 어느 작업의 후속인지는 보존되어야 한다.
  assert.equal(result.events[0]?.payload.targetId, "proposal_abc");
  assert.equal(result.events[0]?.payload.intent, "task_followup");
});

function envelope(messageText?: string, callbackData?: string, botRole: "platoon_leader" | "claude_leader" | "codex_leader" | "auditor" = "platoon_leader", botUsername = "platoon_bot", options: { replyToMessageText?: string; attachmentKinds?: readonly string[] } = {}): TelegramUpdateEnvelope {
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
    callbackData,
    undefined,
    undefined,
    options.replyToMessageText,
    options.attachmentKinds ?? []
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

test("개선 요청도 소대장이 읽고 배분을 판단한다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 추가로 개선할 사항을 찾아줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.ok(gateway, "판단 실행이 나가야 한다");
  assert.match(String(gateway.payload.triggeringText), /개선할 사항/);
  assert.equal(result.events[0]?.payload.intent, "new_task");
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

test("질문인지 작업인지는 키워드 표가 아니라 소대장이 가른다", () => {
  // 예전에는 "정리해줘" 같은 단어 하나로 질문으로 분류돼,
  // 실제 작업 지시가 소대장에게 닿지 못하고 정형 답변만 나갔다.
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 로그인 세션이 풀리는 원인을 정리해줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.ok(gateway, "판단으로 넘어가야 한다");
  assert.equal(isLeaderPlanningAttempt((gateway.payload.executionRequest as { attemptId: string }).attemptId), true);
  assert.equal(result.outbox.some((item) => item.payload.keyboard), false, "판단 전에는 버튼이 없다");
});

test("인사·감사는 판단을 돌리지 않는다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 고마워") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.outbox.some((item) => item.target.kind === "local_gateway"), false, "인사에 LLM 을 돌릴 이유가 없다");
});

test("판단 경로가 없으면 기존 정형 답변으로 떨어진다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@platoon_bot 설명문 관계도 흐름도 여기 채팅장에 띄워 줄 수 있나?") },
    ownerContext(),
    { makeId: (prefix: string) => `${prefix}-1`, now: () => "2026-08-10T00:00:00.000Z" }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events.length, 0);
  const text = String(result.outbox[0]?.payload.text);
  assert.match(text, /가능합니다/);
  assert.equal(result.outbox[0]?.payload.keyboard, undefined);
});
