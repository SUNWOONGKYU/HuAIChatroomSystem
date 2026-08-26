// 기획서 운영 시나리오 드라이런.
//
// 목적: "코드에 배선이 있다"가 아니라 "실제로 돌려보면 어디까지 되는가"를 확인한다.
// 실 Telegram·실 Supabase 없이 인메모리 fake 로 종단 경로를 구동하고,
// 각 단계에서 기획서 요구사항이 실제로 충족되는지 런타임 관측으로 판정한다.
//
// 이 하네스는 미구현을 감추지 않는다. 도달 불가능한 단계는 BLOCKED 로 명시한다.
//
// 실행: node scripts/dry-run-spec.mjs   (사전에 npm run build 필요)

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routeTelegramWebhookSafe, handleTelegramWebhookFastAck, makeTelegramUpdateIdempotencyKey } from "../dist/apps/bot-service/src/index.js";
import { handleTelegramInput, authorizeTelegramInput, isLeaderPlanningAttempt } from "../dist/packages/orchestrator/src/index.js";
import { FakeBotServiceStore } from "../dist/apps/bot-service/src/fake-store.js";
import { runLocalGatewayConsumerOnce } from "../dist/apps/local-gateway/src/consumer.js";
import { createArtifactCollector } from "../dist/apps/local-gateway/src/artifact-collector.js";
import { transitionTaskStatus, isForbiddenTransition, planReadyTasks } from "../dist/packages/workflow/src/index.js";
import { approvalRecordForEvent, approvalEntityRefFromPayload, approvalDeciderFromPayload } from "../dist/apps/bot-service/src/supabase-store.js";
import { SupabaseOutboxStore, classifyRevisionChangedScope } from "../dist/packages/supabase-runtime/src/index.js";

const OWNER_USER = "5001";
const MEMBER_USER = "5002";
const CHAT_ID = "-1001234567890";
const BOT_ID = "bot-leader";
const BOT_USERNAME = "leader_chatroom_bot";
const SECRET = "webhook-secret-value";

const steps = [];
let idCounter = 0;

function record(id, requirement, title, status, detail) {
  steps.push({ id, requirement, title, status, detail });
}

const ports = {
  makeId: (prefix) => `${prefix}_${String(++idCounter).padStart(4, "0")}`,
  now: () => "2026-08-14T21:00:00.000Z",
  executionDefaults: {
    roomId: "11111111-1111-4111-8111-111111111111",
    actorId: "22222222-2222-4222-8222-222222222222",
    adapterType: "codex",
    projectPath: process.cwd(),
    timeoutMs: 60_000,
    gatewayId: "primary"
  }
};

const authorization = {
  memberships: [
    { telegramChatId: CHAT_ID, telegramUserId: OWNER_USER, role: "owner",
      permissions: ["task:create", "task:read", "task:approve", "task:reject", "task:verify", "task:final_approve", "task:cancel", "bots:manage"], status: "active" },
    { telegramChatId: CHAT_ID, telegramUserId: MEMBER_USER, role: "human_member",
      permissions: ["task:create", "task:read"], status: "active" }
  ]
};

const botConfig = {
  allowedChatIds: [CHAT_ID],
  botsByUsername: new Map([[BOT_USERNAME, {
    telegramBotId: BOT_ID, botUsername: BOT_USERNAME, botRole: "leader", webhookSecret: SECRET
  }]])
};

function messageUpdate(updateId, userId, text, extra = {}) {
  return {
    update_id: updateId,
    message: { message_id: updateId * 10, chat: { id: CHAT_ID }, from: { id: userId, is_bot: false }, text, ...extra }
  };
}

function callbackUpdate(updateId, userId, data) {
  return {
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, from: { id: userId }, data, message: { message_id: updateId * 10, chat: { id: CHAT_ID } } }
  };
}

function accept(update, secret = SECRET) {
  return routeTelegramWebhookSafe(BOT_USERNAME, secret, update, botConfig);
}

// ============ 1. 수신·보안·멱등 ============

{
  const bad = accept(messageUpdate(1, OWNER_USER, "hi"), "wrong-secret");
  record("S01", "NFR-07 / AC-15", "잘못된 webhook 시크릿 거부",
    bad.kind === "ignored" && bad.reason === "invalid-webhook-secret" ? "PASS" : "FAIL",
    `reason=${bad.reason}`);
}

{
  const foreign = routeTelegramWebhookSafe(BOT_USERNAME, SECRET,
    { update_id: 2, message: { message_id: 20, chat: { id: "-100999" }, from: { id: OWNER_USER }, text: "hi" } }, botConfig);
  record("S02", "NFR-01 / AC-15", "미허용 채팅방 거부",
    foreign.kind === "ignored" && foreign.reason === "unauthorized-chat" ? "PASS" : "FAIL",
    `reason=${foreign.reason}`);
}

{
  const botMsg = accept({ update_id: 3, message: { message_id: 30, chat: { id: CHAT_ID }, from: { id: "9", is_bot: true }, text: "loop" } });
  record("S03", "NFR-03", "봇 자신의 메시지 무시 (에코 루프 차단)",
    botMsg.kind === "ignored" && botMsg.reason === "bot-message-ignored" ? "PASS" : "FAIL",
    `reason=${botMsg.reason}`);
}

{
  const store = new FakeBotServiceStore();
  const seen = new Set();
  const updates = {
    async recordUpdateOnce(envelope) {
      const key = makeTelegramUpdateIdempotencyKey(envelope);
      if (seen.has(key)) return { inserted: false, status: "processed", idempotencyKey: key };
      seen.add(key);
      return { inserted: true, status: "received", idempotencyKey: key };
    },
    async markUpdateFailed() {}
  };
  const queued = [];
  const webhookPorts = { updates, inboundQueue: { async enqueue(message) { queued.push(message); } } };
  const update = messageUpdate(4, OWNER_USER, "@leader_chatroom_bot 로그인 버그를 고쳐줘");
  const first = await handleTelegramWebhookFastAck({ botUsername: BOT_USERNAME, secretToken: SECRET, receivedAt: ports.now() }, update, botConfig, webhookPorts);
  const second = await handleTelegramWebhookFastAck({ botUsername: BOT_USERNAME, secretToken: SECRET, receivedAt: ports.now() }, update, botConfig, webhookPorts);
  record("S04", "AC-12 / H-01 / NFR-03", "동일 update 재수신 시 1회만 큐 적재",
    first.queued === true && second.queued === false && second.reason === "duplicate-update" && queued.length === 1 ? "PASS" : "FAIL",
    `first.queued=${first.queued} second.reason=${second.reason} queued=${queued.length}`);
  record("S05", "NFR-04", "webhook 은 항상 200 즉시 응답 (Telegram 재전송 폭주 방지)",
    first.httpStatus === 200 && second.httpStatus === 200 ? "PASS" : "FAIL", `status=${first.httpStatus}`);
}

// ============ 2. 권한 ============

{
  const decision = accept(callbackUpdate(5, MEMBER_USER, "proposal:proposal_0001:approve"));
  const auth = authorizeTelegramInput(decision.input, authorization);
  record("S06", "NFR-01 / AC-02", "비방장의 승인 버튼 차단",
    auth.allowed === false && auth.reason === "owner_required" ? "PASS" : "FAIL", `reason=${auth.reason}`);
}

{
  const decision = accept(messageUpdate(6, "9999", "낯선 사람"));
  const auth = authorizeTelegramInput(decision.input, authorization);
  record("S07", "NFR-01", "미등록 사용자 차단",
    auth.allowed === false && auth.reason === "unauthorized_chat" ? "PASS" : "FAIL", `reason=${auth.reason}`);
}

// ============ 3. 제안 생성 / 질문 분기 ============

let proposalId;
{
  const decision = accept(messageUpdate(7, OWNER_USER, "@leader_chatroom_bot 로그인 세션 만료 버그를 고쳐줘"));
  const result = handleTelegramInput(decision.input, authorization, ports);
  const gateway = result.accepted ? result.outbox.find((item) => item.target.kind === "local_gateway") : undefined;
  const planning = gateway ? isLeaderPlanningAttempt(gateway.payload.executionRequest.attemptId) : false;
  record("S08", "FR-003 / FR-007", "리더 호출 → 정규식이 아니라 판단 실행을 요청",
    planning ? "PASS" : "FAIL",
    planning ? "게이트웨이로 판단 실행 요청. 대화 맥락을 읽고 재구성한 뒤 제안이 올라간다" : "판단 실행이 나가지 않았다");

  const noEarlyButtons = result.accepted && !result.outbox.some((item) => item.payload.keyboard);
  record("S08b", "FR-005", "판단 전에는 승인 버튼을 올리지 않는다",
    noEarlyButtons ? "PASS" : "FAIL", noEarlyButtons ? "버튼 없음" : "판단 전에 버튼이 올라갔다");
}

{
  // 게이트웨이가 없는 경우의 대비 경로. 규칙 기반이라도 완료조건은 비지 않아야 한다.
  const fallbackPorts = { makeId: ports.makeId, now: ports.now };
  const decision = accept(messageUpdate(71, OWNER_USER, "@leader_chatroom_bot 결제가 안 되는 오류를 고쳐줘"));
  const result = handleTelegramInput(decision.input, authorization, fallbackPorts);
  const payload = result.accepted ? result.events[0]?.payload ?? {} : {};
  proposalId = payload.proposalId;
  const structured = Boolean(payload.completionCriteria) && Boolean(payload.scope);
  record("S09", "FR-007 / AC-03", "판단 경로가 없어도 목적·범위·완료조건은 구조화된다",
    structured ? "PASS" : "FAIL",
    structured ? `완료조건=${String(payload.completionCriteria).slice(0, 36)}...` : "구조화 없음");
}

// ============ 4. 승인 → 게이트웨이 ============

let gatewayOutbox;
{
  const decision = accept(callbackUpdate(9, OWNER_USER, `proposal:${proposalId}:approve`));
  const auth = authorizeTelegramInput(decision.input, authorization);
  const result = auth.allowed ? handleTelegramInput(decision.input, authorization, ports) : undefined;
  const approved = result?.accepted && result.events.some((event) => event.eventType === "owner_task_approved");
  gatewayOutbox = result?.accepted ? result.outbox.find((item) => item.target.kind === "local_gateway") : undefined;
  record("S11", "FR-008 / H-01 / AC-13", "방장 승인 → 게이트웨이 실행 요청 적재",
    approved && Boolean(gatewayOutbox) ? "PASS" : "FAIL",
    `approved=${approved} gatewayOutbox=${Boolean(gatewayOutbox)}`);
  const ack = result?.accepted && result.outbox.some((item) => item.payload.callbackQueryId || item.payload.callbackAnswer);
  record("S12", "NFR-04", "콜백 즉시 응답(버튼 로딩 해제) 발행",
    ack ? "PASS" : "GAP", ack ? "callback answer 발행" : "callback answer outbox 미확인");
}

// ============ 5. 게이트웨이 실행 → 산출물 ============

const workDir = mkdtempSync(join(tmpdir(), "huai-dryrun-"));
{
  const store = new FakeBotServiceStore();
  const executionRequest = {
    roomId: ports.executionDefaults.roomId,
    taskId: "33333333-3333-4333-8333-333333333333",
    attemptId: "attempt-dryrun",
    actorId: ports.executionDefaults.actorId,
    requestedBy: OWNER_USER,
    adapterType: "codex",
    projectPath: workDir,
    prompt: "로그인 세션 만료 버그 수정",
    timeoutMs: 60_000,
    idempotencyKey: "exec-dryrun",
    createdAt: ports.now()
  };
  await store.commitTelegramInputResult({
    message: { input: { kind: "message", envelope: undefined }, idempotencyKey: "seed", receivedAt: ports.now() },
    result: { accepted: true, authorization: { allowed: true }, events: [], outbox: [
      { target: { kind: "local_gateway", gatewayId: "primary" }, idempotencyKey: "gateway:attempt-dryrun", payload: { executionRequest } }
    ] }
  });

  const startedAtMs = Date.now();
  const collector = createArtifactCollector();
  const result = await runLocalGatewayConsumerOnce({
    store,
    policy: { allowedProjectRoots: [workDir], allowedAdapters: ["codex", "claude_code"], maxRuntimeMs: 60_000, allowNetwork: false },
    runner: { async run() {
      // 에이전트가 실제로 파일을 만든 상황을 재현한다.
      writeFileSync(join(workDir, "fix-report.md"), "# 로그인 세션 만료 수정\n원인과 조치를 기록한다.");
      writeFileSync(join(workDir, "session.ts"), "export const ttl = 3600;");
      return { exitCode: 0, stdout: "수정 완료. 테스트 통과.", stderr: "" };
    } },
    sink: { async publish() {} },
    artifacts: collector,
    limit: 5,
    leaseUntil: "2026-08-14T21:05:00.000Z",
    maxAttempts: 3,
    now: () => new Date(startedAtMs - 2000).toISOString()
  });

  const snapshot = store.snapshot();
  record("S13", "AC-13 / H-02", "게이트웨이가 승인 작업을 실행하고 결과를 기록",
    result.completed === 1 && snapshot.events.some((event) => event.eventType === "meaningful_intermediate_ready") ? "PASS" : "FAIL",
    `completed=${result.completed}`);

  record("S14", "H-03 / FR-019", "실행 산출물이 아티팩트로 등록됨",
    snapshot.artifacts.length >= 2 ? "PASS" : "FAIL",
    `artifacts=${snapshot.artifacts.length} (${snapshot.artifacts.map((a) => a.uri.split("/").pop()).join(", ")})`);

  const savedEvent = snapshot.events.find((event) => event.eventType === "artifact_saved");
  record("S15", "H-03 / NFR-02", "artifact_saved 이벤트 발행 (감사 추적)",
    savedEvent ? "PASS" : "FAIL", `idempotencyKey=${savedEvent?.idempotencyKey}`);

  record("S16", "H-03", "아티팩트 체크섬 기록 (변조 탐지 근거)",
    snapshot.artifacts.length > 0 && snapshot.artifacts.every((a) => typeof a.checksum === "string" && a.checksum.length === 64) ? "PASS" : "FAIL",
    `checksum=${snapshot.artifacts[0]?.checksum?.slice(0, 16)}...`);

  // 같은 attempt 재실행 → 중복 방지
  await store.commitTelegramInputResult({
    message: { input: { kind: "message", envelope: undefined }, idempotencyKey: "seed2", receivedAt: ports.now() },
    result: { accepted: true, authorization: { allowed: true }, events: [], outbox: [
      { target: { kind: "local_gateway", gatewayId: "primary" }, idempotencyKey: "gateway:attempt-dryrun:retry", payload: { executionRequest } }
    ] }
  });
  await runLocalGatewayConsumerOnce({
    store,
    policy: { allowedProjectRoots: [workDir], allowedAdapters: ["codex", "claude_code"], maxRuntimeMs: 60_000, allowNetwork: false },
    runner: { async run() { return { exitCode: 0, stdout: "재실행", stderr: "" }; } },
    sink: { async publish() {} },
    artifacts: collector,
    limit: 5,
    leaseUntil: "2026-08-14T21:06:00.000Z",
    maxAttempts: 3,
    now: () => new Date(startedAtMs - 2000).toISOString()
  });
  const after = store.snapshot();
  record("S17", "AC-12 / AC-14", "같은 attempt 재실행 시 아티팩트 중복 없음",
    snapshot.artifacts.length > 0 && after.artifacts.length === snapshot.artifacts.length ? "PASS" : "FAIL",
    `before=${snapshot.artifacts.length} after=${after.artifacts.length}`);
}

// 수집 실패 노출
{
  const store = new FakeBotServiceStore();
  const executionRequest = {
    roomId: ports.executionDefaults.roomId, taskId: "44444444-4444-4444-8444-444444444444",
    attemptId: "attempt-collect-fail", actorId: ports.executionDefaults.actorId, requestedBy: OWNER_USER,
    adapterType: "codex", projectPath: workDir, prompt: "작업", timeoutMs: 60_000,
    idempotencyKey: "exec-collect-fail", createdAt: ports.now()
  };
  await store.commitTelegramInputResult({
    message: { input: { kind: "message", envelope: undefined }, idempotencyKey: "seed3", receivedAt: ports.now() },
    result: { accepted: true, authorization: { allowed: true }, events: [], outbox: [
      { target: { kind: "local_gateway", gatewayId: "primary" }, idempotencyKey: "gateway:attempt-collect-fail", payload: { executionRequest } }
    ] }
  });
  await runLocalGatewayConsumerOnce({
    store,
    policy: { allowedProjectRoots: [workDir], allowedAdapters: ["codex", "claude_code"], maxRuntimeMs: 60_000, allowNetwork: false },
    runner: { async run() { return { exitCode: 0, stdout: "ok", stderr: "" }; } },
    sink: { async publish() {} },
    artifacts: { async collect() { throw new Error("disk-unavailable"); } },
    limit: 5, leaseUntil: "2026-08-14T21:07:00.000Z", maxAttempts: 3, now: () => ports.now()
  });
  const snapshot = store.snapshot();
  const resultEvent = snapshot.events.find((event) => event.eventType === "meaningful_intermediate_ready");
  const surfaced = JSON.stringify(resultEvent?.payload ?? {}).includes("artifact_collection_failed");
  record("S18", "NFR-09 / H-03", "산출물 수집 실패가 은폐되지 않고 기록됨",
    surfaced ? "PASS" : "FAIL", surfaced ? "artifact_collection_failed 이벤트 기록" : "실패가 흔적 없이 삼켜짐");
}

rmSync(workDir, { recursive: true, force: true });

// ============ 6. 상태기계 — 완료 게이트 ============

const ownerContext = { actorRole: "human_owner", isOwner: true, isAssignee: false, isVerifier: false,
  hasOwnerTaskApproval: true, hasVerificationPass: false, hasCommanderCompletionDecision: false, hasOwnerFinalApproval: false, idempotencyKey: "dry" };

{
  const skip = transitionTaskStatus("verification_in_progress", "owner_final_approved", ownerContext);
  record("S19", "FR-015 / AC-08", "검증 중 상태에서 방장 최종 승인으로 건너뛰기 차단",
    skip.allowed === false && isForbiddenTransition("verification_in_progress", "owner_final_approved") ? "PASS" : "FAIL",
    `allowed=${skip.allowed}`);
}

{
  const selfVerify = transitionTaskStatus("verification_pending", "verification_started",
    { ...ownerContext, actorRole: "auditor", isOwner: false, isVerifier: true, verifierActorId: "actor-1", authorActorId: "actor-1" });
  const independent = transitionTaskStatus("verification_pending", "verification_started",
    { ...ownerContext, actorRole: "auditor", isOwner: false, isVerifier: true, verifierActorId: "actor-2", authorActorId: "actor-1" });
  record("S20", "H-06 / AC-07", "작성자=검증자 차단, 독립 검증자만 통과",
    selfVerify.allowed === false && independent.allowed === true ? "PASS" : "FAIL",
    `self=${selfVerify.allowed} independent=${independent.allowed}`);
}

{
  const byOwner = transitionTaskStatus("commander_completion_pending", "commander_completion_approved", ownerContext);
  const byLeader = transitionTaskStatus("commander_completion_pending", "commander_completion_approved", { ...ownerContext, actorRole: "leader" });
  record("S21", "FR-015", "리더 완료 결정은 리더 역할만 가능",
    byOwner.allowed === false && byLeader.allowed === true ? "PASS" : "FAIL",
    `owner=${byOwner.allowed} leader=${byLeader.allowed}`);
}

{
  const final = transitionTaskStatus("completion_approval_pending", "owner_final_approved", ownerContext);
  record("S22", "FR-015 / H-11", "3단계 모두 거친 뒤에만 완료 전이",
    final.allowed === true && final.nextStatus === "completed" ? "PASS" : "FAIL", `next=${final.nextStatus}`);
}

{
  const pollute = transitionTaskStatus("completed", "execution_delayed_or_failed", ownerContext);
  record("S23", "NFR-02", "완료 후 실행 실패 이벤트로 상태 오염 불가",
    pollute.allowed === false ? "PASS" : "FAIL", `allowed=${pollute.allowed}`);
}

{
  const scope = transitionTaskStatus("completed", "post_completion_scope_change_requested", ownerContext);
  record("S24", "FR-016 / AC-10", "완료 후 범위 변경은 새 작업 카드로 분기",
    scope.allowed === false && scope.reason === "scope-change-requires-new-task" ? "GAP" : "FAIL",
    "상태기계는 범위 변경을 거부한다. 실제 요청은 routeFreeformMessage 가 새 제안으로 만들어 유실되지 않는다 — 남은 결함은 완료 작업과 새 카드 사이의 출처 연결 부재다");
}

// ============ 7. DAG ============

{
  const plan = planReadyTasks(
    [{ taskId: "t1", status: "completed" }, { taskId: "t2", status: "scheduled" },
     { taskId: "t3", status: "scheduled" }, { taskId: "t4", status: "scheduled", resourceKeys: ["src/a.ts"] },
     { taskId: "t5", status: "in_progress", resourceKeys: ["src/a.ts"] }],
    [{ predecessorTaskId: "t1", successorTaskId: "t2", dependencyType: "blocks", isBlocking: true },
     { predecessorTaskId: "t3", successorTaskId: "t3", dependencyType: "blocks", isBlocking: false }]
  );
  record("S25", "FR-010 / AC-04", "선행 완료 작업은 실행 가능, 리소스 충돌은 대기",
    plan.readyTaskIds.includes("t2") && plan.readyTaskIds.includes("t3") && plan.waitingTaskIds.includes("t4") ? "PASS" : "FAIL",
    `ready=${plan.readyTaskIds.join(",")} waiting=${plan.waitingTaskIds.join(",")}`);
}

// ============ 7-b. 승인 원장 (FR-008 / FR-015 / AC-08 / NFR-02) ============

{
  const decision = accept(callbackUpdate(21, OWNER_USER, `proposal:${proposalId ?? "proposal_0001"}:approve`));
  const result = handleTelegramInput(decision.input, authorization, ports);
  const event = result.accepted ? result.events[0] : undefined;
  const mapping = event ? approvalRecordForEvent(event.eventType) : undefined;
  const entityRef = event ? approvalEntityRefFromPayload(event.payload) : undefined;
  const decider = event ? approvalDeciderFromPayload(event.payload) : undefined;
  record("S31", "FR-008 / AC-08 / NFR-02", "방장 결정이 승인 원장 항목으로 확정됨",
    mapping?.stage === "task_approval" && mapping.decision === "approved" && Boolean(entityRef) && decider === OWNER_USER ? "PASS" : "FAIL",
    `stage=${mapping?.stage} decision=${mapping?.decision} entity_ref=${entityRef} decider=${decider}`);
}

{
  const stages = ["owner_task_approved", "commander_completion_approved", "owner_final_approved"]
    .map((eventType) => approvalRecordForEvent(eventType)?.stage);
  record("S35", "FR-015 / AC-08", "3단계 완료 게이트가 각각 별도 승인 단계로 기록됨",
    stages.join(",") === "task_approval,commander_completion,final_approval" ? "PASS" : "FAIL",
    `stages=${stages.join(" -> ")}`);
}

{
  const nonApproval = ["proposal_created", "task_started", "artifact_saved"].every((eventType) => !approvalRecordForEvent(eventType));
  record("S36", "NFR-02", "승인이 아닌 이벤트는 승인 원장을 오염시키지 않음",
    nonApproval ? "PASS" : "FAIL", "제안생성·작업시작·산출물저장은 원장 대상 아님");
}

// ============ 8. 중간 승인·보완·재검증 ============

const WORKFLOW_TASK_ID = "66666666-6666-4666-8666-666666666666";
const AFFECTED_TASK_ID = "88888888-8888-4888-8888-888888888888";

{
  const probe = createApprovalWorkflowProbe("scheduled");
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "dry-run", fetchImpl: probe.fetchImpl });
  const midpointText = `MID_APPROVAL_START\n${JSON.stringify({
    reportId: "99999999-9999-4999-8999-999999999999",
    approvalRequestId: "mid-dry-run",
    summary: "후속 구현이 의존하는 데이터 모델을 확정했습니다.",
    significanceReason: "영향받는 작업의 저장 형식이 달라집니다.",
    affectedTaskIds: [AFFECTED_TASK_ID]
  })}\nMID_APPROVAL_END`;
  await store.recordGatewayExecutionResult({
    request: workflowExecutionRequest("mid-dry-run", "codex_leader"),
    status: "completed",
    events: [{ type: "stdout", taskId: WORKFLOW_TASK_ID, attemptId: "mid-dry-run", text: midpointText }],
    occurredAt: ports.now()
  });
  const callback = accept(callbackUpdate(260, OWNER_USER, `task:${WORKFLOW_TASK_ID}:mid_approve`));
  const callbackAuth = callback.kind === "accepted" ? authorizeTelegramInput(callback.input, authorization) : { allowed: false };
  const approval = callback.kind === "accepted" && callbackAuth.allowed
    ? handleTelegramInput(callback.input, authorization, ports)
    : undefined;
  const approvalEvent = approval?.accepted ? approval.events[0] : undefined;
  const resumed = approvalEvent
    ? transitionTaskStatus(probe.status(), approvalEvent.eventType, ownerContext)
    : { allowed: false };
  const passed = probe.hasEvent("mid_approval_required") &&
    probe.wroteTable("huai_reports") && probe.wroteTable("huai_task_dependencies") &&
    probe.status() === "mid_approval_pending" &&
    approvalEvent?.eventType === "owner_mid_approved" && resumed.allowed && resumed.nextStatus === "in_progress" &&
    approval?.accepted && approval.outbox.some((item) => item.target.kind === "local_gateway" && item.idempotencyKey.startsWith("gateway:mid-continuation:"));
  record("S26", "FR-011 / H-05 / AC-06", "중간 승인 게이트", passed ? "PASS" : "FAIL",
    `event=${probe.hasEvent("mid_approval_required")} status=${probe.status()} affected=${probe.wroteTable("huai_task_dependencies")} approval=${approvalEvent?.eventType ?? "none"}`);
}

{
  const probe = createApprovalWorkflowProbe("verification_in_progress");
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "dry-run", fetchImpl: probe.fetchImpl });
  await store.recordGatewayExecutionResult({
    request: { ...workflowExecutionRequest("audit-fail", "auditor"), workerAdapterType: "codex" },
    status: "completed",
    events: [{ type: "stdout", taskId: WORKFLOW_TASK_ID, attemptId: "audit-fail", text: "검증 불합격. 입력 검증을 보완해야 합니다." }],
    occurredAt: ports.now()
  });
  const revisionRequest = probe.outboxExecution("gateway:revision:");
  if (revisionRequest) {
    await store.recordGatewayExecutionResult({
      request: revisionRequest,
      status: "completed",
      events: [{ type: "stdout", taskId: WORKFLOW_TASK_ID, attemptId: revisionRequest.attemptId, text: "입력 검증 보완 완료" }],
      occurredAt: ports.now()
    });
  }
  const passed = probe.wroteTable("huai_revision_requests") &&
    probe.hasEvent("verification_failed_or_changes_requested") &&
    probe.hasEvent("revision_submitted") &&
    probe.hasRevisionSubmission("content") &&
    probe.status() === "reverification_pending" &&
    probe.hasOutbox("gateway:single-worker-audit:");
  record("S27", "FR-014 / H-07 / H-08", "검증 불합격 → 보완 → 재검증 루프", passed ? "PASS" : "FAIL",
    `failed=${probe.hasEvent("verification_failed_or_changes_requested")} revision=${Boolean(revisionRequest)} submitted=${probe.hasEvent("revision_submitted")} status=${probe.status()}`);
}

{
  const probe = createApprovalWorkflowProbe("revision_requested");
  const store = new SupabaseOutboxStore({ url: "https://example.supabase.co", serviceRoleKey: "dry-run", fetchImpl: probe.fetchImpl });
  const changedScope = classifyRevisionChangedScope("오탈자와 서식만 수정");
  await store.recordGatewayExecutionResult({
    request: {
      ...workflowExecutionRequest("format-revision", "codex_leader"),
      revisionContext: {
        revisionRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        priorVerificationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        changedScope,
        reverifyScope: "표현과 서식"
      }
    },
    status: "completed",
    events: [{ type: "stdout", taskId: WORKFLOW_TASK_ID, attemptId: "format-revision", text: "형식 보완 완료" }],
    occurredAt: ports.now()
  });
  const passed = changedScope === "format_only" && probe.hasRevisionSubmission("format_only") &&
    probe.status() === "commander_completion_pending" && !probe.hasOutbox("gateway:single-worker-audit:");
  record("S33", "AC-09", "보완 유형 분기 (내용 변경 vs 형식 수정)", passed ? "PASS" : "FAIL",
    `changedScope=${changedScope} status=${probe.status()} fullAudit=${probe.hasOutbox("gateway:single-worker-audit:")}`);
}

function workflowExecutionRequest(attemptId, reportBotRole) {
  return {
    roomId: ports.executionDefaults.roomId,
    taskId: WORKFLOW_TASK_ID,
    attemptId,
    actorId: ports.executionDefaults.actorId,
    requestedBy: OWNER_USER,
    adapterType: "codex",
    projectPath: ports.executionDefaults.projectPath,
    prompt: "dry-run workflow",
    timeoutMs: ports.executionDefaults.timeoutMs,
    idempotencyKey: `dry-run:${attemptId}`,
    createdAt: ports.now(),
    reportBotRole
  };
}

function createApprovalWorkflowProbe(initialStatus) {
  let taskStatus = initialStatus;
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = String(input);
    const method = String(init?.method ?? "GET");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, method, body });
    const path = url.split("/rest/v1")[1] ?? url;
    if (path.includes("huai_rooms")) return workflowJson(200, [{ telegram_chat_id: CHAT_ID }]);
    if (path.includes("huai_tasks") && method === "GET") return workflowJson(200, [{ status: taskStatus }]);
    if (path.includes("huai_tasks") && method === "PATCH") {
      taskStatus = body.status;
      return workflowJson(200, []);
    }
    if (path.includes("huai_gateway_instances") && method === "GET") return workflowJson(200, [{ gateway_id: "primary" }]);
    if (path.includes("huai_verifications") && method === "POST") return workflowJson(201, [{ verification_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]);
    if (path.includes("huai_revision_requests") && method === "GET") return workflowJson(200, []);
    if (path.includes("huai_revision_requests") && method === "POST") return workflowJson(201, [{ revision_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]);
    if (path.includes("huai_events") && method === "POST") return workflowJson(201, [{ event_id: `event-${body.idempotency_key}`, ...body, created_at: ports.now() }]);
    return workflowJson(200, []);
  };
  return {
    fetchImpl,
    status: () => taskStatus,
    hasEvent: (eventType) => requests.some((request) => request.body?.event_type === eventType),
    wroteTable: (table) => requests.some((request) => request.method === "POST" && request.url.endsWith(`/${table}`)),
    hasOutbox: (prefix) => requests.some((request) => String(request.body?.idempotency_key ?? "").startsWith(prefix)),
    outboxExecution: (prefix) => requests.find((request) => String(request.body?.idempotency_key ?? "").startsWith(prefix))?.body?.payload?.executionRequest,
    hasRevisionSubmission: (scope) => requests.some((request) => request.method === "PATCH" && request.url.includes("huai_revision_requests") && request.body?.changed_scope === scope)
  };
}

function workflowJson(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ============ 9. 미구현 확인 (도달 불가 단계) ============

const unreachable = [
  ["S28", "FR-002 / FR-004 / H-13 / AC-11", "참여자 초대·퇴장·AI 퇴장 제안", "관련 명령·이벤트·쓰기 경로 전무"],
  ["S29", "FR-018", "보조 수단 선택 (워크트리·토론·투표·A2A·MCP)", "코드 없음"],
  ["S30", "NFR-08", "백업·복구", "huai_recovery_snapshots 미배선"],
  ["S32", "FR-020", "고정 현황 메시지 편집 갱신", "buildProjectStatusMessage 호출처 없음, editMessageId 생산자 없음"],
  ["S34", "AC-14", "attempt 단위 재개", "huai_execution_attempts 미배선 — outbox lease 로만 대체"]
];
for (const [id, requirement, title, detail] of unreachable) {
  record(id, requirement, title, "BLOCKED", detail);
}

// ============ 결과 출력 ============

const width = { id: 4, req: 26 };
console.log("HuAI Collab Chatroom — 기획서 운영 시나리오 드라이런\n");
console.log(`${"ID".padEnd(width.id)} ${"요구사항".padEnd(width.req)} 판정     시나리오`);
console.log("-".repeat(110));
for (const step of steps) {
  console.log(`${step.id.padEnd(width.id)} ${step.requirement.padEnd(width.req)} ${step.status.padEnd(8)} ${step.title}`);
  if (step.detail) console.log(`${" ".repeat(width.id + width.req + 11)}${step.detail}`);
}

const counts = steps.reduce((acc, step) => ({ ...acc, [step.status]: (acc[step.status] ?? 0) + 1 }), {});
console.log("-".repeat(110));
console.log(`드라이런 결과: PASS=${counts.PASS ?? 0} GAP=${counts.GAP ?? 0} BLOCKED=${counts.BLOCKED ?? 0} FAIL=${counts.FAIL ?? 0} (총 ${steps.length})`);
console.log("");
console.log("PASS    = 실제로 돌려서 동작 확인");
console.log("GAP     = 동작은 하나 기획서 요구를 부분적으로만 충족");
console.log("BLOCKED = 구현이 없어 시나리오 자체에 진입 불가");
console.log("FAIL    = 동작해야 하는데 실패");

if ((counts.FAIL ?? 0) > 0) {
  console.error("\n드라이런 실패 항목이 있다.");
  process.exit(1);
}
