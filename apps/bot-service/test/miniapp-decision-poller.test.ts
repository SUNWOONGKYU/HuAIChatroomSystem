import assert from "node:assert/strict";
import test from "node:test";
import {
  runMiniAppDecisionPollOnce,
  type MiniAppDecisionOutcomeEvent,
  type MiniAppDecisionPollerOptions
} from "../src/miniapp-decision-poller.js";
import { type OrchestratorPersistencePort, type PersistedEvent, type PersistedOutboxItem } from "../src/persistence.js";
import { type TelegramInboundQueueMessage, TelegramUpdateEnvelope } from "../../../packages/contracts/src/index.js";
import { type TelegramInputHandlingResult } from "../../../packages/orchestrator/src/index.js";
import { SupabaseBotServiceStore } from "../src/supabase-store.js";
import { MiniSupabaseFake, type MiniRow } from "./mini-supabase-fake.js";

const roomA = { roomId: "room-a", telegramChatId: "1001" };
const roomB = { roomId: "room-b", telegramChatId: "1002" };
const ownerA = "2001";
const ownerB = "2002";

test("an unprocessed approved decision is replayed and reaches commitTelegramInputResult", async () => {
  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({ approvalId: "a1", roomId: roomA.roomId, entityRef: "proposal_x", stage: "task_approval", decision: "approved", decider: ownerA, createdAt: "2026-08-15T00:00:00.000Z" }));
  const persistence = new FakePersistence();

  const result = await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA]));

  assert.equal(result.fetched, 1);
  assert.equal(result.replayed, 1);
  assert.equal(persistence.commits.length, 1);
  const committedInput = persistence.commits[0]!.message.input;
  assert.equal(committedInput.kind, "callback");
  assert.equal(committedInput.envelope.telegramChatId, roomA.telegramChatId);
  assert.equal(committedInput.envelope.telegramUserId, ownerA);
  assert.equal(backend.processed.get("a1")?.outcome, "replayed");
});

// 제안 승인(Echo 분대가 Mini App 에 붙이는 신규 결정 종류): entity_ref 가 task UUID 가
// 아니라 제안 id(proposal_<uuid> 또는 소대장 판단이 만든 p_<16hex> 축약형) 이고,
// task_id 컬럼은 null 이다 — huai_tasks 행이 아직 없기 때문이다(제안 승인 시점엔
// hydrateExecutionOutboxPrompts 가 그제서야 task 를 물질화한다). 폴러는 이 문자열을
// 파싱하지 않고 그대로 entityId 로 넘겨야 한다 — 파싱하면 그 자체가 store 쪽
// 로직(recordApprovals/taskIdFromEventPayload)의 복제다. 실제 task 물질화·아웃박스
// 발행 자체는 commitTelegramInputResult 내부(Bravo 담당, 별도 스위트에서 검증됨)의
// 일이므로 여기서는 "합성 입력이 올바른 모양으로 그 경로에 들어가는가"만 확인한다.
test("a proposal decision (non-UUID entity_ref, task_id null) is passed through without parsing its format", async () => {
  for (const proposalId of ["proposal_11111111-1111-4111-8111-111111111111", "p_0123456789abcdef"]) {
    const backend = new FakeMiniAppBackend();
    backend.approvals.push({
      approval_id: `approval-for-${proposalId}`,
      task_id: null,
      room_id: roomA.roomId,
      stage: "task_approval",
      decider_telegram_user_id: ownerA,
      decision: "approved",
      reason: null,
      created_at: "2026-08-15T00:00:00.000Z",
      idempotency_key: `fixture:${proposalId}`,
      entity_ref: proposalId
    });
    const persistence = new FakePersistence();

    const result = await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA]));

    assert.equal(result.replayed, 1, `expected a replay for proposal id shape: ${proposalId}`);
    assert.equal(persistence.commits.length, 1);
    const committedInput = persistence.commits[0]!.message.input;
    assert.equal(committedInput.kind, "callback");
    assert.equal(committedInput.kind === "callback" && committedInput.callback.entityId, proposalId, "entityId must be the raw proposal id, untouched");
    assert.equal(committedInput.kind === "callback" && committedInput.callback.entity, "proposal");
  }
});

// 재시작해도 이미 처리한 결정을 다시 처리하면 안 된다. FakeMiniAppBackend 는
// 커서·processed 테이블 상태를 프로세스 재시작과 무관하게 보존하는 실제 DB 역할을
// 하므로, 같은 backend 로 poller 를 다시 "새로" 호출하는 것 자체가 재시작 시뮬레이션이다.
test("restarting the poller does not reprocess an already-replayed decision", async () => {
  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({ approvalId: "a1", roomId: roomA.roomId, entityRef: "proposal_x", stage: "task_approval", decision: "approved", decider: ownerA, createdAt: "2026-08-15T00:00:00.000Z" }));
  const persistence = new FakePersistence();

  await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA]));
  assert.equal(persistence.commits.length, 1);

  // "재시작" — 새 poller 호출, 같은 backend(=같은 DB 상태), 새 persistence 인스턴스가
  // 아니라 같은 persistence 를 계속 써도 되지만, 재시작 시나리오를 더 정확히 흉내내려면
  // FakePersistence 도 새로 만들어 이전 실행의 인메모리 흔적을 지운다.
  const persistenceAfterRestart = new FakePersistence();
  const result = await runMiniAppDecisionPollOnce(options(backend, persistenceAfterRestart, [roomA]));

  // 커서는 gte 로 경계행을 다시 훑을 수 있으므로 fetched 는 0 이 아닐 수 있다(허용된
  // 재조회) — 하지만 processed-set 체크로 재실행은 절대 없어야 한다.
  assert.equal(result.replayed, 0);
  assert.equal(persistenceAfterRestart.commits.length, 0, "no new commit on restart replay of an already-processed decision");
});

// 꺼져 있던 동안 쌓인 결정 여러 건을, 켜지면 커서 시작점부터 전부 처리해야 한다.
test("decisions accumulated while the poller was offline are all processed once it starts", async () => {
  const backend = new FakeMiniAppBackend();
  for (let i = 0; i < 5; i += 1) {
    backend.approvals.push(approvalRow({
      approvalId: `offline-${i}`,
      roomId: roomA.roomId,
      entityRef: `proposal_${i}`,
      stage: "task_approval",
      decision: "approved",
      decider: ownerA,
      createdAt: `2026-08-15T00:0${i}:00.000Z`
    }));
  }
  const persistence = new FakePersistence();

  const result = await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA]));

  assert.equal(result.fetched, 5);
  assert.equal(result.replayed, 5);
  assert.equal(persistence.commits.length, 5);
});

// 같은 (room, entity_ref, stage) 에 결정이 두 번 들어와도(중복 클릭, 혹은 Telegram +
// Mini App 이중 창구) 실행은 시간순 첫 결정 한 번만 나가야 한다.
test("the same entity+stage decided twice only executes once, via the earlier decision", async () => {
  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({ approvalId: "first", roomId: roomA.roomId, entityRef: "proposal_dup", stage: "task_approval", decision: "approved", decider: ownerA, createdAt: "2026-08-15T00:00:00.000Z" }));
  backend.approvals.push(approvalRow({ approvalId: "second", roomId: roomA.roomId, entityRef: "proposal_dup", stage: "task_approval", decision: "approved", decider: ownerA, createdAt: "2026-08-15T00:01:00.000Z" }));
  const persistence = new FakePersistence();

  const result = await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA]));

  assert.equal(result.fetched, 2);
  assert.equal(result.replayed, 1, "only the chronologically first decision replays");
  assert.equal(result.skipped, 1);
  assert.equal(persistence.commits.length, 1);
  assert.equal(backend.processed.get("first")?.outcome, "replayed");
  assert.equal(backend.processed.get("second")?.outcome, "skipped_duplicate");
});

// 회귀 재현: 같은 (room_id, entity_ref, stage) 에 서로 다른 decision 이 시간순으로
// 두 번 오는 건 "정당한 재결정"이지 중복이 아니다 — 예: 보완 요청(revision_requested)
// 뒤에 재작업이 끝나 완료 승인(approved)이 오는 경우. 이전 dedup 키가 decision 을
// 안 보고 (room_id, entity_ref, stage) 만 봤다면, 두 번째(진짜 새 결정인 approved)가
// "중복"으로 걸러져 재생되지 않는다 — 그러면 재작업이 끝났는데 완료 승인이 조용히
// 무시되고 task 가 영영 안 끝난다.
test("a different decision for the same entity+stage (revision_requested then approved) is not treated as a duplicate — both replay", async () => {
  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({ approvalId: "revision-1", roomId: roomA.roomId, entityRef: "task-lifecycle", stage: "final_approval", decision: "revision_requested", decider: ownerA, createdAt: "2026-08-15T00:00:00.000Z" }));
  backend.approvals.push(approvalRow({ approvalId: "approve-2", roomId: roomA.roomId, entityRef: "task-lifecycle", stage: "final_approval", decision: "approved", decider: ownerA, createdAt: "2026-08-15T00:01:00.000Z" }));
  const persistence = new FakePersistence();

  const result = await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA]));

  assert.equal(result.fetched, 2);
  assert.equal(result.replayed, 2, "both decisions are real, distinct decisions and must both execute — neither is a duplicate of the other");
  assert.equal(persistence.commits.length, 2);
  assert.equal(backend.processed.get("revision-1")?.outcome, "replayed");
  assert.equal(backend.processed.get("approve-2")?.outcome, "replayed", "the completion approval must not be silently dropped as a false duplicate — this is how a task would get stuck forever");
});

// 방 하나의 결정 처리가 실패해도(여기서는 알 수 없는 room_id로 유발) 같은 배치에
// 있는 다른 방의 결정은 섞이거나 유실되지 않고 그대로 처리돼야 한다 — Telegram
// 드레인 루프에서 고친 것과 같은 종류의 배치 오염/아사 회귀를 여기서도 막는다.
test("a failing decision in one room does not block or lose a sibling room's decision in the same batch", async () => {
  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({ approvalId: "broken-room", roomId: "room-does-not-exist", entityRef: "proposal_broken", stage: "task_approval", decision: "approved", decider: ownerA, createdAt: "2026-08-15T00:00:00.000Z" }));
  backend.approvals.push(approvalRow({ approvalId: "healthy-room", roomId: roomB.roomId, entityRef: "proposal_ok", stage: "task_approval", decision: "approved", decider: ownerB, createdAt: "2026-08-15T00:01:00.000Z" }));
  const persistence = new FakePersistence();

  // roomsById 에 roomA 만 등록하고 "room-does-not-exist" 는 등록하지 않아 unknown-room 으로
  // 실패를 유발한다. roomB 는 정상 등록한다.
  const result = await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA, roomB]));

  assert.equal(result.failed, 1);
  assert.equal(result.replayed, 1, "room B's decision must still replay despite room A's failure earlier in the batch");
  assert.equal(persistence.commits.length, 1);
  assert.equal(persistence.commits[0]!.message.input.envelope.telegramChatId, roomB.telegramChatId);
  assert.equal(backend.processed.has("broken-room"), false, "the failed decision must not be marked processed (must retry)");
  assert.equal(backend.processed.get("healthy-room")?.outcome, "replayed");

  // 다음 주기에도 실패한 방의 결정은 다시 잡혀야 한다(커서가 그 지점 이전에 묶여야 함).
  const secondRun = await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA, roomB]));
  assert.equal(secondRun.fetched, 2, "the cursor must not have advanced past the unresolved failure");
  assert.equal(secondRun.failed, 1);
  assert.equal(secondRun.replayed, 0, "room B's decision was already processed and must not replay again");
});

// executionDefaults 가 없는 방(A-5)의 결정: orchestrator 는 더 이상 던지지 않는다
// (Delta 분대가 packages/orchestrator 에서 이 경로를 고쳐, executionDefaults 가 없으면
// "이 방은 아직 실행 준비가 되지 않았습니다" 안내를 accepted:true 로 돌려주도록
// 바뀌었다 — buildOwnerActionOutbox 의 owner_task_approved 분기 참고). 그 결과 이
// 폴러 입장에서는 예외가 아니라 정상적인 "재생" 이 되고, 실행 대신 안내 메시지가
// 커밋된다. 이 테스트는 그 안내가 실제로 담겨서 commitTelegramInputResult 까지
// 가는지 확인한다 — 예전 기대(예외로 실패해 무한 재시도)는 더 이상 유효하지 않다.
test("a decision in a room without execution defaults still replays, delivering a not-configured notice instead of throwing", async () => {
  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({ approvalId: "no-defaults", roomId: roomA.roomId, entityRef: "proposal_no_defaults", stage: "task_approval", decision: "approved", decider: ownerA, createdAt: "2026-08-15T00:00:00.000Z" }));
  const persistence = new FakePersistence();

  const outcomes: MiniAppDecisionOutcomeEvent[] = [];
  const opts = options(backend, persistence, [roomA], { executionDefaultsMissing: true });
  opts.onDecisionOutcome = (event) => outcomes.push(event);

  const result = await runMiniAppDecisionPollOnce(opts);

  assert.equal(result.failed, 0);
  assert.equal(result.replayed, 1);
  assert.equal(persistence.commits.length, 1);
  const outboxTexts = persistence.commits[0]!.result.outbox.map((item) => (item.payload as { text?: string }).text ?? "");
  assert.ok(
    outboxTexts.some((text) => text.includes("실행 준비가 되지 않았습니다")),
    "the room must receive a visible notice instead of the decision silently vanishing"
  );
  assert.equal(outcomes[0]?.outcome, "replayed");
  assert.equal(backend.processed.get("no-defaults")?.outcome, "replayed");
});

// ---------------------------------------------------------------------------
// approvalEventIdempotencyKey 통합 확인 (Delta 의 orchestrator 훅).
//
// 위 테스트들은 전부 FakePersistence 를 써서 poller 자체의 로직만 검증한다 —
// commitTelegramInputResult 로 실제로 뭘 보내는지까지는 확인하지 않는다. Delta 는
// "orchestrator 가 주입값을 이벤트 키로 내보내는가"까지만(순수 함수 범위) 검증했고,
// "그 키가 실제 huai_approvals INSERT 에서 409 로 흡수되는가" 와 "그 흡수가 실행
// 아웃박스 발행을 막지 않는가"는 DB 왕복이 필요해 폴러 쪽 몫이라고 명시했다. 그래서
// 여기서는 REAL SupabaseBotServiceStore + MiniSupabaseFake(다른 분대가 이미 만든
// in-memory Supabase 모사체, room-isolation 테스트에서 검증된 실제 쿼리 파싱)를
// 붙여서 끝까지 확인한다.
// ---------------------------------------------------------------------------

test("replaying with the original approval's idempotency key does not add a second huai_approvals row, and execution still fires", async () => {
  const mini = new MiniSupabaseFake();
  mini.seed("huai_rooms", [{ room_id: roomA.roomId, telegram_chat_id: roomA.telegramChatId, status: "active" }]);
  // 이 행은 Echo 의 Mini App 백엔드가 승인 시점에 이미 실제 DB 에 써 둔 원본 행을
  // 흉내낸다. idempotency_key 를 폴러가 그대로 주입하면 recordApprovals 의 두 번째
  // INSERT 가 바로 이 행과 충돌해 409 를 받아야 한다.
  mini.seed("huai_approvals", [{
    approval_id: "orig-approval",
    room_id: roomA.roomId,
    entity_ref: "task-x",
    stage: "task_approval",
    decision: "approved",
    decider_telegram_user_id: Number(ownerA),
    idempotency_key: "original-key-123",
    created_at: "2026-08-15T00:00:00.000Z"
  }]);

  const store = new SupabaseBotServiceStore({ url: "https://example.supabase.co", serviceRoleKey: "test-key", fetchImpl: mini.fetchImpl });

  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({
    approvalId: "orig-approval",
    roomId: roomA.roomId,
    entityRef: "task-x",
    stage: "task_approval",
    decision: "approved",
    decider: ownerA,
    createdAt: "2026-08-15T00:00:00.000Z",
    idempotencyKey: "original-key-123"
  }));

  const result = await runMiniAppDecisionPollOnce(options(backend, store, [roomA]));

  assert.equal(result.replayed, 1, "the decision must still replay successfully despite the 409");
  assert.equal(mini.tables.huai_approvals?.length, 1, "no second ledger row — the 409 must be absorbed, matching recordApprovals's existing 409-swallow behavior");
  assert.ok(
    mini.tables.huai_outbox?.some((row) => row.target_kind === "local_gateway"),
    "the ledger absorption must not block the actual execution outbox row from being inserted"
  );
});

test("replaying a decision with a null idempotency key auto-generates one and still fires execution (unchanged behavior)", async () => {
  const mini = new MiniSupabaseFake();
  mini.seed("huai_rooms", [{ room_id: roomA.roomId, telegram_chat_id: roomA.telegramChatId, status: "active" }]);
  // huai_approvals 는 비워 둔다 — Echo 쪽 원본 행에 idempotency_key 가 없었다고
  // 가정한 시나리오다(null). 폴러는 undefined 를 주입하고, orchestrator 는 기존과
  // 동일하게 자동 키를 생성해야 한다.

  const store = new SupabaseBotServiceStore({ url: "https://example.supabase.co", serviceRoleKey: "test-key", fetchImpl: mini.fetchImpl });

  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({
    approvalId: "fresh-approval",
    roomId: roomA.roomId,
    entityRef: "task-y",
    stage: "task_approval",
    decision: "approved",
    decider: ownerA,
    createdAt: "2026-08-15T00:00:00.000Z",
    idempotencyKey: null
  }));

  const result = await runMiniAppDecisionPollOnce(options(backend, store, [roomA]));

  assert.equal(result.replayed, 1);
  assert.equal(mini.tables.huai_approvals?.length, 1, "a fresh row is written with an auto-generated key, same as before this hook existed");
  assert.ok(mini.tables.huai_approvals?.[0]?.idempotency_key, "an idempotency_key must still be generated, not left empty");
  assert.ok(
    mini.tables.huai_outbox?.some((row) => row.target_kind === "local_gateway"),
    "execution must still fire for a freshly-keyed decision"
  );
});

// 회귀 재현: 폴러는 huai_approvals 를 origin 구분 없이 전부 읽는다. Telegram 실시간
// 흐름이 이미 처리한 결정도 huai_approvals 에 행이 남으므로, 폴러가 이 행을 그냥
// 다시 만나 재생을 시도하면 어떻게 되는가? Telegram 쪽이 이미 같은 idempotency_key
// 로 huai_events 행을 만들어 놨다면(recordApprovals 가 event.idempotencyKey 를
// 그대로 씀), 폴러의 재생 시도는 huai_events insert 에서 그 키와 충돌한다 —
// huai_events 는 409 를 흡수하지 않으므로(팀 지시로 이미 확인된 사실) 예외로
// 실패하고, 실패는 processed 로 안 남으므로 매 주기 영원히 재시도된다.
test("a decision huai_approvals row that Telegram's real-time flow already executed is not retried forever as a phantom failure", async () => {
  const telegramStyleKey = "owner_task_approved:realbot:77:task-existing";
  const mini = new MiniSupabaseFake();
  mini.seed("huai_rooms", [{ room_id: roomA.roomId, telegram_chat_id: roomA.telegramChatId, status: "active" }]);
  // Telegram 의 실시간 흐름이 이미 만든 승인 원장 행 + 이벤트 행(같은 키)을 그대로 흉내낸다.
  mini.seed("huai_approvals", [{
    approval_id: "telegram-origin-approval",
    room_id: roomA.roomId,
    entity_ref: "task-existing",
    stage: "task_approval",
    decision: "approved",
    decider_telegram_user_id: Number(ownerA),
    idempotency_key: telegramStyleKey,
    created_at: "2026-08-15T00:00:00.000Z"
  }]);
  mini.seed("huai_events", [{
    event_id: "evt-telegram-origin",
    room_id: roomA.roomId,
    event_type: "owner_task_approved",
    idempotency_key: telegramStyleKey,
    payload: { entityId: "task-existing" },
    created_at: "2026-08-15T00:00:00.000Z"
  }]);

  const store = new SupabaseBotServiceStore({ url: "https://example.supabase.co", serviceRoleKey: "test-key", fetchImpl: mini.fetchImpl });

  // 폴러 자신의 huai_approvals 조회와 store 의 huai_events 조회가 같은 mini 를
  // 봐야 "Telegram 이 이미 만든 이벤트" 를 폴러가 실제로 발견할 수 있다 — 위 주석 참고.
  const backend = new FakeMiniAppBackend();
  const result = await runMiniAppDecisionPollOnce(options(backend, store, [roomA], { fetchImpl: mini.fetchImpl }));

  assert.equal(result.failed, 0, "a Telegram-already-executed decision must not surface as a poller failure (it would retry forever)");
  assert.equal(mini.tables.huai_events?.length, 1, "no second event must be inserted for a decision already recorded");
  const processedRow = mini.tables.huai_miniapp_decision_processed?.find((row) => row.approval_id === "telegram-origin-approval");
  assert.equal(processedRow?.outcome, "skipped_already_executed", "must be marked resolved so it is not refetched and retried every cycle");
});

// 재검토 재현: tuple dedup((room_id, entity_ref, stage, decision))이 지금도 필요한가?
// 세 층(processed-set, 아웃박스 idempotency, eventAlreadyRecorded)이 이미 있는데
// tuple dedup 이 여전히 막는 게 있는가를 실측으로 답한다.
//
// final_approval/approved 는 실행 아웃박스를 안 만든다(owner_final_approved 는
// makeRoleMessageOutbox 알림만 반환, orchestrator/index.ts) — 아웃박스 idempotency
// 층(Delta 의 gateway:execution:<entityId>)이 아예 걸리지 않는 경로다.
// eventAlreadyRecorded 는 "이 행 자신의 idempotency_key" 로만 판단하므로, 크로스
// 플랫폼 중복(서로 다른 approval_id, 서로 다른 idempotency_key, 같은 실제 결정)은
// 그 검사를 통과한다. 그러면 두 번째 결정은 applyTaskTransitions 까지 도달하고,
// task 가 이미 completed 로 전이됐으므로 transitionTaskStatus 가
// {allowed:false, reason:"transition-not-allowed"} 를 반환해 supabase-store.ts 가
// 던진다 — huai_events unique 충돌과 똑같은 모양의 "실패는 processed 로 안 남아
// 매 주기 영원히 재시도되는 유령 실패" 가 다시 열린다. 이번엔 세 층 중 어느 것도
// 못 막는다.
test("tuple dedup is still required — without it, a cross-platform duplicate final_approval/approved becomes a phantom retry-forever failure", async () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const mini = new MiniSupabaseFake();
  mini.seed("huai_rooms", [{ room_id: roomA.roomId, telegram_chat_id: roomA.telegramChatId, status: "active" }]);
  mini.seed("huai_tasks", [{
    task_id: taskId,
    room_id: roomA.roomId,
    status: "completion_approval_pending",
    title: "t", purpose: "p", scope: "s", completion_criteria: "c"
  }]);

  const firstDecision = approvalRow({
    approvalId: "telegram-final-approve",
    roomId: roomA.roomId,
    entityRef: taskId,
    stage: "final_approval",
    decision: "approved",
    decider: ownerA,
    createdAt: "2026-08-15T00:00:00.000Z",
    idempotencyKey: "owner_final_approved:realbot:1:" + taskId // Telegram 형식
  });
  const secondDecision = approvalRow({
    approvalId: "miniapp-final-approve",
    roomId: roomA.roomId,
    entityRef: taskId,
    stage: "final_approval",
    decision: "approved",
    decider: ownerA,
    createdAt: "2026-08-15T00:01:00.000Z",
    idempotencyKey: "miniapp:approve:" + taskId + ":completion_approval_pending" // Echo 형식, 다른 문자열
  });

  // 폴러 자신의 huai_approvals 조회와 store 의 huai_events/huai_tasks 조회가 같은
  // mini 를 봐야 한다(§9 의 교차 테이블 시나리오와 동일한 이유) — 그래서 여기서는
  // backend.approvals 가 아니라 mini 자체에 승인 행을 시딩한다.
  mini.seed("huai_approvals", [
    firstDecision as unknown as MiniRow,
    secondDecision as unknown as MiniRow
  ]);

  // tuple dedup 이 켜진 정상 코드: 두 번째는 replay 전에 스킵돼야 한다 — transition
  // 층까지 아예 도달하지 않으므로 유령 실패가 열릴 자리가 없다.
  const backend = new FakeMiniAppBackend();
  const result = await runMiniAppDecisionPollOnce(options(backend, store(mini), [roomA], { fetchImpl: mini.fetchImpl }));

  assert.equal(result.failed, 0, "with tuple dedup active, the duplicate must never reach the transition layer");
  assert.equal(result.replayed, 1, "only the first (chronologically earlier) decision executes");
  const secondOutcome = mini.tables.huai_miniapp_decision_processed?.find((row) => row.approval_id === "miniapp-final-approve");
  assert.equal(secondOutcome?.outcome, "skipped_duplicate");
});

// ---------------------------------------------------------------------------
// 반복 결정 재현: "보완 요청 → 재작업 → 다시 completion_approval_pending →
// 또 보완 요청"(같은 stage, 같은 decision, 두 번째 라운드) 이 실제로 어디서
// 막히는가. Echo 의 idempotency_key(`miniapp:<action>:<taskId>:<task.status>`)
// 는 두 라운드 다 task.status 가 completion_approval_pending 으로 같아서 키도
// 같아진다 — Echo 자신의 huai_approvals INSERT 단계에서부터 충돌할 수 있다는
// 가설을 여기서 실측한다.
// ---------------------------------------------------------------------------

test("반복 결정 재현 1/3 — Echo 층: 같은 status 로 돌아온 두 번째 보완 요청은 idempotency_key 가 같아 huai_approvals INSERT 자체가 409 로 막힌다", async () => {
  const taskId = "22222222-2222-4222-8222-222222222222";
  const mini = new MiniSupabaseFake();
  // 1번째 보완 요청 — Echo 가 이미 실제로 써 넣은 행을 흉내낸다.
  mini.seed("huai_approvals", [{
    approval_id: "revision-round-1",
    room_id: roomA.roomId,
    entity_ref: taskId,
    stage: "final_approval",
    decision: "revision_requested",
    decider_telegram_user_id: Number(ownerA),
    idempotency_key: "miniapp:request_revision:" + taskId + ":completion_approval_pending",
    created_at: "2026-08-15T00:00:00.000Z"
  }]);

  // 2번째 보완 요청 — 재작업이 끝나 task 가 다시 completion_approval_pending 으로
  // 돌아온 뒤 방장이 또 보완을 요청한 상황. task.status 가 1번째와 같으므로 Echo 의
  // 키 생성 규칙(action+taskId+status)을 그대로 적용하면 idempotency_key 도 같다.
  const secondInsert = await mini.fetchImpl(
    "https://example.supabase.co/rest/v1/huai_approvals",
    {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        approval_id: "revision-round-2",
        room_id: roomA.roomId,
        entity_ref: taskId,
        stage: "final_approval",
        decision: "revision_requested",
        decider_telegram_user_id: Number(ownerA),
        idempotency_key: "miniapp:request_revision:" + taskId + ":completion_approval_pending",
        created_at: "2026-08-15T00:05:00.000Z"
      })
    }
  );

  assert.equal(secondInsert.status, 409, "Echo 자신의 두 번째 INSERT 가 idempotency_key 충돌로 막힌다 — 원장에 행조차 안 남는다");
  assert.equal(mini.tables.huai_approvals?.length, 1, "충돌한 두 번째 행은 저장되지 않는다");
});

// 위 결과 그대로는 "Echo 층에서 막혀 원장에 행이 안 남는다" 이지만, Echo 가 키
// 생성 방식을 바꾸거나(예: 매 클릭마다 nonce 를 섞는 등) 어떤 이유로든 서로 다른
// idempotency_key 를 가진 두 행이 huai_approvals 에 실제로 들어오는 경우를 대비해
// 폴러 자신의 tuple dedup 이 그 경우엔 어떻게 반응하는지도 확인해 둔다 — 지금
// 설계로는 room+entity_ref+stage+decision 이 같으면 그것도 "중복"으로 걸러진다
// (다른 이유로 재현된 결과이지, Echo 층 충돌과 같은 실패가 아니다 — 별개로 기록).
test("반복 결정 재현 2/3 — 폴러 층: Echo 키가 어떻게든 달라도(가정) 내 tuple dedup 은 같은 (stage,decision) 반복을 여전히 걸러낸다", async () => {
  const taskId = "33333333-3333-4333-8333-333333333333";
  const backend = new FakeMiniAppBackend();
  backend.approvals.push(approvalRow({
    approvalId: "revision-round-1b",
    roomId: roomA.roomId,
    entityRef: taskId,
    stage: "final_approval",
    decision: "revision_requested",
    decider: ownerA,
    createdAt: "2026-08-15T00:00:00.000Z"
  }));
  backend.approvals.push(approvalRow({
    approvalId: "revision-round-2b",
    roomId: roomA.roomId,
    entityRef: taskId,
    stage: "final_approval",
    decision: "revision_requested",
    decider: ownerA,
    createdAt: "2026-08-15T00:05:00.000Z"
  }));
  const persistence = new FakePersistence();

  const result = await runMiniAppDecisionPollOnce(options(backend, persistence, [roomA]));

  assert.equal(result.replayed, 1, "폴러 층까지 도달하면(가정) 두 번째 라운드도 room+entity_ref+stage+decision 이 같아 스킵된다 — 방장이 버튼을 눌러도 반응이 없다");
  assert.equal(backend.processed.get("revision-round-2b")?.outcome, "skipped_duplicate");
});

// Telegram 경로 비교: 같은 두 라운드를 REAL SupabaseBotServiceStore 로 재현한다.
// Telegram 의 콜백 이벤트 키는 `<action>:<botId>:<updateId>:<entityId>` 형식이라
// updateId 가 매번 다르면 두 라운드가 서로 다른 키를 갖는다 — status 를 안 보므로
// Echo 식 충돌이 원천적으로 없다.
test("반복 결정 재현 3/3 — Telegram 경로는 두 라운드 다 정상 처리된다(updateId 가 매번 달라 키가 안 겹친다)", async () => {
  const taskId = "44444444-4444-4444-8444-444444444444";
  const mini = new MiniSupabaseFake();
  mini.seed("huai_rooms", [{ room_id: roomA.roomId, telegram_chat_id: roomA.telegramChatId, status: "active" }]);
  mini.seed("huai_tasks", [{
    task_id: taskId, room_id: roomA.roomId, status: "completion_approval_pending",
    title: "t", purpose: "p", scope: "s", completion_criteria: "c"
  }]);
  const realStore = store(mini);

  const requestRevisionCommit = (updateId: string) => ({
    message: {
      input: {
        kind: "callback" as const,
        envelope: new TelegramUpdateEnvelope("realbot", "platoon_bot", "platoon_leader", updateId, roomA.telegramChatId, "10", ownerA, false, undefined, undefined),
        callback: { entity: "task" as const, entityId: taskId, action: "request_revision" as const }
      },
      idempotencyKey: "telegram-update:realbot:" + updateId,
      receivedAt: "2026-08-15T00:00:00.000Z"
    },
    result: {
      accepted: true as const,
      authorization: { allowed: true as const },
      events: [{ eventType: "owner_supplement_requested" as const, idempotencyKey: "owner_supplement_requested:realbot:" + updateId + ":" + taskId, payload: { entityId: taskId, telegramUserId: ownerA } }],
      outbox: []
    }
  });

  // 1라운드.
  await realStore.commitTelegramInputResult(requestRevisionCommit("101"));
  let task = mini.tables.huai_tasks?.find((row) => row.task_id === taskId);
  assert.equal(task?.status, "owner_supplement_requested", "1라운드는 정상 전이돼야 한다");

  // 재작업 완료 — 다시 completion_approval_pending 으로 돌아왔다고 가정(시스템의
  // 다른 이벤트가 하는 일이라 여기서는 직접 되돌린다).
  if (task) task.status = "completion_approval_pending";

  // 2라운드 — updateId 가 달라서 이벤트 키도 다르다.
  await realStore.commitTelegramInputResult(requestRevisionCommit("102"));
  task = mini.tables.huai_tasks?.find((row) => row.task_id === taskId);
  assert.equal(task?.status, "owner_supplement_requested", "2라운드도 Telegram 에서는 막히지 않고 정상 전이돼야 한다 — Mini App 과 다르게 동작하는 지점");
});

function store(mini: MiniSupabaseFake): SupabaseBotServiceStore {
  return new SupabaseBotServiceStore({ url: "https://example.supabase.co", serviceRoleKey: "test-key", fetchImpl: mini.fetchImpl });
}

function options(
  backend: FakeMiniAppBackend,
  persistence: OrchestratorPersistencePort,
  rooms: readonly { roomId: string; telegramChatId: string }[],
  flags: { executionDefaultsMissing?: boolean; fetchImpl?: typeof fetch } = {}
): MiniAppDecisionPollerOptions {
  return {
    url: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    // 실제 운영에서는 폴러 자신의 REST 호출(huai_approvals/커서/처리결과)과
    // SupabaseBotServiceStore 의 REST 호출(huai_events/huai_outbox 등)이 같은
    // Supabase 프로젝트 하나를 향한다 — 하나의 DB 다. 그래서 "Telegram 이 이미
    // 실행한 결정" 같은 교차 테이블 시나리오(huai_approvals 는 폴러가, huai_events
    // 는 store 가 씀)를 검증하는 테스트는 둘 다 같은 fake(MiniSupabaseFake)를
    // 공유해야 한다 — flags.fetchImpl 로 오버라이드한다.
    fetchImpl: flags.fetchImpl ?? backend.fetchImpl(),
    rooms,
    authorization: {
      memberships: [
        { telegramChatId: roomA.telegramChatId, telegramUserId: ownerA, role: "owner", permissions: [], status: "active" },
        { telegramChatId: roomB.telegramChatId, telegramUserId: ownerB, role: "owner", permissions: [], status: "active" }
      ]
    },
    executionDefaultsByChatId: new Map([
      [roomA.telegramChatId, flags.executionDefaultsMissing ? undefined : {
        roomId: roomA.roomId,
        actorId: "actor-a",
        adapterType: "codex",
        projectPath: "C:/Dev/RoomA",
        timeoutMs: 900000,
        gatewayId: "gateway-a"
      }],
      [roomB.telegramChatId, {
        roomId: roomB.roomId,
        actorId: "actor-b",
        adapterType: "codex",
        projectPath: "C:/Dev/RoomB",
        timeoutMs: 900000,
        gatewayId: "gateway-b"
      }]
    ]),
    persistence,
    limit: 50
  };
}

function approvalRow(input: {
  approvalId: string;
  roomId: string;
  entityRef: string;
  stage: string;
  decision: string;
  decider: string;
  createdAt: string;
  idempotencyKey?: string | null;
}): ApprovalFixture {
  return {
    approval_id: input.approvalId,
    task_id: null,
    room_id: input.roomId,
    stage: input.stage,
    decider_telegram_user_id: input.decider,
    decision: input.decision,
    reason: null,
    created_at: input.createdAt,
    idempotency_key: input.idempotencyKey === undefined ? `miniapp-fixture:${input.approvalId}` : input.idempotencyKey,
    entity_ref: input.entityRef
  };
}

class FakePersistence implements OrchestratorPersistencePort {
  commits: Array<{ message: TelegramInboundQueueMessage; result: Extract<TelegramInputHandlingResult, { accepted: true }> }> = [];

  async commitTelegramInputResult(input: {
    message: TelegramInboundQueueMessage;
    result: Extract<TelegramInputHandlingResult, { accepted: true }>;
  }): Promise<{ events: PersistedEvent[]; outbox: PersistedOutboxItem[] }> {
    this.commits.push(input);
    return { events: [], outbox: [] };
  }

  async markTelegramUpdateProcessed(): Promise<void> {
    // 합성 경로는 persistence.ts 를 거치지 않으므로 poller 가 이걸 호출하면 안 된다.
    throw new Error("unexpected-call:markTelegramUpdateProcessed");
  }

  async markTelegramUpdateFailed(): Promise<void> {
    throw new Error("unexpected-call:markTelegramUpdateFailed");
  }
}

type ApprovalFixture = {
  approval_id: string;
  task_id: string | null;
  room_id: string;
  stage: string;
  decider_telegram_user_id: string;
  decision: string;
  reason: string | null;
  created_at: string;
  idempotency_key: string | null;
  entity_ref: string | null;
};

// 4개 테이블(huai_approvals 읽기 2가지 쿼리 모양, huai_miniapp_decision_cursor,
// huai_miniapp_decision_processed)을 흉내내는 인메모리 가짜 백엔드. 재시작 시나리오
// 테스트가 "poller 를 다시 만들어도 같은 DB 상태를 본다"를 표현할 수 있도록, 상태를
// FakeMiniAppBackend 인스턴스에 보관하고 fetchImpl() 을 여러 번 호출해도 같은 상태를
// 공유한다.
class FakeMiniAppBackend {
  approvals: ApprovalFixture[] = [];
  processed = new Map<string, { outcome: string; detail: string | null }>();
  cursor: string | undefined;

  fetchImpl(): typeof fetch {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";

      if (href.includes("/huai_miniapp_decision_cursor")) {
        if (method === "GET") {
          return json(this.cursor ? [{ last_seen_created_at: this.cursor }] : []);
        }
        // POST ...?on_conflict=id (upsert)
        const body = JSON.parse(String(init?.body ?? "{}")) as { last_seen_created_at: string };
        this.cursor = body.last_seen_created_at;
        return json({}, 200);
      }

      if (href.includes("/huai_miniapp_decision_processed")) {
        if (method === "GET") {
          const ids = parseInFilter(href, "approval_id");
          const rows = ids.filter((id) => this.processed.has(id)).map((id) => ({ approval_id: id }));
          return json(rows);
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { approval_id: string; outcome: string; detail: string | null };
        if (this.processed.has(body.approval_id)) return json({ error: "conflict" }, 409);
        this.processed.set(body.approval_id, { outcome: body.outcome, detail: body.detail });
        return json({}, 200);
      }

      if (href.includes("/huai_events")) {
        // eventAlreadyRecorded 조회. 단위 테스트(FakePersistence 사용)들은
        // huai_events 를 실제로 안 건드리므로 "아무것도 이미 실행되지 않았다"
        // 로 고정한다 — Telegram 이 먼저 실행한 시나리오는 REAL SupabaseBotServiceStore
        // + MiniSupabaseFake 를 쓰는 통합 테스트가 별도로 검증한다.
        return json([]);
      }

      if (href.includes("/huai_approvals")) {
        if (href.includes("room_id=eq.")) {
          // isFirstDecisionForEntity 조회.
          const roomId = singleFilterValue(href, "room_id");
          const entityRef = singleFilterValue(href, "entity_ref");
          const stage = singleFilterValue(href, "stage");
          // decision 파라미터는 있을 때만 필터에 반영한다 — 진짜 PostgREST 처럼,
          // 쿼리에 없는 조건은 "그 축으로는 거르지 않는다"를 그대로 흉내낸다. 이래야
          // 프로덕션이 &decision=eq. 를 빼먹는 회귀를 mutation 으로 정확히 재현할 수 있다
          // (뺐을 때 이 fake 도 실제 PostgREST 처럼 그 축을 무시해야 회귀가 드러난다).
          const decision = singleFilterValue(href, "decision");
          const matches = this.approvals
            .filter((row) => row.room_id === roomId && row.entity_ref === entityRef && row.stage === stage && (decision === undefined || row.decision === decision))
            .sort(byCreatedAtThenId);
          return json(matches.length > 0 ? [{ approval_id: matches[0]!.approval_id }] : []);
        }
        // fetchApprovalsSince 배치 조회.
        const cursorValue = singleFilterValue(href, "created_at")?.replace(/^gte\./, "");
        const rows = this.approvals
          .filter((row) => !cursorValue || row.created_at >= cursorValue)
          .sort(byCreatedAtThenId);
        return json(rows);
      }

      return json({ error: `unexpected-path:${href}` }, 404);
    }) as typeof fetch;
  }
}

function byCreatedAtThenId(a: ApprovalFixture, b: ApprovalFixture): number {
  return a.created_at === b.created_at
    ? a.approval_id.localeCompare(b.approval_id)
    : a.created_at.localeCompare(b.created_at);
}

function singleFilterValue(href: string, field: string): string | undefined {
  const match = href.match(new RegExp(`[?&]${field}=([^&]*)`));
  if (!match) return undefined;
  const raw = decodeURIComponent(match[1]!);
  return raw.startsWith("eq.") ? raw.slice("eq.".length) : raw;
}

function parseInFilter(href: string, field: string): string[] {
  const match = href.match(new RegExp(`${field}=in\\.\\(([^)]*)\\)`));
  if (!match) return [];
  return decodeURIComponent(match[1]!)
    .split(",")
    .map((value) => value.replace(/^"|"$/g, ""));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
