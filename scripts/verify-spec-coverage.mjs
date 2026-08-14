// 기획서(GATE1 요구사항 추적표) 반영 여부를 코드 근거로 기계 판정한다.
//
// 판정 원칙: "타입 선언만 있음"은 통과가 아니다.
// 완료 기준 ③ "실제로 호출·실행됨"을 확인하기 위해,
// 워크플로우 이벤트는 발행 지점, DB 테이블은 쓰기/읽기 요청, 함수는 정의 파일 밖 호출을 근거로 삼는다.
//
// 이 스크립트는 리포트이면서 회귀 가드다. 아래 BASELINE과 실제 판정이 어긋나면 실패한다.
// 기능을 구현했으면 BASELINE을 올려야 하고, 기능을 깨뜨리면 BASELINE과 어긋나 실패한다.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();

// 이벤트 이름·테이블 이름이 "선언"만 되어 있는 파일. 발행/사용 근거에서 제외한다.
const DECLARATION_ONLY_FILES = [
  "packages/contracts/src/index.ts",
  "packages/workflow/src/index.ts"
];

export function loadSources() {
  const sourceFiles = listFiles(["apps", "packages"], (path) => path.endsWith(".ts") && path.includes(`${sep}src${sep}`));
  const testFiles = [
    ...listFiles(["apps", "packages"], (path) => path.endsWith(".ts") && path.includes(`${sep}test${sep}`)),
    ...listFiles(["scripts"], (path) => path.endsWith(".test.mjs"))
  ];
  const scriptFiles = listFiles(["scripts"], (path) => path.endsWith(".mjs"));
  const schemaPath = join(ROOT, "supabase", "schema.sql");

  return {
    behaviour: sourceFiles.filter((file) => !DECLARATION_ONLY_FILES.includes(file.id)),
    allSource: sourceFiles,
    tests: testFiles,
    scripts: scriptFiles,
    schema: existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : ""
  };
}

function listFiles(roots, accept) {
  const found = [];
  for (const root of roots) {
    walk(join(ROOT, root), found, accept);
  }
  return found.map((path) => ({
    id: relative(ROOT, path).split(sep).join("/"),
    text: readFileSync(path, "utf8")
  }));
}

function walk(directory, found, accept) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, found, accept);
    else if (entry.isFile() && accept(path)) found.push(path);
  }
}

// ---------- probes ----------

export function createProbes(sources) {
  const behaviourText = sources.behaviour.map((file) => file.text).join("\n");
  const allSourceText = sources.allSource.map((file) => file.text).join("\n");
  const testText = sources.tests.map((file) => file.text).join("\n");
  const scriptText = sources.scripts.map((file) => file.text).join("\n");

  return {
    // 워크플로우 이벤트가 실제로 발행되는가 (타입 선언 파일 제외)
    emitsEvent(eventName) {
      return behaviourText.includes(`"${eventName}"`);
    },
    // 테이블에 쓰기 요청이 존재하는가 (문자열·템플릿 리터럴 모두 인정)
    writesTable(table) {
      return new RegExp(`"POST",\\s*["'\`]/${table}["'\`]`).test(allSourceText);
    },
    // 테이블 읽기 요청이 존재하는가
    readsTable(table) {
      return new RegExp(`["'\`]/${table}[?"'\`]`).test(allSourceText);
    },
    // 심볼이 정의 파일 밖에서 호출되는가
    calledOutsideDefinition(symbol, definingFileId) {
      return sources.allSource
        .filter((file) => file.id !== definingFileId)
        .some((file) => new RegExp(`\\b${symbol}\\s*\\(`).test(file.text));
    },
    sourceMatches(pattern) {
      return new RegExp(pattern).test(allSourceText);
    },
    testMatches(pattern) {
      return new RegExp(pattern).test(testText);
    },
    scriptMatches(pattern) {
      return new RegExp(pattern).test(scriptText);
    },
    schemaMatches(pattern) {
      return new RegExp(pattern, "i").test(sources.schema);
    },
    fileExists(relativePath) {
      return existsSync(join(ROOT, relativePath));
    }
  };
}

// ---------- 요구사항 판정표 ----------
// verdict: pass = 근거 있는 구현 / partial = 일부만 / missing = 배선 없음

export function evaluateSpecCoverage(sources = loadSources()) {
  const probe = createProbes(sources);
  const rows = [];

  // 근거 등급.
  //   behaviour = 실제 배선을 본다 (이벤트 발행 / 테이블 읽기·쓰기 / 정의부 밖 호출)
  //   weak      = 문자열·파일 존재만 본다
  // AC-02 사례에서 드러났듯 weak 근거는 죽은 코드나 우연한 문자열 일치로도 통과한다.
  // 따라서 behaviour 근거가 하나도 없으면 pass 를 줄 수 없고 partial 로 제한한다.
  const add = (id, name, checks) => {
    const results = checks.map((check) => ({
      label: check.label,
      ok: Boolean(check.run(probe)),
      required: check.required !== false,
      behaviour: check.behaviour === true
    }));
    const required = results.filter((item) => item.required);
    const passedRequired = required.filter((item) => item.ok);
    const allRequiredPassed = passedRequired.length === required.length;
    const hasBehaviourEvidence = results.some((item) => item.ok && item.behaviour);

    const verdict = allRequiredPassed
      ? (hasBehaviourEvidence ? "pass" : "partial")
      : passedRequired.length === 0
        ? "missing"
        : "partial";

    rows.push({
      id,
      name,
      verdict,
      evidenceOnlyWeak: allRequiredPassed && !hasBehaviourEvidence,
      evidence: results.map((item) => `${item.ok ? "+" : "-"}${item.behaviour ? "*" : ""}${item.label}`).join(" ")
    });
  };

  // --- 기능 요구사항 FR-001 ~ FR-020 ---
  add("FR-001", "프로젝트 채팅룸", [
    { label: "schema:huai_rooms(purpose,rules)", run: (p) => p.schemaMatches("create table if not exists huai_rooms[\\s\\S]*?rules") },
    { label: "read:huai_rooms", behaviour: true, run: (p) => p.readsTable("huai_rooms") },
    { label: "telegram-room-register-command", run: (p) => p.sourceMatches("\"/register(?:room)?\"") }
  ]);
  add("FR-002", "참여자 관리", [
    { label: "read:huai_room_members", behaviour: true, run: (p) => p.readsTable("huai_room_members") },
    { label: "member-invite-or-leave-write", behaviour: true, run: (p) => p.writesTable("huai_room_members") },
    { label: "membership-history-event", behaviour: true, run: (p) => p.emitsEvent("participant_changed") }
  ]);
  add("FR-003", "소대장 상주", [
    { label: "leader-routing", run: (p) => p.sourceMatches("platoon_leader") },
    { label: "freeform-intent-routing", run: (p) => p.sourceMatches("classifyFreeformIntent") },
    { label: "reply-context-carry", run: (p) => p.sourceMatches("replyToMessageText") },
    { label: "intent-router-wired", behaviour: true, run: (p) => p.calledOutsideDefinition("classifyFreeformIntent", "packages/orchestrator/src/intent-router.ts") }
  ]);
  add("FR-004", "전문 AI 제안·초대", [
    { label: "ai-actor-invite-write", behaviour: true, run: (p) => p.writesTable("huai_ai_actors") },
    { label: "inactive-actor-event", behaviour: true, run: (p) => p.emitsEvent("ai_actor_inactive") }
  ]);
  add("FR-005", "핵심 메시지 필터", [
    { label: "internal-log-filter", run: (p) => p.sourceMatches("sanitizeTelegramVisibleText") },
    { label: "role-based-bot-routing", run: (p) => p.sourceMatches("chooseOutboundBotForEvent") },
    { label: "filter-wired", behaviour: true, run: (p) => p.calledOutsideDefinition("sanitizeTelegramVisibleText", "packages/telegram-ui/src/sanitize.ts") }
  ]);
  add("FR-006", "세부 기록", [
    { label: "task-detail-query", run: (p) => p.sourceMatches("\"/task\"") },
    { label: "event-history-read", behaviour: true, run: (p) => p.readsTable("huai_events") },
    { label: "internal-execution-log-retrieval", run: (p) => p.sourceMatches("execution_log|stdout_log|huai_execution_attempts") }
  ]);
  add("FR-007", "작업 제안", [
    { label: "proposal_created-emitted", behaviour: true, run: (p) => p.emitsEvent("proposal_created") },
    { label: "structured-purpose-scope", run: (p) => p.sourceMatches("purpose:\\s*hint\\.purpose|purpose:\\s*routed\\.purpose") },
    { label: "structured-completion-criteria", run: (p) => p.sourceMatches("completion_criteria:\\s*(?!\"승인된)") }
  ]);
  add("FR-008", "승인 기반 카드 생성", [
    { label: "owner_task_approved-emitted", behaviour: true, run: (p) => p.emitsEvent("owner_task_approved") },
    { label: "write:huai_tasks", behaviour: true, run: (p) => p.writesTable("huai_tasks") },
    { label: "schema:one-task-per-proposal", run: (p) => p.schemaMatches("huai_tasks_approved_proposal_unique") }
  ]);
  add("FR-009", "작업 목록", [
    { label: "tasks-list-query", run: (p) => p.sourceMatches("\"/tasks\"") },
    { label: "priority-rendered", run: (p) => p.sourceMatches("우선순위") },
    { label: "assignee-and-dependency-rendered", run: (p) => p.sourceMatches("담당[^\\n]*assignee|선행[^\\n]*predecessor") }
  ]);
  add("FR-010", "병렬·순차 제어", [
    { label: "planReadyTasks-primitive", run: (p) => p.sourceMatches("planReadyTasks") },
    { label: "read:huai_task_dependencies", behaviour: true, run: (p) => p.readsTable("huai_task_dependencies") },
    { label: "write:huai_task_dependencies", behaviour: true, run: (p) => p.writesTable("huai_task_dependencies") }
  ]);
  add("FR-011", "중간 승인 게이트", [
    { label: "mid_approval_required-emitted", behaviour: true, run: (p) => p.emitsEvent("mid_approval_required") },
    { label: "owner_mid_approved-emitted", behaviour: true, run: (p) => p.emitsEvent("owner_mid_approved") },
    { label: "write:huai_reports", behaviour: true, run: (p) => p.writesTable("huai_reports") }
  ]);
  add("FR-012", "선택 검증", [
    { label: "conditional-audit-request", run: (p) => p.sourceMatches("shouldRequestAutomaticAudit") },
    { label: "meaningfulness-record", behaviour: true, run: (p) => p.writesTable("huai_reports") }
  ]);
  add("FR-013", "검증 의견서", [
    { label: "write:huai_verifications", behaviour: true, run: (p) => p.writesTable("huai_verifications") },
    { label: "verdict-evidence-fixes", run: (p) => p.sourceMatches("required_fixes") },
    { label: "reverify-scope", run: (p) => p.sourceMatches("reverify_scope") }
  ]);
  add("FR-014", "수정·재검증", [
    { label: "write:huai_revision_requests", behaviour: true, run: (p) => p.writesTable("huai_revision_requests") },
    { label: "revision_submitted-emitted", behaviour: true, run: (p) => p.emitsEvent("revision_submitted") },
    { label: "verification_failed_or_changes_requested-emitted", behaviour: true, run: (p) => p.emitsEvent("verification_failed_or_changes_requested") }
  ]);
  add("FR-015", "3단계 완료", [
    { label: "state-machine-blocks-completion", run: (p) => p.testMatches("commander_completion_approved") },
    { label: "owner_final_approved-emitted", behaviour: true, run: (p) => p.emitsEvent("owner_final_approved") },
    { label: "commander_completion_approved-emitted", behaviour: true, run: (p) => p.emitsEvent("commander_completion_approved") }
  ]);
  add("FR-016", "완료 후 변경 분기", [
    { label: "scope-change-rejected-by-state-machine", run: (p) => p.sourceMatches("scope-change-requires-new-task") },
    { label: "post_completion_minor_change_requested-emitted", behaviour: true, run: (p) => p.emitsEvent("post_completion_minor_change_requested") },
    { label: "new-card-branch", behaviour: true, run: (p) => p.emitsEvent("post_completion_scope_change_requested") }
  ]);
  add("FR-017", "훅 자동화", [
    { label: "outbox-idempotency", run: (p) => p.sourceMatches("insertOutboxIdempotently|idempotencyKey") },
    { label: "retry-policy", run: (p) => p.sourceMatches("markRetry") },
    { label: "write:huai_hook_attempts", behaviour: true, run: (p) => p.writesTable("huai_hook_attempts") }
  ]);
  add("FR-018", "보조 수단 선택", [
    { label: "per-task-tooling-selection", run: (p) => p.sourceMatches("worktree|toolingPolicy|auxiliaryMeans") }
  ]);
  add("FR-019", "검색·추적", [
    { label: "search-command", run: (p) => p.sourceMatches("\"/search\"") },
    { label: "trace-command", run: (p) => p.sourceMatches("\"/trace\"") },
    { label: "read:huai_artifacts", behaviour: true, run: (p) => p.readsTable("huai_artifacts") },
    { label: "write:huai_artifacts", behaviour: true, run: (p) => p.writesTable("huai_artifacts") },
    // 기획서 원문이 "승인 기록"까지 추적 대상으로 명시한다. huai_approvals 미배선이면 pass 불가.
    { label: "read:huai_approvals", behaviour: true, run: (p) => p.readsTable("huai_approvals") }
  ]);
  add("FR-020", "알림·현황 메시지", [
    { label: "priority-notification", run: (p) => p.sourceMatches("buildCompletionKeyboard") },
    { label: "status-message-component-wired", behaviour: true, run: (p) => p.calledOutsideDefinition("buildProjectStatusMessage", "packages/telegram-ui/src/index.ts") },
    { label: "pinned-status-edit-producer", run: (p) => p.sourceMatches("editMessageId:\\s*") }
  ]);

  // --- 훅 요구사항 H-01 ~ H-13 ---
  add("H-01", "방장 작업 승인 훅", [
    { label: "owner_task_approved-emitted", behaviour: true, run: (p) => p.emitsEvent("owner_task_approved") },
    { label: "task-materialization", behaviour: true, run: (p) => p.writesTable("huai_tasks") }
  ]);
  add("H-02", "작업 시작 훅", [
    { label: "gateway-accepted-started-events", run: (p) => p.sourceMatches("\"started\"") },
    { label: "task_started-workflow-event", behaviour: true, run: (p) => p.emitsEvent("task_started") }
  ]);
  add("H-03", "결과 저장 훅", [
    { label: "artifact-collection", run: (p) => p.sourceMatches("artifact_collected") },
    { label: "write:huai_artifacts", behaviour: true, run: (p) => p.writesTable("huai_artifacts") },
    { label: "artifact_saved-emitted", behaviour: true, run: (p) => p.emitsEvent("artifact_saved") },
    { label: "checksum-dedupe", run: (p) => p.sourceMatches("checksum") }
  ]);
  add("H-04", "의미 있는 중간 결과 훅", [
    { label: "meaningful_intermediate_ready-emitted", behaviour: true, run: (p) => p.emitsEvent("meaningful_intermediate_ready") },
    { label: "significance-record", behaviour: true, run: (p) => p.writesTable("huai_reports") }
  ]);
  add("H-05", "중간 승인 필요 훅", [
    { label: "mid_approval_required-emitted", behaviour: true, run: (p) => p.emitsEvent("mid_approval_required") },
    { label: "affected-task-blocking", run: (p) => p.sourceMatches("affectedTaskIds") }
  ]);
  add("H-06", "검증 대상 완성 훅", [
    { label: "self-verification-guard", run: (p) => p.sourceMatches("isIndependentVerifier") },
    { label: "guard-wired-to-store", run: (p) => p.sourceMatches("workflowContextFromEvent") },
    { label: "guard-tested", run: (p) => p.testMatches("verifierActorId") },
    { label: "state-machine-wired", behaviour: true, run: (p) => p.calledOutsideDefinition("transitionTaskStatus", "packages/workflow/src/index.ts") }
  ]);
  add("H-07", "검증 의견 등록 훅", [
    { label: "write:huai_verifications", behaviour: true, run: (p) => p.writesTable("huai_verifications") },
    { label: "write:huai_revision_requests", behaviour: true, run: (p) => p.writesTable("huai_revision_requests") }
  ]);
  add("H-08", "수정 결과 제출 훅", [
    { label: "revision_submitted-emitted", behaviour: true, run: (p) => p.emitsEvent("revision_submitted") },
    { label: "scoped-reverification", run: (p) => p.sourceMatches("changedScope:\\s*\"") }
  ]);
  add("H-09", "독립 검증 합격 훅", [
    { label: "completion-review-outbox", run: (p) => p.sourceMatches("telegram-completion-review") },
    { label: "verification_passed-emitted", behaviour: true, run: (p) => p.emitsEvent("verification_passed") }
  ]);
  add("H-10", "소대장 완료 결정 훅", [
    { label: "completion-keyboard-3-options", run: (p) => p.sourceMatches("buildCompletionKeyboard") },
    { label: "commander_completion_requested-emitted", behaviour: true, run: (p) => p.emitsEvent("commander_completion_requested") }
  ]);
  add("H-11", "방장 최종 승인 훅", [
    { label: "owner_final_approved-emitted", behaviour: true, run: (p) => p.emitsEvent("owner_final_approved") },
    { label: "completed-transition-tested", run: (p) => p.testMatches("owner_final_approved") }
  ]);
  add("H-12", "오류·지연 훅", [
    { label: "execution_delayed_or_failed-emitted", behaviour: true, run: (p) => p.emitsEvent("execution_delayed_or_failed") },
    { label: "retry-limit", run: (p) => p.sourceMatches("maxAttempts") },
    { label: "terminal-escalation", behaviour: true, run: (p) => p.emitsEvent("execution_failed_terminal") }
  ]);
  add("H-13", "전문 AI 장기 미사용 훅", [
    { label: "ai_actor_inactive-emitted", behaviour: true, run: (p) => p.emitsEvent("ai_actor_inactive") }
  ]);

  // --- 인수 기준 AC-01 ~ AC-15 ---
  add("AC-01", "승인 시 카드 1회 생성", [
    { label: "unique-proposal-index", run: (p) => p.schemaMatches("huai_tasks_approved_proposal_unique") },
    { label: "tested", run: (p) => p.testMatches("ensureApprovedProposalTask|approved_proposal|task-materializ") }
  ]);
  add("AC-02", "승인 전 실행 차단", [
    // 이전 probe 는 sourceMatches("isForbiddenTransition") 였고, 그 함수가 죽은 코드인데도 통과했다.
    // 정의부 밖 실호출을 요구하도록 교체한다.
    { label: "forbidden-transition-guard-wired", behaviour: true, run: (p) => p.calledOutsideDefinition("isForbiddenTransition", "packages/workflow/src/index.ts") },
    { label: "forbidden-transition-tested", run: (p) => p.testMatches("isForbiddenTransition|task-transition-forbidden") }
  ]);
  add("AC-03", "작업 카드 필수 필드", [
    { label: "purpose-scope-criteria-rendered", run: (p) => p.sourceMatches("완료 기준") },
    { label: "assignee-and-dependency-rendered", run: (p) => p.sourceMatches("담당[^\\n]*assignee|선행[^\\n]*predecessor") }
  ]);
  add("AC-04", "병렬·충돌 조정", [
    { label: "dag-primitive-tested", run: (p) => p.testMatches("planReadyTasks") },
    { label: "dependency-creation-path", behaviour: true, run: (p) => p.writesTable("huai_task_dependencies") }
  ]);
  add("AC-05", "사소한 작업 생략", [
    { label: "internal-log-filter-tested", run: (p) => p.testMatches("sanitizeTelegramVisibleText|hook_started") },
    { label: "detail-record-retained", behaviour: true, run: (p) => p.writesTable("huai_reports") }
  ]);
  add("AC-06", "중간 승인 영향 범위", [
    { label: "mid-approval-flow", behaviour: true, run: (p) => p.emitsEvent("mid_approval_required") },
    { label: "affected-scope-blocking-tested", run: (p) => p.testMatches("affectedTaskIds") }
  ]);
  add("AC-07", "검증자 수정 금지", [
    { label: "independent-verifier-guard-tested", run: (p) => p.testMatches("isIndependentVerifier|verifierActorId") },
    { label: "verifier-write-block", run: (p) => p.sourceMatches("verifier-cannot-modify|verifierWriteBlocked") }
  ]);
  add("AC-08", "합격만으로 완료 불가", [
    { label: "state-machine-tested", run: (p) => p.testMatches("commander_completion_pending") },
    { label: "approval-evidence-persisted", behaviour: true, run: (p) => p.writesTable("huai_approvals") },
    { label: "commander-stage-recorded", run: (p) => p.sourceMatches("stage: \"commander_completion\"") }
  ]);
  add("AC-09", "보완 유형 분기", [
    { label: "changedScope-parsed", run: (p) => p.sourceMatches("changedScopeValue") },
    { label: "changedScope-produced", run: (p) => p.sourceMatches("changedScope:\\s*\"") }
  ]);
  add("AC-10", "완료 후 범위 변경 새 카드", [
    { label: "scope-change-rejected", run: (p) => p.sourceMatches("scope-change-requires-new-task") },
    { label: "new-card-created", behaviour: true, run: (p) => p.emitsEvent("post_completion_scope_change_requested") }
  ]);
  add("AC-11", "AI 퇴장 제안", [
    { label: "inactivity-detection", behaviour: true, run: (p) => p.emitsEvent("ai_actor_inactive") }
  ]);
  add("AC-12", "훅 중복·재시도 안전", [
    { label: "update-idempotency-tested", run: (p) => p.testMatches("duplicate-update") },
    { label: "outbox-idempotency-tested", run: (p) => p.testMatches("idempotencyKey|idempotency_key") },
    { label: "update-dedupe-table-used", behaviour: true, run: (p) => p.readsTable("huai_telegram_updates") }
  ]);
  add("AC-13", "승인→게이트웨이 연결", [
    { label: "gateway-outbox-target", run: (p) => p.sourceMatches("local_gateway") },
    { label: "result-ingestion-tested", run: (p) => p.testMatches("recordGatewayExecutionResult|gateway-result") },
    { label: "gateway-outbox-written", behaviour: true, run: (p) => p.writesTable("huai_outbox") }
  ]);
  add("AC-14", "게이트웨이 재개·중복 방지", [
    { label: "outbox-lease", run: (p) => p.sourceMatches("lease_huai_outbox") },
    { label: "attempt-tracking", behaviour: true, run: (p) => p.writesTable("huai_execution_attempts") }
  ]);
  add("AC-15", "비밀키·경로 보호", [
    { label: "secret-masking", run: (p) => p.sourceMatches("maskSensitiveOutput|maskTelegramSensitiveText") },
    { label: "allowed-root-enforcement", run: (p) => p.sourceMatches("isPathInsideAllowedRoots") },
    { label: "secret-scan-script", run: (p) => p.fileExists("scripts/verify-no-secrets.mjs") },
    // isPathInsideAllowedRoots 는 정의 파일 안의 planExecution 이 호출한다.
    // 배선 근거는 그 planExecution 이 실행 경로(executor)에서 호출되는지로 본다.
    { label: "path-allowlist-enforced-in-execution", behaviour: true, run: (p) => p.calledOutsideDefinition("planExecution", "apps/local-gateway/src/index.ts") }
  ]);

  // --- 비기능 요구사항 NFR-01 ~ NFR-10 ---
  add("NFR-01", "권한 분리", [
    { label: "server-side-authorization", run: (p) => p.sourceMatches("authorizeTelegramInput") },
    { label: "rls-enabled", run: (p) => p.schemaMatches("enable row level security") },
    { label: "role-policies", run: (p) => p.schemaMatches("create policy") }
  ]);
  add("NFR-02", "감사 추적", [
    { label: "append-only-events", behaviour: true, run: (p) => p.writesTable("huai_events") },
    { label: "append-only-approvals", behaviour: true, run: (p) => p.writesTable("huai_approvals") },
    { label: "ledger-immutability-enforced", run: (p) => p.schemaMatches("huai_reject_ledger_mutation") }
  ]);
  add("NFR-03", "신뢰성", [
    { label: "idempotency-keys", run: (p) => p.sourceMatches("idempotency_key") },
    { label: "outbox-retry", run: (p) => p.sourceMatches("retry_pending") },
    { label: "outbox-table-used", behaviour: true, run: (p) => p.readsTable("huai_outbox") }
  ]);
  add("NFR-04", "가독성", [
    { label: "message-chunking", run: (p) => p.sourceMatches("sendTelegramTextChunks") },
    { label: "compact-buttons-tested", run: (p) => p.testMatches("callback-data-length|callback_data") }
  ]);
  add("NFR-05", "성능", [
    { label: "query-limits", run: (p) => p.sourceMatches("&limit=") },
    { label: "schema-indexes", run: (p) => p.schemaMatches("create index") }
  ]);
  add("NFR-06", "확장성", [
    { label: "adapter-abstraction", run: (p) => p.sourceMatches("resolveAdapterPlan") },
    { label: "contracts-package", run: (p) => p.fileExists("packages/contracts/src/index.ts") },
    { label: "adapter-plan-wired", behaviour: true, run: (p) => p.calledOutsideDefinition("resolveAdapterPlan", "packages/ai-adapters/src/index.ts") }
  ]);
  add("NFR-07", "보안", [
    { label: "webhook-secret-timing-safe", run: (p) => p.sourceMatches("timingSafeEqualText") },
    { label: "adapter-allowlist", run: (p) => p.sourceMatches("allowedAdapters") },
    { label: "secret-scan", run: (p) => p.fileExists("scripts/verify-no-secrets.mjs") }
  ]);
  add("NFR-08", "복구", [
    { label: "write:huai_recovery_snapshots", behaviour: true, run: (p) => p.writesTable("huai_recovery_snapshots") },
    { label: "artifact-versioning", behaviour: true, run: (p) => p.writesTable("huai_artifacts") }
  ]);
  add("NFR-09", "관찰성", [
    { label: "structured-logs", run: (p) => p.sourceMatches("JSON.stringify\\(\\{ type:") },
    { label: "operation-status-report", run: (p) => p.fileExists("scripts/operation-status-report.mjs") },
    { label: "per-task-execution-timeline", behaviour: true, run: (p) => p.writesTable("huai_execution_attempts") }
  ]);
  add("NFR-10", "접근성", [
    { label: "text-labelled-status", run: (p) => p.sourceMatches("humanTaskStatus") }
  ]);

  return rows;
}

// 현재 확정된 판정. 구현이 좋아지면 올리고, 나빠지면 이 검증이 실패한다.
export const BASELINE = {
  "FR-001": "partial", "FR-002": "partial", "FR-003": "pass", "FR-004": "missing",
  "FR-005": "pass", "FR-006": "partial", "FR-007": "pass", "FR-008": "pass",
  "FR-009": "partial", "FR-010": "partial", "FR-011": "missing", "FR-012": "partial",
  "FR-013": "pass", "FR-014": "partial", "FR-015": "partial", "FR-016": "partial",
  "FR-017": "partial", "FR-018": "missing", "FR-019": "pass", "FR-020": "partial",
  "H-01": "pass", "H-02": "partial", "H-03": "pass", "H-04": "partial",
  "H-05": "missing", "H-06": "pass", "H-07": "pass", "H-08": "partial",
  "H-09": "partial", "H-10": "partial", "H-11": "pass", "H-12": "partial",
  "H-13": "missing",
  "AC-01": "partial", "AC-02": "pass", "AC-03": "partial", "AC-04": "partial",
  "AC-05": "partial", "AC-06": "missing", "AC-07": "partial", "AC-08": "pass",
  "AC-09": "partial", "AC-10": "partial", "AC-11": "missing", "AC-12": "pass",
  "AC-13": "pass", "AC-14": "partial", "AC-15": "pass",
  "NFR-01": "partial", "NFR-02": "pass", "NFR-03": "pass", "NFR-04": "partial",
  "NFR-05": "partial", "NFR-06": "pass", "NFR-07": "partial", "NFR-08": "partial",
  "NFR-09": "partial", "NFR-10": "partial"
};

export function compareToBaseline(rows, baseline = BASELINE) {
  const drift = [];
  for (const row of rows) {
    const expected = baseline[row.id];
    if (expected === undefined) {
      drift.push({ id: row.id, kind: "unknown-requirement", expected: "(none)", actual: row.verdict });
      continue;
    }
    if (expected !== row.verdict) {
      drift.push({
        id: row.id,
        kind: rank(row.verdict) > rank(expected) ? "improved" : "regressed",
        expected,
        actual: row.verdict
      });
    }
  }
  const missingRows = Object.keys(baseline).filter((id) => !rows.some((row) => row.id === id));
  for (const id of missingRows) {
    drift.push({ id, kind: "requirement-not-evaluated", expected: baseline[id], actual: "(none)" });
  }
  return drift;
}

function rank(verdict) {
  return verdict === "pass" ? 2 : verdict === "partial" ? 1 : 0;
}

export function summarize(rows) {
  return {
    total: rows.length,
    pass: rows.filter((row) => row.verdict === "pass").length,
    partial: rows.filter((row) => row.verdict === "partial").length,
    missing: rows.filter((row) => row.verdict === "missing").length
  };
}

function main() {
  const rows = evaluateSpecCoverage();
  const summary = summarize(rows);

  console.log("기획서 커버리지 판정 (근거: 실제 호출·쓰기 경로)\n");
  for (const group of ["FR", "H", "AC", "NFR"]) {
    const groupRows = rows.filter((row) => row.id.startsWith(`${group}-`));
    console.log(`== ${group} ==`);
    for (const row of groupRows) {
      console.log(`${row.id} ${row.verdict.padEnd(7)} ${row.name}`);
      console.log(`         ${row.evidence}`);
    }
    console.log("");
  }

  const ratio = ((summary.pass / summary.total) * 100).toFixed(0);
  console.log(`spec-coverage total=${summary.total} pass=${summary.pass} partial=${summary.partial} missing=${summary.missing} pass_ratio=${ratio}%`);
  console.log("");
  console.log("주의: 이 검증의 통과는 '기획서 구현 완료'를 뜻하지 않는다.");
  console.log(`      기획서 ${summary.total}개 요구사항 중 근거 있는 구현은 ${summary.pass}개(${ratio}%)이며,`);
  console.log(`      partial ${summary.partial}개 / missing ${summary.missing}개가 남아 있다.`);
  console.log("      이 검증기는 그 상태가 '더 나빠지지 않았는지'만 확인한다.");
  console.log("      근거 표기: * = 행위 근거(실호출·DB·이벤트), 무표기 = 문자열·파일 존재 근거");

  const drift = compareToBaseline(rows);
  if (drift.length > 0) {
    console.error("\nspec-coverage baseline drift:");
    for (const item of drift) {
      console.error(`  ${item.id} ${item.kind}: baseline=${item.expected} actual=${item.actual}`);
    }
    console.error("\n구현을 개선했다면 scripts/verify-spec-coverage.mjs 의 BASELINE 을 갱신하세요.");
    process.exit(1);
  }

  console.log("spec-coverage baseline matched");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
