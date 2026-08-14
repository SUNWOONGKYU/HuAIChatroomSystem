import assert from "node:assert/strict";
import test from "node:test";
import { deriveProposalStructure } from "../src/index.js";

// FR-007 / AC-03: 제안은 목적·범위·완료 조건으로 구조화되어야 한다.
// 완료 조건이 특히 중요하다 — 검증자가 무엇으로 합격/불합격을 판정할지가 여기서 정해진다.

test("완료 조건은 어떤 요청에서도 비어 있지 않다", () => {
  const inputs = [
    "로그인 세션 만료 버그를 고쳐줘",
    "왜 안 되는지 원인 좀 알아봐",
    "운영 문서 정리해줘",
    "이 코드 검토해줘",
    "알림 기능 추가해줘",
    "그거 해줘"
  ];
  for (const text of inputs) {
    const structure = deriveProposalStructure(text, "요청 처리");
    assert.equal(structure.completionCriteria.trim().length > 0, true, text);
    assert.equal(structure.scope.trim().length > 0, true, text);
    assert.equal(structure.purpose.trim().length > 0, true, text);
  }
});

test("요청자가 완료 조건을 직접 말하면 그것을 쓴다", () => {
  const structure = deriveProposalStructure("로그인 버그 고쳐줘. 재현 안 되면 완료", "장애 원인 수정");
  assert.match(structure.completionCriteria, /재현 안 되면 완료로 본다/);
});

test("테스트 통과 요구는 완료 조건으로 인식된다", () => {
  const structure = deriveProposalStructure("리팩터링하고 테스트 통과시켜줘", "수정 작업");
  assert.match(structure.completionCriteria, /테스트와 빌드가 통과/);
});

test("요청 종류별로 다른 완료 조건이 도출된다", () => {
  const bug = deriveProposalStructure("결제가 안 되는 오류를 고쳐줘", "장애 원인 수정");
  const research = deriveProposalStructure("이 지연의 원인을 분석해줘", "요청 처리");
  const docs = deriveProposalStructure("운영 문서를 작성해줘", "문서 및 다이어그램 갱신");
  const feature = deriveProposalStructure("알림 기능을 구현해줘", "구현 작업");

  assert.match(bug.completionCriteria, /재현되지 않고/);
  assert.match(research.completionCriteria, /조사 결과와 근거/);
  assert.match(docs.completionCriteria, /문서가 생성·갱신/);
  assert.match(feature.completionCriteria, /실제로 실행되어 확인/);
  // 서로 달라야 의미가 있다 — 전부 같은 문자열이면 구조화가 아니다.
  assert.equal(new Set([bug, research, docs, feature].map((s) => s.completionCriteria)).size, 4);
});

test("목적을 직접 말하면 그 절을 목적으로 쓴다", () => {
  const structure = deriveProposalStructure("배포 시간을 줄이기 위해 빌드 캐시를 붙여줘", "구현 작업");
  assert.match(structure.purpose, /배포 시간을 줄이기 위해/);
});

test("목적을 말하지 않으면 첫 문장이나 제목으로 대체한다", () => {
  const structure = deriveProposalStructure("알림 기능 추가해줘", "구현 작업");
  assert.equal(structure.purpose.length > 0, true);
  assert.equal(structure.purpose === structure.completionCriteria, false);
});

test("범위는 요청 원문을 보존한다", () => {
  const text = "결제 모듈의 재시도 횟수를 3회로 바꿔줘";
  assert.equal(deriveProposalStructure(text, "수정 작업").scope, text);
});

test("빈 요청도 구조를 잃지 않는다", () => {
  const structure = deriveProposalStructure("", "새 작업");
  assert.equal(structure.purpose, "새 작업");
  assert.equal(structure.scope, "새 작업");
  assert.equal(structure.completionCriteria.length > 0, true);
});
