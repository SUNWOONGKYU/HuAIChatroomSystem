// huai_events(event_type='proposal_created') 의 payload 를 화면 표시용으로 뽑는다.
//
// 이 payload 구조는 apps/bot-service/src/supabase-store.ts 가 이미 같은 목적으로
// 읽고 있는 것과 정확히 같은 필드를 봐야 한다 — 추측하지 않고 그 파일을 직접 읽어
// 아래 함수들을 그대로(로직 동일하게) 이식했다. 두 곳에서 다른 필드를 보면
// "제안이 화면에는 안 뜨는데 실행은 됐다" 같은 불일치가 생긴다.
//
// 원본 위치(그대로 이식, 값 계산 로직 동일):
//   proposalTitleFromPayload      ← apps/bot-service/src/supabase-store.ts:1214-1218
//   proposalFieldFromPayload      ← apps/bot-service/src/supabase-store.ts:1223-1226
//   proposalActorRoleFromPayload  ← apps/bot-service/src/supabase-store.ts:1282-1286
//   proposalExecutionModeFromPayload ← apps/bot-service/src/supabase-store.ts:1171-1173
//
// proposal_created 이벤트는 생산자가 둘이다(둘 다 같은 payload 필드 이름을 쓴다는 걸
// 직접 대조 확인했다):
//   1) packages/orchestrator/src/index.ts:157-180 createProposalFromTelegram
//      — 규칙 기반, proposalId = "proposal_<uuid>"
//   2) packages/supabase-runtime/src/index.ts:251-271 applyLeaderPlanningResult
//      — 리더 LLM 판단, proposalId = shortProposalId() = "p_<16hex>"
//        (packages/supabase-runtime/src/index.ts:697-705, Telegram callback_data
//        64바이트 제한 때문에 축약됐다는 주석까지 확인함)
// 이 파일은 두 형식을 파싱하지 않는다 — 둘 다 불투명한 문자열 키로만 다루고,
// huai_approvals.entity_ref 와의 등치 비교에만 쓴다(miniapp-proposals/index.ts).
//
// 같은 생산자(2번, leader-planning)만 갖는 추가 필드도 있다: assignee("claude_leader"|
// "codex_leader"|"both"), assigneeReason. requestedActorRole 은 "both" 일 때 undefined 라
// 화면에 담당을 보여줄 땐 assignee 를 우선하고 없으면 requestedActorRole 로 대체한다.
export type ProposalCreatedPayload = Record<string, unknown>;

export function proposalIdFromPayload(payload: ProposalCreatedPayload): string | undefined {
  return typeof payload.proposalId === "string" ? payload.proposalId : undefined;
}

export function proposalTitleFromPayload(payload: ProposalCreatedPayload): string {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const rawText = typeof payload.rawText === "string" ? payload.rawText.trim() : "";
  return title || rawText.slice(0, 80) || "승인된 Telegram 작업";
}

export function proposalFieldFromPayload(
  payload: ProposalCreatedPayload,
  key: "purpose" | "scope" | "completionCriteria" | "rawText" | "assigneeReason"
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function proposalActorRoleFromPayload(payload: ProposalCreatedPayload): "claude_leader" | "codex_leader" | undefined {
  const value = payload.requestedActorRole;
  if (value === "claude_leader" || value === "codex_leader") return value;
  return undefined;
}

export function proposalExecutionModeFromPayload(payload: ProposalCreatedPayload): "multi_ai_review" | undefined {
  return payload.intent === "multi_ai_review" ? "multi_ai_review" : undefined;
}

// leader-planning 전용 필드. 규칙 기반 생산자는 이 필드를 안 쓰므로 undefined 가 정상이다.
export function proposalAssigneeFromPayload(payload: ProposalCreatedPayload): "claude_leader" | "codex_leader" | "both" | undefined {
  const value = payload.assignee;
  if (value === "claude_leader" || value === "codex_leader" || value === "both") return value;
  return undefined;
}

export function proposalDisplayAssignee(payload: ProposalCreatedPayload): string {
  const assignee = proposalAssigneeFromPayload(payload) ?? proposalActorRoleFromPayload(payload);
  if (assignee === "both") return "Claude + Codex";
  if (assignee === "claude_leader") return "ClaudeBot";
  if (assignee === "codex_leader") return "CodexBot";
  return "미정";
}

// leader_planning_requested 단계의 placeholder proposal_created 이벤트(아직 title/purpose 없이
// planningId 만 있는 것, packages/orchestrator/src/index.ts:255-268)는 아직 "제안"이 아니라
// "판단 요청 중"이다. proposalId 가 없는 것으로 걸러진다 — apps/bot-service/src/supabase-store.ts:498
// 의 fetchProposalExecutionHints 가 같은 이유로 같은 방식으로 건너뛰는 것과 동일한 판단이다.
export function isDisplayableProposal(payload: ProposalCreatedPayload): boolean {
  return proposalIdFromPayload(payload) !== undefined;
}

export type ProposalCreatedEventRow = {
  event_id: string;
  payload: unknown;
  created_at: string;
};

export type PendingProposal = {
  proposalId: string;
  title: string;
  purpose: string | null;
  scope: string | null;
  completionCriteria: string | null;
  assigneeDisplay: string;
  assigneeReason: string | null;
  requestedActorRole: "claude_leader" | "codex_leader" | null;
  executionMode: "multi_ai_review" | null;
  createdAt: string;
};

// 순수 함수 — DB 를 모른다. "미결"의 정의: proposal_created 이벤트 중
// huai_approvals(stage='task_approval') 에 같은 entity_ref 로 어떤 결정도 없는 것(anti-join).
// 호출자(miniapp-proposals/handler.ts)가 이미 room_id 로 스코프한 events/decidedEntityRefs 를
// 넘겨준다고 전제한다 — 방 격리 자체는 이 함수의 책임이 아니라 그 조회 쿼리의 책임이다.
export function filterPendingProposals(
  events: readonly ProposalCreatedEventRow[],
  decidedEntityRefs: readonly string[]
): PendingProposal[] {
  const decided = new Set(decidedEntityRefs);
  const seen = new Set<string>();
  const result: PendingProposal[] = [];

  for (const row of events) {
    const payload = row.payload as ProposalCreatedPayload;
    if (!payload || typeof payload !== "object") continue;
    if (!isDisplayableProposal(payload)) continue;
    const proposalId = proposalIdFromPayload(payload)!;
    if (decided.has(proposalId)) continue;
    if (seen.has(proposalId)) continue;
    seen.add(proposalId);

    result.push({
      proposalId,
      title: proposalTitleFromPayload(payload),
      purpose: proposalFieldFromPayload(payload, "purpose") ?? null,
      scope: proposalFieldFromPayload(payload, "scope") ?? null,
      completionCriteria: proposalFieldFromPayload(payload, "completionCriteria") ?? null,
      assigneeDisplay: proposalDisplayAssignee(payload),
      assigneeReason: proposalFieldFromPayload(payload, "assigneeReason") ?? null,
      requestedActorRole: proposalActorRoleFromPayload(payload) ?? null,
      executionMode: proposalExecutionModeFromPayload(payload) ?? null,
      createdAt: row.created_at
    });
  }

  return result;
}
