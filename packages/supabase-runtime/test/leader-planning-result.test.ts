import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseOutboxStore, extractAgentResultText, renderLeaderPlanMessage, sessionIdFromGatewayEvents } from "../src/index.js";
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";

// 리더가 대화를 읽고 내린 판단이 방장에게 운영센터 안내와 함께 올라가는가.

const ROOM = "11111111-1111-4111-8111-111111111111";
const LEADER_ACTOR = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "leader-planning-planning_0001";

const PLAN = {
  title: "결제 실패율 상승 원인 조사 및 수정",
  purpose: "실패율 원인을 파악하고 재발 방지 조치를 적용한다",
  scope: "재시도 로직 점검, 타임아웃 검토, 실패 건 로그 누락 수정",
  completionCriteria: "원인 특정, 실패 건 100% 기록, 테스트 통과",
  assignee: "both",
  reason: "분석은 Claude, 수정·테스트는 Codex"
};

test("리더 판단이 제안 이벤트와 운영센터 설정 안내로 올라간다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])                                   // 제안 outbox
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(PLAN))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const proposalEvent = calls.requests.find((request) => request.body?.idempotency_key === "leader-proposal:" + ATTEMPT);
  assert.ok(proposalEvent, "제안 이벤트가 기록되어야 한다");
  assert.equal(proposalEvent.body.event_type, "proposal_created");
  assert.equal(proposalEvent.body.payload.title, PLAN.title);
  assert.equal(proposalEvent.body.payload.completionCriteria, PLAN.completionCriteria);
  assert.equal(proposalEvent.body.payload.assignee, "both");

  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-leader-plan:" + ATTEMPT);
  assert.equal(message?.body.payload.botRole, "leader");
  assert.equal(message?.body.payload.keyboard, undefined, "링크가 없을 때 Telegram 승인 버튼이 생기면 안 된다");
  assert.match(message?.body.payload.text, /BOT_SERVICE_MINIAPP_DIRECT_LINK/);
  assert.match(message?.body.payload.text, /결제 실패율 상승 원인/);
  assert.match(message?.body.payload.text, /완료 조건:/);
});

// Grok Bot 벤치마크 "승인 카테고리 분리(필수승인/자동허용)" 반영 — 2026-08-23.
// 리더가 MUTATES: no(파일 변경 없음)로 판단하면, 제안 카드·운영센터 안내는 그대로 나가되
// huai_approvals 에 자동승인 행도 함께 기록된다(miniapp-decision-poller.ts 가 그 행을
// 집어 기존 승인 경로 그대로 실행을 큐에 올린다 — 이 파일은 그 재생까지는 검증하지 않는다,
// miniapp-decision-poller.test.ts 의 몫이다. 여기선 "행이 올바른 모양으로 남는가"만 본다).
test("파일을 안 바꾸는 작업은 승인 카드와 함께 자동승인 행도 남긴다", async () => {
  const readOnlyPlan = { ...PLAN, mutatesFiles: false };
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, []),                                  // 제안 outbox
    jsonResponse(201, [])                                   // 자동승인 huai_approvals
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(readOnlyPlan))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  // 실측(2026-08-23): 이미 자동으로 시작된 제안에 "실행" 버튼이 남아있으면 방장이
  // "안 눌렀는데 왜 실행됐지" 하고 헷갈린다 — 개입 수단(수정·반려)만 남기고 뺀다.
  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-leader-plan:" + ATTEMPT);
  assert.match(message?.body.payload.text, /🟢 조회성 작업/);
  assert.deepEqual(
    message?.body.payload.keyboard,
    undefined,
    "링크가 없으면 기존 Telegram callback 버튼으로 fallback 하면 안 된다"
  );
  assert.match(message?.body.payload.text, /BOT_SERVICE_MINIAPP_DIRECT_LINK/);

  const approvalCall = calls.requests.find((request) => request.url.includes("/huai_approvals"));
  assert.ok(approvalCall, "자동승인 행이 huai_approvals 에 남아야 한다");
  assert.equal(approvalCall.body.stage, "task_approval");
  assert.equal(approvalCall.body.decision, "approved");
  assert.equal(approvalCall.body.decider_telegram_user_id, makeRequest().requestedBy);
  assert.match(approvalCall.body.reason, /auto-allowed/);
  assert.equal(approvalCall.body.idempotency_key, "auto-allow:task_approval:" + approvalCall.body.entity_ref);
});

test("파일을 바꾸는 작업(기본값)은 자동승인 행을 남기지 않는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])                                   // 제안 outbox — huai_approvals 호출이 없어야 이 시퀀스로 끝난다
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify({ ...PLAN, mutatesFiles: true }))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => request.url.includes("/huai_approvals")), false);

  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-leader-plan:" + ATTEMPT);
  assert.deepEqual(
    message?.body.payload.keyboard,
    undefined,
    "링크가 없으면 승인용 Telegram callback 버튼으로 fallback 하면 안 된다"
  );
  assert.match(message?.body.payload.text, /BOT_SERVICE_MINIAPP_DIRECT_LINK/);
});

// "버전 3개 만들어줘" — 리더 판단 1번이 제안 3개로 나뉜다. 각 제안은 독립적으로
// 승인받는 기존 방식 그대로다(1제안=1작업 불변식 안 건드림) — 유일한 차이는 제목에
// 변형 표시가 붙고 useIsolatedWorktree 가 true 라는 것뿐이다.
test("VARIANTS 를 요청하면 제안이 N개로 나뉘고 각각 격리 워크트리 표식을 단다", async () => {
  const variantPlan = { ...PLAN, variantCount: 3 };
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    // 변형 1
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT + ":v1")]),
    jsonResponse(201, []),
    // 변형 2
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT + ":v2")]),
    jsonResponse(201, []),
    // 변형 3
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT + ":v3")]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(variantPlan))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const proposalEvents = calls.requests.filter((request) => request.body?.event_type === "proposal_created");
  assert.equal(proposalEvents.length, 3, "제안이 정확히 3개 만들어져야 한다");

  const proposalIds = proposalEvents.map((request) => request.body.payload.proposalId);
  assert.equal(new Set(proposalIds).size, 3, "제안 id 는 서로 겹치면 안 된다");

  for (const [index, request] of proposalEvents.entries()) {
    assert.match(request.body.payload.title, new RegExp(`\\(변형 ${index + 1}/3\\)$`));
    assert.equal(request.body.payload.useIsolatedWorktree, true, "변형은 격리 워크트리에서 돌아야 한다");
  }

  const messages = calls.requests.filter((request) => String(request.body?.payload?.text ?? "").includes("📋 작업 제안입니다"));
  assert.equal(messages.length, 3, "제안마다 독립된 승인 메시지가 나가야 한다");
  for (const message of messages) {
    assert.equal(message.body.payload.keyboard, undefined, "링크가 없으면 제안마다 승인용 callback 버튼이 생기면 안 된다");
    assert.match(message.body.payload.text, /BOT_SERVICE_MINIAPP_DIRECT_LINK/);
  }
});

test("VARIANTS 를 안 쓰면(기본 1) 지금까지와 똑같이 제안 1개, useIsolatedWorktree 는 false", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(PLAN))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const proposalEvent = calls.requests.find((request) => request.body?.event_type === "proposal_created");
  assert.equal(proposalEvent?.body.payload.title, PLAN.title, "변형 없으면 제목에 변형 표시가 붙으면 안 된다");
  assert.equal(proposalEvent?.body.payload.useIsolatedWorktree, false);
});

// 라이브 실전 사고 — Claude 를 --output-format json 으로 돌리기 시작하면서(Task D,
// session_id 캡처용) 리더 판단이 "요청을 작업으로 정리하지 못했습니다"만 계속 냈다.
// DECISION: plan 줄이 stdout 최상위가 아니라 JSON "result" 문자열 안에 \n 으로
// 이스케이프된 채 갇혀서, 줄 단위 파서가 못 찾았다. 아래 JSON은 그 사고를 낸 실제
// 라이브 응답을 그대로 옮긴 것이다(2026-08-19 13:19, AI자격증사업 방, "!연구원" 페르소나
// 호출) — 재발하면 이 테스트가 바로 잡는다.
const REAL_LIVE_INCIDENT_CLAUDE_JSON = JSON.stringify({
  is_error: false,
  duration_api_ms: 7989,
  session_id: "ec3d793d-a0b8-4fb9-a024-4a6cff50feb3",
  total_cost_usd: 0.336564,
  subtype: "success",
  result:
    "DECISION: plan\nTITLE: AI 자격증 트렌드 조사\nPURPOSE: 국내외 AI 자격증 시장 동향 파악해 사업계획서 포지셔닝 자료로 활용\nSCOPE: 국내외 주요 AI 자격증(민간·공인) 현황 조사, 발급기관·응시료·커리큘럼 비교, 최근 1-2년 신규 자격증·수요 증가 추세, 경쟁 자격증 대비 차별점 분석\nDONE: 조사 결과 요약 보고서(자격증 목록·비교표·트렌드 요약) 제출, 출처 링크 포함\nASSIGNEE: claude_leader\nREASON: 페르소나 \"연구원\" 담당 고정 지시\nVARIANTS: 1",
  type: "result"
});

test("extractAgentResultText 는 claude json 통짜 응답에서 DECISION 줄을 실제로 꺼낸다 (실전 재현)", () => {
  const extracted = extractAgentResultText(REAL_LIVE_INCIDENT_CLAUDE_JSON);
  assert.match(extracted, /^DECISION: plan/);
  assert.match(extracted, /TITLE: AI 자격증 트렌드 조사/);
  assert.equal(extracted.includes("session_id"), false, "JSON 겉포장은 벗겨져야 한다");
});

test("리더가 claude json 으로 응답해도 제안이 실제로 만들어진다 (실전 회귀 재현·수정 확인)", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(200, []), // rememberLeaderSession 의 huai_ai_actors PATCH — 이 응답에도 session_id 가 있어서 붙는다
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(REAL_LIVE_INCIDENT_CLAUDE_JSON)],
    occurredAt: "2026-08-19T13:19:18.000Z"
  });

  const proposalEvent = calls.requests.find((request) => request.body?.event_type === "proposal_created");
  assert.ok(proposalEvent, "실전에서는 이게 없어서 '정리하지 못했습니다'만 나갔다 — 있어야 고쳐진 것이다");
  assert.equal(proposalEvent?.body.payload.title, "AI 자격증 트렌드 조사");
  assert.equal(proposalEvent?.body.payload.assignee, "claude_leader");

  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-leader-plan:" + ATTEMPT);
  assert.equal(message?.body.payload.text.includes("요청을 작업으로 정리하지 못했습니다"), false);
});

test("판단 결과에는 아티팩트·감사 처리가 붙지 않는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(PLAN))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  assert.equal(calls.requests.some((request) => /huai_artifacts/.test(request.url)), false, "판단은 산출물이 아니다");
  assert.equal(calls.requests.some((request) => /huai_verifications/.test(request.url)), false);
});

test("리더가 나설 자리가 아니라고 하면 제안을 만들지 않고 사유를 방에 올린다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-no-action:" + ATTEMPT)]),
    jsonResponse(201, [])                                   // no_action 안내 outbox
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify({ noAction: "사람끼리 상의 중이라 개입할 단계가 아님" }))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const record = calls.requests.find((request) => request.body?.idempotency_key === "leader-no-action:" + ATTEMPT);
  assert.match(record?.body.payload.reason, /상의 중/, "판단 사유는 이벤트 기록에 남는다");

  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-leader-plan:" + ATTEMPT);
  assert.ok(message, "불렀는데 무소식이면 죽은 것처럼 보인다 — 사유를 방에 올린다");
  assert.match(message?.body.payload.text, /상의 중/, "사유 텍스트가 메세지에 담긴다");
  assert.equal(message?.body.payload.keyboard, undefined, "나설 자리 아니면 승인 버튼 없다");
});

test("판단을 못 하면 조용히 넘기지 않고 되묻는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout("무슨 말인지 잘 모르겠습니다")],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const message = calls.requests.find((request) => request.body?.idempotency_key === "telegram-leader-plan:" + ATTEMPT);
  assert.match(message?.body.payload.text, /정리하지 못했습니다/, "사람이 불렀는데 무반응이면 죽은 것처럼 보인다");
  assert.equal(message?.body.payload.keyboard, undefined, "정리 못 했으면 승인 버튼도 없다");
});

test("다음 호출에서 이어받도록 세션을 기억한다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(200, []),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [
      stdout('{"session_id":"3bf2d064-e882-4abe-920e-5893ce0a4e59"}'),
      stdout(JSON.stringify(PLAN))
    ],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const patch = calls.requests.find((request) => request.method === "PATCH" && /huai_ai_actors/.test(request.url));
  assert.equal(patch?.body.cli_session_id, "3bf2d064-e882-4abe-920e-5893ce0a4e59");
});

test("판단 실행은 작업 실행 보고를 내보내지 않는다", async () => {
  const calls = makeFetchSequence([
    jsonResponse(200, [{ telegram_chat_id: "1001" }]),
    jsonResponse(201, [eventRow("gateway-result:" + ATTEMPT + ":completed")]),
    jsonResponse(201, [eventRow("leader-proposal:" + ATTEMPT)]),
    jsonResponse(201, [])
  ]);
  const store = makeStore(calls.fetchImpl);

  await store.recordGatewayExecutionResult({
    request: makeRequest(),
    status: "completed",
    events: [stdout(JSON.stringify(PLAN))],
    occurredAt: "2026-08-15T00:00:00.000Z"
  });

  const report = calls.requests.find((request) => String(request.body?.idempotency_key ?? "").startsWith("telegram-report:"));
  assert.equal(report, undefined, "판단은 작업 실행이 아니다 — 방에 '작업 실행 완료' 를 남기면 잡음이다");
});

test("세션 id 추출", () => {
  assert.equal(
    sessionIdFromGatewayEvents([stdout('앞말 {"session_id":"3bf2d064-e882-4abe-920e-5893ce0a4e59"} 뒷말')]),
    "3bf2d064-e882-4abe-920e-5893ce0a4e59"
  );
  assert.equal(sessionIdFromGatewayEvents([stdout("세션 없음")]), undefined);
  assert.equal(sessionIdFromGatewayEvents([stdout('{"session_id":"짧음"}')]), undefined);
});

// Codex 는 session_id 가 아니라 thread_id 를 쓴다 — 실제로 `codex exec --json` 을 돌려서
// 확인한 형식이다: {"type":"thread.started","thread_id":"01a017c9-95b5-7e93-af21-bb5a94e007c4"}
// 리더(leader) 기본 어댑터가 codex 라서, 이걸 못 잡으면 리더의 세션 이어받기가
// 통째로 죽는다.
test("codex 의 thread_id 도 세션 id 로 잡는다 (실측 형식)", () => {
  assert.equal(
    sessionIdFromGatewayEvents([
      stdout('{"type":"thread.started","thread_id":"01a017c9-95b5-7e93-af21-bb5a94e007c4"}')
    ]),
    "01a017c9-95b5-7e93-af21-bb5a94e007c4"
  );
});

test("제안 메시지에 내부 상태가 아니라 사람이 읽을 내용만 담긴다", () => {
  const text = renderLeaderPlanMessage({ ...PLAN, assignee: "both" } as never);
  assert.match(text, /📋 작업 제안입니다/);
  // 제목은 안내 문구와 섞이지 않고 따로 선다.
  assert.match(text, new RegExp(PLAN.title));
  assert.match(text, /담당: ClaudeBot \+ CodexBot/);
  assert.equal(text.includes("leader-planning-"), false);
  assert.equal(text.includes("attemptId"), false);
});

function makeStore(fetchImpl: typeof fetch) {
  return new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "service-role-key", fetchImpl });
}

function makeRequest(): ExecutionRequest {
  return {
    roomId: ROOM,
    taskId: "planning_0001",
    attemptId: ATTEMPT,
    actorId: LEADER_ACTOR,
    requestedBy: "5001",
    adapterType: "claude_code",
    projectPath: "C:/work",
    prompt: "판단 프롬프트",
    timeoutMs: 300000,
    idempotencyKey: "leader-planning:planning_0001",
    createdAt: "2026-08-15T00:00:00.000Z",
    reportBotRole: "leader"
  };
}

function stdout(text: string): GatewayEvent {
  return { type: "stdout", taskId: "planning_0001", attemptId: ATTEMPT, text };
}

function eventRow(idempotencyKey: string) {
  return {
    event_id: "event-" + idempotencyKey,
    room_id: ROOM,
    task_id: null,
    event_type: "proposal_created",
    idempotency_key: idempotencyKey,
    payload: {},
    created_at: "2026-08-15T00:00:00.000Z"
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeFetchSequence(responses: Response[]) {
  const requests: Array<{ url: string; method: string; body: any }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: String(init?.method ?? "GET"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const response = responses.shift();
    if (!response) throw new Error("unexpected-fetch-call:" + String(input));
    return response;
  };
  return { fetchImpl, requests };
}
