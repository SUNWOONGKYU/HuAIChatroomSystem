import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE,
  compareToBaseline,
  createProbes,
  evaluateSpecCoverage,
  loadSources,
  summarize
} from "./verify-spec-coverage.mjs";

const rows = evaluateSpecCoverage();

test("모든 기획서 요구사항이 판정된다 (FR 20 + H 13 + AC 15 + NFR 10)", () => {
  assert.equal(rows.filter((row) => row.id.startsWith("FR-")).length, 20);
  assert.equal(rows.filter((row) => row.id.startsWith("H-")).length, 13);
  assert.equal(rows.filter((row) => row.id.startsWith("AC-")).length, 15);
  assert.equal(rows.filter((row) => row.id.startsWith("NFR-")).length, 10);
  assert.equal(summarize(rows).total, 58);
});

test("현재 구현 판정이 기록된 baseline과 일치한다", () => {
  const drift = compareToBaseline(rows, BASELINE);
  assert.deepEqual(drift, [], `spec coverage drift: ${JSON.stringify(drift)}`);
});

test("판정은 pass/partial/missing 세 값만 사용한다", () => {
  for (const row of rows) {
    assert.equal(["pass", "partial", "missing"].includes(row.verdict), true, `${row.id}=${row.verdict}`);
    assert.equal(row.evidence.length > 0, true, `${row.id} 근거 없음`);
  }
});

test("타입 선언만 있는 이벤트는 발행으로 세지 않는다", () => {
  const probe = createProbes(loadSources());
  // 두 이름 모두 contracts/workflow 타입 선언에는 존재한다.
  assert.equal(probe.emitsEvent("owner_task_approved"), true, "실제 발행되는 이벤트는 참이어야 한다");
  assert.equal(probe.emitsEvent("ai_actor_inactive"), false, "선언만 있는 이벤트는 거짓이어야 한다");
});

test("아티팩트 저장 경로가 실제 쓰기 근거로 확인된다 (H-03)", () => {
  const artifactRow = rows.find((row) => row.id === "H-03");
  assert.equal(artifactRow?.verdict, "pass");
  // "*" 는 행위 근거 표시 — 문자열 존재가 아니라 실제 DB 쓰기·이벤트 발행을 봤다는 뜻이다.
  assert.match(artifactRow?.evidence ?? "", /\+\*write:huai_artifacts/);
  assert.match(artifactRow?.evidence ?? "", /\+\*artifact_saved-emitted/);
});

test("행위 근거가 없으면 pass 를 줄 수 없다 (AC-02 위양성 재발 방지)", () => {
  for (const row of rows) {
    if (row.verdict !== "pass") continue;
    assert.match(row.evidence, /\+\*/, `${row.id} 가 문자열 존재 근거만으로 pass 판정됨`);
  }
});

test("보고 수치는 근거 있는 구현만 센다", () => {
  const summary = summarize(rows);
  assert.equal(summary.pass + summary.partial + summary.missing, 58);
  // 기획서 전체 구현 완료가 아님을 수치로 고정한다.
  assert.equal(summary.pass < 58, true, "전량 pass 는 현재 상태와 맞지 않는다");
  assert.equal(summary.missing > 0, true, "미구현 항목이 0 이면 판정 로직을 의심하라");
});

test("미배선 테이블은 미구현으로 판정된다", () => {
  const probe = createProbes(loadSources());
  // huai_revision_requests 는 2026-08-15 보완·재검증 루프 배선으로 목록에서 빠졌다.
  assert.equal(probe.writesTable("huai_revision_requests"), true, "보완 요청 쓰기 경로가 살아 있어야 한다");
  assert.equal(probe.writesTable("huai_reports"), false);
  assert.equal(probe.writesTable("huai_audit_logs"), false);
  assert.equal(probe.writesTable("huai_recovery_snapshots"), false);
  assert.equal(probe.writesTable("huai_execution_attempts"), false);
  assert.equal(probe.writesTable("huai_hook_attempts"), false);
});
