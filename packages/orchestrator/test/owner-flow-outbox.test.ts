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

test("S26: midpoint approval emits owner decision and queues continuation", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "task:task-1:mid_approve"), callback: { entity: "task", entityId: "task-1", action: "mid_approve" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_mid_approved");
  const continuation = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.ok(continuation, "중간 승인 뒤 후속 실행이 큐에 들어가야 한다");
  assert.match(continuation.idempotencyKey, /^gateway:mid-continuation:/);
});

test("final approve callback routes leader completion message", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "task:task-1:final_approve"), callback: { entity: "task", entityId: "task-1", action: "final_approve" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_final_approved");
  assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "leader");
  // "최종"을 뗐다. 제안 단계 버튼이 "실행"으로 바뀌어 승인이 한 곳뿐이라, 무엇에 대한
  // 최종인지 읽는 사람이 알 수 없는 수식어만 남아 있었다.
  assert.match(String(result.outbox[0]?.payload.text), /승인 완료: task-1/);
  assert.deepEqual(result.outbox[0]?.payload.binding, { kind: "task", taskId: "task-1" });
});

// Mini App [보완 요청] 사유 입력란 → huai_approvals.reason → 폴러의 합성 콜백
// (callback.reason) → 여기(buildOwnerActionOutbox)까지 실제로 닿는지 확인한다. 사유
// 입력란을 붙이면서 "적었으니 전달됐겠지"라는 거짓 안심을 만들지 않으려면, 방 메시지가
// 실제로 그 사유를 포함해야 한다 — 이게 그 끝단이다.
test("보완 요청 콜백에 사유가 있으면 방 알림 본문에 그 사유가 그대로 실린다", () => {
  const result = handleTelegramInput(
    {
      kind: "callback",
      envelope: envelope(undefined, "task:task-1:request_revision"),
      callback: { entity: "task", entityId: "task-1", action: "request_revision", reason: "로그인 버튼 색이 기획서와 다릅니다" }
    },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_supplement_requested");
  const message = result.outbox.find((item) => item.target.kind === "telegram_bot");
  assert.ok(message, "보완 요청 알림이 없다");
  assert.match(String(message.payload.text), /보완 요청: task-1/);
  assert.match(String(message.payload.text), /사유: 로그인 버튼 색이 기획서와 다릅니다/);
});

// 사유 없이 온 결정(구버전 Mini App, 혹은 사유를 안 채운 호출부)은 예전 문구를 그대로
// 유지한다 — 하위호환.
test("보완 요청 콜백에 사유가 없으면 예전 문구를 그대로 유지한다", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "task:task-1:request_revision"), callback: { entity: "task", entityId: "task-1", action: "request_revision" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const message = result.outbox.find((item) => item.target.kind === "telegram_bot");
  assert.ok(message, "보완 요청 알림이 없다");
  assert.equal(String(message.payload.text), "보완 요청: task-1\n이후 결정은 고정된 작업 현황판에서 진행해 주세요.");
});

// 공백만 있는 사유(트림하면 빈 문자열)는 "사유 없음"과 동일하게 다룬다 — 서버 쪽에서도
// 빈 문자열이 넘어올 가능성을 배제할 수 없다(Mini App 은 필수 검증을 걸지만, 폴러가
// Telegram 실시간 흐름이 남긴 행까지 원장 전체를 읽으므로 방어적으로 둔다).
test("공백만 있는 사유는 사유 없음과 동일하게 예전 문구로 떨어진다", () => {
  const result = handleTelegramInput(
    {
      kind: "callback",
      envelope: envelope(undefined, "task:task-1:request_revision"),
      callback: { entity: "task", entityId: "task-1", action: "request_revision", reason: "   " }
    },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const message = result.outbox.find((item) => item.target.kind === "telegram_bot");
  assert.ok(message);
  assert.equal(String(message.payload.text), "보완 요청: task-1\n이후 결정은 고정된 작업 현황판에서 진행해 주세요.");
});

// 지나치게 긴 사유는 방 메시지 안에서 잘리되, 잘렸다는 사실이 명시적으로 보여야 한다
// (안 보이면 방 사람들은 사유 전체를 읽었다고 착각한다).
test("지나치게 긴 사유는 방 메시지에서 잘리고, 잘렸다는 사실이 표시된다", () => {
  const longReason = "가".repeat(600);
  const result = handleTelegramInput(
    {
      kind: "callback",
      envelope: envelope(undefined, "task:task-1:request_revision"),
      callback: { entity: "task", entityId: "task-1", action: "request_revision", reason: longReason }
    },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const message = result.outbox.find((item) => item.target.kind === "telegram_bot");
  assert.ok(message);
  const text = String(message.payload.text);
  assert.match(text, /잘렸습니다/);
  assert.equal(text.includes(longReason), false, "원문 전체가 그대로 실리면 안 된다(잘려야 한다)");
});

test("리더 멘션은 즉시 제안이 아니라 판단 실행을 요청한다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot build the mention router") },
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
  assert.equal(request.reportBotRole, "leader");
  assert.equal(result.events[0]?.payload.stage, "leader_planning_requested");
  assert.equal(result.events[0]?.payload.triggeringText, "build the mention router");
  assert.equal(
    result.outbox.some((item) => item.payload.keyboard),
    false,
    "판단 전에는 승인 버튼을 올리지 않는다"
  );
});

test("다중 AI 요청도 리더가 판단해 배분한다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot ClaudeBot과 CodexBot이 각각 의견 내고 AuditBot이 검증해서 결론 내줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  // 누구에게 시킬지는 정규식이 봇 이름을 찾는 게 아니라 리더가 판단한다.
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.ok(gateway, "판단 실행이 게이트웨이로 나가야 한다");
  assert.equal(isLeaderPlanningAttempt((gateway.payload.executionRequest as { attemptId: string }).attemptId), true);
  assert.match(String(gateway.payload.triggeringText), /ClaudeBot과 CodexBot/);
});

test("담당 지목이 있어도 리더가 판단해 배분한다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot Claude Code로 이 코드 점검해줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  // 예전에는 정규식이 "Claude" 를 찾아 담당을 못박았다.
  // 이제는 요청 원문을 리더에게 넘기고 리더가 배분을 판단한다.
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.ok(gateway);
  assert.match(String(gateway.payload.triggeringText), /Claude Code/);
  assert.equal(isLeaderPlanningAttempt((gateway.payload.executionRequest as { attemptId: string }).attemptId), true);
});

test("bare continuation mention asks for task clarification", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot 계속해") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events.length, 0);
  assert.match(String(result.outbox[0]?.payload.text), /어느 작업을 이어갈지/);
});

test("vague actor delegation asks for concrete work instead of creating a proposal", () => {
  for (const text of ["@leader_bot 그러면 코덱스에게 시켜", "@leader_bot 그러면 코덱스에게 작업시켜"]) {
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
    { kind: "message", envelope: envelope("@leader_bot 이거 오류 해결해") },
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
    { kind: "message", envelope: envelope("@leader_bot 이거 오류 해결해", undefined, "leader", "leader_bot", { attachmentKinds: ["photo"] }) },
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
    { kind: "message", envelope: envelope("진행해", undefined, "leader", "leader_bot", { replyToMessageText: "작업 실행을 시작했습니다: proposal_abc-123" }) },
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
    { kind: "message", envelope: envelope("이거 오류 해결해", undefined, "leader", "leader_bot", { replyToMessageText: "작업 실행을 시작했습니다: proposal_abc-123" }) },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "proposal_created");
  assert.equal(result.events[0]?.payload.intent, "task_followup");
  assert.equal(result.events[0]?.payload.targetId, "proposal_abc-123");
});

test("caption text and reply context are parsed from Telegram updates", () => {
  const parsed = TelegramUpdateEnvelope.parse("bot-leader", "leader_bot", "leader", {
    update_id: 77,
    message: {
      message_id: 7001,
      chat: { id: 1001 },
      from: { id: 2001, is_bot: false },
      caption: "@leader_bot 이거 오류 해결해",
      photo: [{ file_id: "photo-file" }],
      reply_to_message: { message_id: 6001, text: "작업 실행을 시작했습니다: proposal_abc-123" }
    }
  });

  assert.equal(parsed.messageText, "@leader_bot 이거 오류 해결해");
  assert.equal(parsed.replyToMessageId, "6001");
  assert.match(parsed.replyToMessageText ?? "", /proposal_abc-123/);
  assert.deepEqual(parsed.attachmentKinds, ["photo"]);
});

test("기존 작업 후속 요청은 연결을 잃지 않는다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot proposal_abc 이어서 진행해줘") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  // 리더가 판단하더라도 어느 작업의 후속인지는 보존되어야 한다.
  assert.equal(result.events[0]?.payload.targetId, "proposal_abc");
  assert.equal(result.events[0]?.payload.intent, "task_followup");
});

function envelope(messageText?: string, callbackData?: string, botRole: "leader" | "claude_leader" | "codex_leader" | "auditor" = "leader", botUsername = "leader_bot", options: { replyToMessageText?: string; attachmentKinds?: readonly string[] } = {}): TelegramUpdateEnvelope {
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

  // 순서가 요점이다 — 방장이 보는 것들이 게이트웨이 실행보다 먼저 나가야 한다.
  // (누른 메시지 편집 → 실행 시작 안내 → 실행 요청). 자리번호로 박아두면 앞에
  // 항목이 하나 늘 때마다 깨지므로 성질로 찾는다.
  const startedIndex = result.outbox.findIndex((item) => /작업 실행을 시작했습니다/.test(String(item.payload.text)));
  const gatewayIndex = result.outbox.findIndex((item) => item.target.kind === "local_gateway");

  assert.notEqual(startedIndex, -1, "실행 시작 안내가 없다");
  assert.notEqual(gatewayIndex, -1, "게이트웨이 실행 요청이 없다");
  assert.equal(startedIndex < gatewayIndex, true, "실행 요청이 방장 안내보다 먼저 나간다");

  const started = result.outbox[startedIndex];
  assert.equal(started?.target.kind === "telegram_bot" ? started.target.botRole : undefined, "leader");
  assert.match(String(started?.payload.text), /AI 작업자를 배정/);
});

test("개선 요청도 리더가 읽고 배분을 판단한다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot 추가로 개선할 사항을 찾아줘") },
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
  // 상한이 10 이던 때, 방에 작업이 쌓이면 지금 돌고 있는 것이 목록 밖으로 밀려
  // "진행상황이 안 보인다"가 됐다. 조회 쪽에서 진행 중을 따로 뽑아 항상 포함시키도록
  // 바뀌었고(supabase-store renderTaskListQuery), 창 자체도 넓혔다.
  assert.deepEqual(result.outbox[0]?.payload.query, { kind: "tasks", limit: 30 });
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

test("질문인지 작업인지는 키워드 표가 아니라 리더가 가른다", () => {
  // 예전에는 "정리해줘" 같은 단어 하나로 질문으로 분류돼,
  // 실제 작업 지시가 리더에게 닿지 못하고 정형 답변만 나갔다.
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot 로그인 세션이 풀리는 원인을 정리해줘") },
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
    { kind: "message", envelope: envelope("@leader_bot 고마워") },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.outbox.some((item) => item.target.kind === "local_gateway"), false, "인사에 LLM 을 돌릴 이유가 없다");
});

// 실행 기본값(actor/gateway/project path)이 없는 방(A-5)에서 승인·검증류 명령이 오면
// 예외를 던지거나(승인) 거짓으로 접수했다고 말하고(검증) 조용히 아무 일도 안 하던 버그.
// 두 경로가 같은 방식으로 — 예외 없이, 사용자에게 보이는 안내로 — 동작해야 한다.
function portsWithoutExecutionDefaults() {
  return {
    makeId(prefix: string) {
      return `${prefix}-1`;
    },
    now() {
      return "2026-08-10T00:00:00.000Z";
    }
    // executionDefaults 없음 — A-5 가 방을 실행 기본값 없이 살려둔 상황을 재현한다.
  };
}

test("실행 기본값 없는 방에서 승인 콜백은 던지지 않고 사용자에게 보이는 안내를 보낸다", () => {
  assert.doesNotThrow(() => {
    const result = handleTelegramInput(
      { kind: "callback", envelope: envelope(undefined, "proposal:proposal-1:approve"), callback: { entity: "proposal", entityId: "proposal-1", action: "approve" } },
      ownerContext(),
      portsWithoutExecutionDefaults()
    );

    assert.equal(result.accepted, true);
    assert.equal(result.events[0]?.eventType, "owner_task_approved", "승인 자체는 감사 추적을 위해 이벤트로 남는다");
    assert.equal(result.outbox.length, 1, "실행이 안 되니 local_gateway 실행 요청이 추가로 붙으면 안 된다");
    assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "leader");
    const text = String(result.outbox[0]?.payload.text);
    assert.doesNotMatch(text, /작업 실행을 시작했습니다/, "실행되지 않을 것을 시작했다고 말하면 안 된다(거짓 안심)");
    assert.doesNotMatch(text, /missing-execution-defaults/, "내부 에러 코드를 사용자에게 노출하면 안 된다");
    assert.match(text, /준비/, "방장이 '아직 준비가 안 됐다'는 사실을 알 수 있어야 한다");
  });
});

test("실행 기본값 없는 방에서 /verify 는 '검증 요청' 을 보내지 않고 안내만 보낸다", () => {
  assert.doesNotThrow(() => {
    const result = handleTelegramInput(
      { kind: "command", envelope: envelope("/verify task-1"), command: { name: "/verify", args: ["task-1"] } },
      ownerContext(),
      portsWithoutExecutionDefaults()
    );

    assert.equal(result.accepted, true);
    assert.equal(result.events[0]?.eventType, "owner_verification_requested");
    assert.equal(result.outbox.length, 1, "실제 감사가 안 도니 local_gateway 실행 요청이 붙으면 안 된다");
    assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "auditor");
    const text = String(result.outbox[0]?.payload.text);
    assert.doesNotMatch(text, /검증 요청:/, "실행되지 않을 검증을 '요청했다'고 말하면 안 된다(거짓 안심)");
    assert.doesNotMatch(text, /missing-execution-defaults/);
    assert.match(text, /준비/);
  });
});

test("실행 기본값 없는 방에서 재검증 콜백도 동일하게 동작한다", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "task:task-1:reverify"), callback: { entity: "task", entityId: "task-1", action: "reverify" } },
    ownerContext(),
    portsWithoutExecutionDefaults()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.outbox.length, 1);
  const text = String(result.outbox[0]?.payload.text);
  assert.doesNotMatch(text, /재검증 요청:/);
  assert.doesNotMatch(text, /missing-execution-defaults/);
});

test("실행 기본값 없는 방에서 감사봇 자유 발화도 거짓 접수 메시지를 보내지 않는다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@audit_chatroom_bot 보안 점검해줘", undefined, "auditor", "audit_chatroom_bot") },
    ownerContext(),
    portsWithoutExecutionDefaults()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.eventType, "owner_verification_requested", "이벤트 자체는 여전히 기록된다");
  assert.equal(result.outbox.length, 1, "실제 감사가 안 도니 local_gateway 실행 요청이 붙으면 안 된다");
  assert.equal(result.outbox[0]?.target.kind === "telegram_bot" ? result.outbox[0].target.botRole : undefined, "auditor");
  const text = String(result.outbox[0]?.payload.text);
  assert.doesNotMatch(text, /감사 요청을 접수했습니다/, "실제로 안 도는 감사를 접수했다고 말하면 안 된다(거짓 안심)");
  assert.doesNotMatch(text, /missing-execution-defaults/);
});

// Mini App 결정 폴러는 huai_approvals 원본 행을 읽어 합성 콜백으로 "재생"한다.
// applyOwnerCallback 이 만드는 이벤트가 huai_approvals 에 또 한 행을 쓰는데(recordApprovals),
// 재생이 만드는 이벤트의 idempotencyKey 가 원본과 다르면 원장에 결정 하나당 2행이 쌓인다
// (실행 중복은 아니다 — 그건 앞의 테스트들이 막는다. 이건 감사 원장 오염 문제다).
// ports.approvalEventIdempotencyKey 로 호출자가 원본 키를 주입하면 재생 이벤트가 원본과
// 같은 키를 써서 recordApprovals 의 기존 409 흡수 경로에 자연히 걸린다.
test("approvalEventIdempotencyKey 주입이 없으면 기존과 완전히 동일한 키를 쓴다", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "proposal:proposal-1:approve"), callback: { entity: "proposal", entityId: "proposal-1", action: "approve" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.idempotencyKey, "owner_task_approved:bot-leader:77:proposal-1");
});

test("approvalEventIdempotencyKey 를 주입하면 승인 이벤트가 그 키를 그대로 쓴다", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "proposal:proposal-1:approve"), callback: { entity: "proposal", entityId: "proposal-1", action: "approve" } },
    ownerContext(),
    { ...ports(), approvalEventIdempotencyKey: "original-huai-approvals-row-key" }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events[0]?.idempotencyKey, "original-huai-approvals-row-key", "재생 이벤트가 원본 원장 행과 같은 키를 써야 409 로 흡수돼 원장에 1행만 남는다");
  // 주입은 이벤트의 idempotencyKey 만 바꾼다 — 실행 아웃박스 dedup(entityId 기반)이나
  // 다른 outbox 항목에는 번지면 안 된다(표면을 넓히지 말라는 지시).
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  assert.equal(gateway?.idempotencyKey, "gateway:execution:proposal-1", "주입이 실행 아웃박스 dedup 로직까지 건드리면 안 된다");
});

test("approvalEventIdempotencyKey 주입은 콜백 승인 이벤트에만 적용되고 다른 이벤트 종류는 영향받지 않는다", () => {
  const portsWithOverride = { ...ports(), approvalEventIdempotencyKey: "should-not-leak-anywhere-else" };

  // 커맨드 경로(applyOwnerTaskCommand) — Mini App 폴러는 콜백만 만들지, 커맨드를
  // 만들지 않는다. 이 훅이 커맨드 경로까지 새면 표면이 넓어진다는 지시를 어기는 것이다.
  const commandResult = handleTelegramInput(
    { kind: "command", envelope: envelope("/verify task-1"), command: { name: "/verify", args: ["task-1"] } },
    ownerContext(),
    portsWithOverride
  );
  assert.equal(commandResult.accepted, true);
  assert.notEqual(commandResult.events[0]?.idempotencyKey, "should-not-leak-anywhere-else");

  // 제안 생성 이벤트 — 승인 이벤트가 아니다.
  const proposalResult = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot 새 기능 추가해줘") },
    ownerContext(),
    portsWithOverride
  );
  assert.equal(proposalResult.accepted, true);
  assert.notEqual(proposalResult.events[0]?.idempotencyKey, "should-not-leak-anywhere-else");
});

// 같은 승인을 두 번 누르면 두 번째 클릭은 새 update_id 를 받아 인바운드 dedup 을
// 통과한다 — 그런데 실행 아웃박스 멱등키에 update_id 가 들어 있으면 두 번째 클릭이
// 서로 다른 키를 만들어 huai_outbox 에 local_gateway 행이 2개 쌓이고 CLI 가 두 번
// 실행된다. 아래 테스트들은 이 경계를 entityId(승인) / entityId+메시지id(검증) 로
// 옮긴 것을 검증한다.
function envelopeWithIds(updateId: string, telegramMessageId: string | undefined, callbackData?: string, botId = "bot-leader", botUsername = "leader_bot"): TelegramUpdateEnvelope {
  return new TelegramUpdateEnvelope(
    botId,
    botUsername,
    "leader",
    updateId,
    "1001",
    telegramMessageId,
    "2001",
    false,
    undefined,
    callbackData
  );
}

function gatewayIdempotencyKey(result: ReturnType<typeof handleTelegramInput>): string | undefined {
  if (!result.accepted) return undefined;
  const gateway = result.outbox.find((item) => item.target.kind === "local_gateway");
  return gateway?.idempotencyKey;
}

test("같은 승인 결정을 두 번(다른 update_id) 처리해도 실행 아웃박스 키가 같다", () => {
  const first = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("77", "9001", "proposal:proposal-1:approve"), callback: { entity: "proposal", entityId: "proposal-1", action: "approve" } },
    ownerContext(),
    ports()
  );
  // 두 번째 클릭 — 같은 메시지의 같은 버튼이지만 Telegram 이 새 update_id 를 부여한다.
  const second = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("78", "9001", "proposal:proposal-1:approve"), callback: { entity: "proposal", entityId: "proposal-1", action: "approve" } },
    ownerContext(),
    ports()
  );

  const firstKey = gatewayIdempotencyKey(first);
  const secondKey = gatewayIdempotencyKey(second);
  assert.ok(firstKey, "승인은 local_gateway 실행 요청을 만들어야 한다");
  assert.equal(firstKey, secondKey, "같은 결정이면 두 번째 클릭도 첫 번째와 동일한 실행 키를 만들어야 huai_outbox unique 제약에서 하나로 합쳐진다");
});

test("서로 다른 승인 결정(다른 제안)은 서로 다른 실행 키를 만든다", () => {
  const proposalA = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("77", "9001", "proposal:proposal-A:approve"), callback: { entity: "proposal", entityId: "proposal-A", action: "approve" } },
    ownerContext(),
    ports()
  );
  const proposalB = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("78", "9002", "proposal:proposal-B:approve"), callback: { entity: "proposal", entityId: "proposal-B", action: "approve" } },
    ownerContext(),
    ports()
  );

  const keyA = gatewayIdempotencyKey(proposalA);
  const keyB = gatewayIdempotencyKey(proposalB);
  assert.ok(keyA && keyB);
  assert.notEqual(keyA, keyB, "다른 결정은 각자 실행돼야 하므로 키가 겹치면 안 된다");
});

test("Telegram 버튼과 Mini App 탭이 같은 승인 결정이면 실행 키가 같다(창구 무관)", () => {
  // 실제 Telegram 콜백 — 사람이 인라인 버튼을 누른 경우.
  const viaTelegram = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("501", "9001", "proposal:proposal-shared:approve"), callback: { entity: "proposal", entityId: "proposal-shared", action: "approve" } },
    ownerContext(),
    ports()
  );
  // Mini App 결정 폴러가 만드는 합성 콜백 — miniapp-decision-poller.ts 의
  // buildSyntheticEnvelope 와 동일한 모양(봇 id 가 다르고, telegramMessageId 가 없다).
  const viaMiniApp = handleTelegramInput(
    {
      kind: "callback",
      envelope: envelopeWithIds("miniapp-approval-999", undefined, undefined, "miniapp-decision-poller", "miniapp"),
      callback: { entity: "proposal", entityId: "proposal-shared", action: "approve" }
    },
    ownerContext(),
    ports()
  );

  const telegramKey = gatewayIdempotencyKey(viaTelegram);
  const miniAppKey = gatewayIdempotencyKey(viaMiniApp);
  assert.ok(telegramKey && miniAppKey);
  assert.equal(telegramKey, miniAppKey, "같은 결정이면 어느 창구에서 왔든 같은 실행 키를 만들어야 두 번째 창구가 huai_outbox unique 제약에서 걸러진다");
});

test("재검증이 여러 라운드에 걸쳐 반복돼도(보완 -> 재검증 -> 보완 -> 재검증) 각 라운드는 막히지 않는다", () => {
  // 라운드 1의 재검증 — 첫 번째 보완 요청 메시지(id 9101)의 키보드에서 눌렀다.
  const round1 = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("601", "9101", "task:task-1:reverify"), callback: { entity: "task", entityId: "task-1", action: "reverify" } },
    ownerContext(),
    ports()
  );
  // 라운드 2의 재검증 — 그 다음 보완 요청은 새 메시지(id 9102)로 나가므로 키보드도 새 메시지다.
  const round2 = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("602", "9102", "task:task-1:reverify"), callback: { entity: "task", entityId: "task-1", action: "reverify" } },
    ownerContext(),
    ports()
  );

  const round1Key = gatewayIdempotencyKey(round1);
  const round2Key = gatewayIdempotencyKey(round2);
  assert.ok(round1Key && round2Key, "재검증은 감사 실행 요청을 만들어야 한다");
  assert.notEqual(round1Key, round2Key, "같은 taskId 라도 새 라운드(새 메시지)의 재검증은 이전 라운드와 동일하게 취급되면 안 된다 — 막히면 재검증이 통째로 죽는다");
});

test("같은 재검증 라운드 안에서 연타(같은 메시지, 다른 update_id)는 하나로 합쳐진다", () => {
  const click1 = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("701", "9201", "task:task-2:reverify"), callback: { entity: "task", entityId: "task-2", action: "reverify" } },
    ownerContext(),
    ports()
  );
  const click2 = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("702", "9201", "task:task-2:reverify"), callback: { entity: "task", entityId: "task-2", action: "reverify" } },
    ownerContext(),
    ports()
  );

  assert.equal(gatewayIdempotencyKey(click1), gatewayIdempotencyKey(click2));
});

test("첫 검증(/verify 명령)과 그 뒤 재검증(버튼)은 서로 다른 라운드라 막히지 않는다", () => {
  const verify = handleTelegramInput(
    { kind: "command", envelope: envelopeWithIds("801", "9301"), command: { name: "/verify", args: ["task-3"] } },
    ownerContext(),
    ports()
  );
  const reverify = handleTelegramInput(
    { kind: "callback", envelope: envelopeWithIds("802", "9302", "task:task-3:reverify"), callback: { entity: "task", entityId: "task-3", action: "reverify" } },
    ownerContext(),
    ports()
  );

  const verifyKey = gatewayIdempotencyKey(verify);
  const reverifyKey = gatewayIdempotencyKey(reverify);
  assert.ok(verifyKey && reverifyKey);
  assert.notEqual(verifyKey, reverifyKey);
});

test("판단 경로가 없으면 기존 정형 답변으로 떨어진다", () => {
  const result = handleTelegramInput(
    { kind: "message", envelope: envelope("@leader_bot 설명문 관계도 흐름도 여기 채팅장에 띄워 줄 수 있나?") },
    ownerContext(),
    { makeId: (prefix: string) => `${prefix}-1`, now: () => "2026-08-10T00:00:00.000Z" }
  );

  assert.equal(result.accepted, true);
  assert.equal(result.events.length, 0);
  const text = String(result.outbox[0]?.payload.text);
  assert.match(text, /가능합니다/);
  assert.equal(result.outbox[0]?.payload.keyboard, undefined);
});

// 라이브 결함 회귀 — 실행 버튼을 눌러도 눈에 보이는 변화가 없던 문제.
//
// 접수 안내는 answerCallbackQuery 토스트로만 나가서 놓치기 쉽고, 뒤이어 오는
// 새 메시지는 화면 아래에 조용히 쌓인다. 방장이 "눌렀는데 먹통인지 도는지 모르겠다"고
// 반복 제기했다. 누른 그 메시지를 바꿔서 변화가 눈앞에 보이게 한다.
test("실행 버튼을 누르면 그 메시지가 실행 중으로 바뀌고 버튼이 사라진다", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "task:task-1:approve"), callback: { entity: "task", entityId: "task-1", action: "approve" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const edit = result.accepted
    ? result.outbox.find((item) => item.payload.editMessageId !== undefined)
    : undefined;
  assert.ok(edit, "누른 메시지를 고치는 항목이 없다 — 화면에 아무 변화가 없다");
  assert.match(String(edit.payload.text), /작업 중/);

  // 빈 키보드를 명시해야 기존 버튼이 확실히 걷힌다. 생략하면 reply_markup 키가
  // 요청에서 빠져 버튼이 남을 수 있고, 그러면 두 번 눌리는 길이 열린다.
  assert.deepEqual(edit.payload.keyboard, { inline_keyboard: [] });
});

test("실행 안내 메시지는 그대로 나간다 — 편집이 대체하지 않는다", () => {
  const result = handleTelegramInput(
    { kind: "callback", envelope: envelope(undefined, "task:task-1:approve"), callback: { entity: "task", entityId: "task-1", action: "approve" } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const started = result.accepted
    ? result.outbox.find((item) => /작업 실행을 시작했습니다/.test(String(item.payload.text)))
    : undefined;
  assert.ok(started, "실행 시작 안내가 사라졌다");
  assert.equal(started.payload.editMessageId, undefined);
});

test("명령으로 승인하면 고칠 메시지가 없으므로 편집을 만들지 않는다", () => {
  // /approve 는 버튼이 아니라 사용자가 친 메시지다. 그 메시지를 봇이 고칠 수 없고,
  // 고치려 들면 엉뚱한 메시지를 건드린다.
  const result = handleTelegramInput(
    { kind: "command", envelope: envelope("/approve task-1"), command: { name: "/approve", args: ["task-1"] } },
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const edits = result.accepted ? result.outbox.filter((item) => item.payload.editMessageId !== undefined) : [];
  assert.deepEqual(edits, []);
});

// 라이브 결함 회귀 — 포럼 그룹의 "달걀 깨기 게임" 주제에서 지시했는데 그 주제에는 아무
// 반응이 없었다. 답이 전부 General 로 떨어졌기 때문이다. 방장은 봇이 죽은 줄 알았다.
test("포럼 주제에서 온 지시는 답도 그 주제로 간다", () => {
  const forumEnvelope = envelope("@leader_chatroom_bot 달걀 깨기 게임 만들어줘");
  (forumEnvelope as any).messageThreadId = "613";
  const result = handleTelegramInput({ kind: "message", envelope: forumEnvelope } as any, ownerContext(), ports());

  assert.equal(result.accepted, true);
  const telegramItems = result.accepted ? result.outbox.filter((item) => item.target.kind === "telegram_bot") : [];
  assert.equal(telegramItems.length > 0, true, "방으로 나가는 메시지가 없다");
  for (const item of telegramItems) {
    assert.equal(item.payload.messageThreadId, "613", "주제 번호가 빠지면 General 로 떨어진다");
  }
});

test("실행 요청에도 주제를 실어 나중 보고가 같은 자리로 돌아온다", () => {
  // 실행 보고·감사 결과는 몇 분 뒤에 나간다. 그때는 요청 말고 주제를 알 길이 없다.
  const forumEnvelope = envelope(undefined, "task:task-1:approve");
  (forumEnvelope as any).messageThreadId = "613";
  const result = handleTelegramInput(
    { kind: "callback", envelope: forumEnvelope, callback: { entity: "task", entityId: "task-1", action: "approve" } } as any,
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const gateway = result.accepted ? result.outbox.find((item) => item.target.kind === "local_gateway") : undefined;
  assert.ok(gateway, "게이트웨이로 가는 실행 요청이 없다");
  assert.equal((gateway.payload.executionRequest as any).telegramMessageThreadId, "613");
});

test("주제가 없는 일반 그룹은 그대로 둔다", () => {
  // General 주제나 포럼이 아닌 그룹에는 이 값이 아예 없다. 빈 값을 실어 보내면 안 된다.
  const result = handleTelegramInput({ kind: "message", envelope: envelope("@leader_chatroom_bot 뭐 좀 해줘") } as any, ownerContext(), ports());

  assert.equal(result.accepted, true);
  const telegramItems = result.accepted ? result.outbox.filter((item) => item.target.kind === "telegram_bot") : [];
  for (const item of telegramItems) {
    assert.equal(item.payload.messageThreadId, undefined);
  }
});

// 라이브 결함 회귀 — 승인 후 나가는 메시지 중 "작업을 시작했습니다" 한 줄만 General 로
// 떨어졌다. 그 메시지를 만드는 자리가 messageThreadId 키를 undefined 로 이미 갖고 있었고,
// 주입이 그 뒤에 펼쳐지면서 값이 undefined 로 덮였다.
test("승인 후 나가는 메시지가 하나도 빠짐없이 같은 주제로 간다", () => {
  const forumEnvelope = envelope(undefined, "task:task-1:approve");
  (forumEnvelope as any).messageThreadId = "613";
  const result = handleTelegramInput(
    { kind: "callback", envelope: forumEnvelope, callback: { entity: "task", entityId: "task-1", action: "approve" } } as any,
    ownerContext(),
    ports()
  );

  assert.equal(result.accepted, true);
  const telegramItems = result.accepted ? result.outbox.filter((item) => item.target.kind === "telegram_bot") : [];
  assert.equal(telegramItems.length >= 2, true, "승인 경로는 편집과 새 메시지를 함께 낸다");
  for (const item of telegramItems) {
    assert.equal(item.payload.messageThreadId, "613", `주제가 빠진 메시지: ${item.idempotencyKey}`);
  }
});
