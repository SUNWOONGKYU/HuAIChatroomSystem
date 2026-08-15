// 순수 핸들러 — Deno.* 를 참조하지 않는다. index.ts 가 실제 Supabase 호출을 주입한다.
// 이렇게 나눈 이유: Deno.serve 가 모듈 로드 시점에 실행되는 파일은 Node 로 import 하는
// 순간 "Deno is not defined" 로 죽어서 회귀 테스트를 못 돌린다. 이 파일은 그 문제가 없어서
// `node --test` 로 실제 실행 가능한 회귀 테스트를 짤 수 있다(handler.test.ts 참고).
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import type { MembershipCheckResult, MiniAppAuthResult } from "../_shared/types.ts";
import {
  filterPendingProposals,
  type ProposalCreatedEventRow
} from "../_shared/proposal-payload.ts";

export type ProposalsHandlerDeps = {
  authenticate(req: Request): Promise<MiniAppAuthResult>;
  checkRoomAccess(roomId: string, telegramUserId: string): Promise<MembershipCheckResult>;
  // room_id 로 이미 스코프된 조회를 기대한다 — 이 함수는 그 필터가 실제로 걸렸는지까지는
  // 보장하지 못한다(그건 index.ts 의 실제 쿼리 책임). handler 단위 테스트에서는 대신
  // "다른 방 이벤트를 deps 가 실수로 섞어 넣어도 room_id 로 걸러지는가"는 검증할 수 없으므로,
  // index.ts 쪽에 room_id 필터가 있다는 것을 코드 리뷰로 별도 확인해야 한다.
  fetchProposalEvents(roomId: string): Promise<{ error?: string; data?: ProposalCreatedEventRow[] }>;
  fetchDecidedEntityRefs(roomId: string): Promise<{ error?: string; data?: string[] }>;
};

export async function handleMiniappProposalsRequest(req: Request, deps: ProposalsHandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "GET") return jsonResponse(405, { error: "method-not-allowed" });

  const auth = await deps.authenticate(req);
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.message });

  const url = new URL(req.url);
  const roomId = url.searchParams.get("roomId");
  if (!roomId) return jsonResponse(400, { error: "missing-room-id" });

  const access = await deps.checkRoomAccess(roomId, auth.telegramUserId);
  if (!access.ok) return jsonResponse(access.status, { error: access.message });

  const eventsResult = await deps.fetchProposalEvents(roomId);
  if (eventsResult.error) {
    console.error(`miniapp-proposals: events query failed: ${eventsResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }

  const decidedResult = await deps.fetchDecidedEntityRefs(roomId);
  if (decidedResult.error) {
    console.error(`miniapp-proposals: approvals query failed: ${decidedResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }

  const proposals = filterPendingProposals(eventsResult.data ?? [], decidedResult.data ?? []);

  return jsonResponse(200, {
    room: access.room,
    // 정적 페이지가 owner 가 아닌 사용자에게는 승인/거부 버튼을 아예 숨길 수 있도록
    // miniapp-tasks 응답과 동일하게 viewerRole 을 함께 내려준다. 실제 인가는 여전히
    // miniapp-approve 가 서버에서 다시 확인한다 — 이건 UX 용이지 보안 경계가 아니다.
    viewerRole: access.viewerRole,
    proposals,
    generatedAt: new Date().toISOString()
  });
}
