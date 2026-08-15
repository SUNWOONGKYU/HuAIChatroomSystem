// buildDepsFromClient — 실제 Supabase 쿼리 조립 부분만 담은, Deno.* 를 참조하지 않는 파일.
//
// 이 파일이 따로 존재하는 이유(판단 사항, 문서화): 이 리팩터의 목표는 index.ts 의 buildDeps()
// 안에서 조립되는 `.from("huai_events").eq("room_id", roomId)` 류의 쿼리가 실제로 필터링을
// 거는지를 node --test 로 실행 검증하는 것이다. miniapp-tasks 쪽은 그 조립 함수를
// handler.ts 에 두면 됐지만, 이 방(miniapp-proposals)의 handler.ts 는 이번 작업에서 건드리지
// 않기로 되어 있다(이미 검증된 handler 단위 테스트가 있고, 그 공개 API 를 흔들 이유가 없다).
// 그렇다고 index.ts 에 그대로 두면, index.ts 최상단의 Deno.serve(...)/Deno.env.get(...) 호출
// 때문에 이 파일 전체를 Node 로 import 하는 순간 "Deno is not defined" 로 죽어서 테스트가
// 불가능하다. 그래서 쿼리 조립 로직만 Deno 미참조 파일로 분리했다 — index.ts(진짜 클라이언트)
// 와 room-isolation.test.ts(FakeSupabaseClient) 양쪽이 이 함수를 그대로 재사용한다.
import type { MinimalSupabaseClient } from "../_shared/fake-supabase-client.ts";
import type { ProposalCreatedEventRow } from "../_shared/proposal-payload.ts";

// authenticate/checkRoomAccess 를 뺀 나머지 — ProposalsHandlerDeps(handler.ts) 의 부분집합.
// index.ts 의 buildDeps() 가 이 결과에 authenticate/checkRoomAccess 를 얹어 전체를 완성한다.
export type ProposalsQueryDeps = {
  fetchProposalEvents(roomId: string): Promise<{ error?: string; data?: ProposalCreatedEventRow[] }>;
  fetchDecidedEntityRefs(roomId: string): Promise<{ error?: string; data?: string[] }>;
};

export function buildDepsFromClient(supabase: MinimalSupabaseClient): ProposalsQueryDeps {
  return {
    async fetchProposalEvents(roomId: string) {
      const { data, error } = await supabase
        .from("huai_events")
        .select("event_id, payload, created_at")
        .eq("room_id", roomId)
        .eq("event_type", "proposal_created")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) return { error: error.message };
      return { data: (data ?? []) as ProposalCreatedEventRow[] };
    },
    async fetchDecidedEntityRefs(roomId: string) {
      const { data, error } = await supabase
        .from("huai_approvals")
        .select("entity_ref")
        .eq("room_id", roomId)
        .eq("stage", "task_approval");
      if (error) return { error: error.message };
      return { data: ((data ?? []) as { entity_ref: string }[]).map((row) => row.entity_ref) };
    }
  };
}
