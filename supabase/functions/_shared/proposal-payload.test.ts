// filterPendingProposals 회귀 테스트 — 순수 함수라 Deno 없이 node --test 로 돌릴 수 있다.
// 실행 방법(이 디렉터리는 루트 tsconfig.check.json/build 대상이 아니므로 별도 컴파일 필요):
//   1) 이 파일들( _shared/{cors,types,proposal-payload,proposal-payload.test}.ts,
//      miniapp-proposals/handler.ts, miniapp-proposals/handler.test.ts,
//      miniapp-approve/handler.ts, miniapp-approve/handler.test.ts )을 스크래치 디렉터리로
//      복사하면서 상대 import 의 ".ts" 확장자를 제거한다(Deno 컨벤션 → Node 컨벤션).
//   2) npx tsc --module commonjs --target ES2022 --outDir <scratch>/dist <복사한 .ts 전부>
//   3) node --test <scratch>/dist
// 이 파일 자체는 그대로 두되, 프로젝트 루트 npm 스크립트에는 연결하지 않았다(팀장님 지시
// 없이 package.json 을 건드리지 않는다) — 필요하면 위 절차를 스크립트로 굳혀도 된다.
import test from "node:test";
import assert from "node:assert/strict";
import { filterPendingProposals, type ProposalCreatedEventRow } from "./proposal-payload";

function event(overrides: Partial<ProposalCreatedEventRow> & { payload: Record<string, unknown> }): ProposalCreatedEventRow {
  return { event_id: "evt-" + Math.random(), created_at: "2026-08-15T00:00:00Z", ...overrides };
}

test("미결 제안이 목록에 뜬다", () => {
  const events = [
    event({ payload: { proposalId: "proposal_11111111-1111-1111-1111-111111111111", title: "제목", purpose: "목적" } })
  ];
  const result = filterPendingProposals(events, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].proposalId, "proposal_11111111-1111-1111-1111-111111111111");
  assert.equal(result[0].title, "제목");
});

test("이미 결정된 제안(huai_approvals 에 entity_ref 존재)은 안 뜬다", () => {
  const events = [
    event({ payload: { proposalId: "proposal_aaaa", title: "결정됨" } }),
    event({ payload: { proposalId: "proposal_bbbb", title: "미결" } })
  ];
  const result = filterPendingProposals(events, ["proposal_aaaa"]);
  assert.equal(result.length, 1);
  assert.equal(result[0].proposalId, "proposal_bbbb");
});

test("제안 id 두 형식(proposal_<uuid>, p_<16hex>) 모두 처리된다", () => {
  const events = [
    event({ payload: { proposalId: "proposal_11111111-1111-1111-1111-111111111111", title: "규칙기반" } }),
    event({ payload: { proposalId: "p_0123456789abcdef", title: "소대장판단", assignee: "codex_leader" } })
  ];
  const result = filterPendingProposals(events, []);
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((p) => p.proposalId).sort(),
    ["p_0123456789abcdef", "proposal_11111111-1111-1111-1111-111111111111"]
  );
  const leaderPlanned = result.find((p) => p.proposalId === "p_0123456789abcdef")!;
  assert.equal(leaderPlanned.assigneeDisplay, "CodexBot");
});

test("leader_planning_requested 단계 placeholder(proposalId 없음)는 제외된다", () => {
  const events = [event({ payload: { planningId: "planning_xyz", stage: "leader_planning_requested" } })];
  const result = filterPendingProposals(events, []);
  assert.equal(result.length, 0);
});

test("같은 proposalId 가 이벤트 재시도 등으로 중복되어도 한 번만 나온다", () => {
  const events = [
    event({ payload: { proposalId: "proposal_dup", title: "A" } }),
    event({ payload: { proposalId: "proposal_dup", title: "A" } })
  ];
  const result = filterPendingProposals(events, []);
  assert.equal(result.length, 1);
});

test("assignee='both' 는 'Claude + Codex' 로 표시된다", () => {
  const events = [event({ payload: { proposalId: "p_both", title: "협업", assignee: "both" } })];
  const result = filterPendingProposals(events, []);
  assert.equal(result[0].assigneeDisplay, "Claude + Codex");
});
