import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const docs = [
  "2026_08_11__HuAI_Collab_Chatroom_System_페이스북_소개글.md",
  "2026_08_11__CODEX_방식A_다중그룹_온보딩_지시문.md",
  "2026_08_23__HuAI_System_관계도.svg",
  "2026_08_23__HuAI_System_작업흐름도.svg",
  "SYSTEM_DOCUMENTATION_SYNC.md",
  "README.md",
  "GITHUB_QUICKSTART.md",
  "GITHUB_RELEASE_CHECKLIST.md",
];

const stalePhrases = [
  "요청 → 승인 → 실행 → 보고 → 자동 검증",
  "AuditBot이 자동으로 검증 요청을 올립니다",
  "AuditBot 자동 검증 요청",
  "완료 후 AuditBot 자동 호출",
  "자동 검증 요청",
  "[승인] 버튼",
  "재검증 / 보완 / 최종승인",
  "▶",
  "↻",
];

function read(path) {
  return readFileSync(path, "utf8");
}

test("system explanation docs stay aligned with current Telegram UX", () => {
  const allText = docs.map((path) => `${path}\n${read(path)}`).join("\n\n");

  for (const phrase of stalePhrases) {
    assert.equal(
      allText.includes(phrase),
      false,
      `stale documentation phrase remains: ${phrase}`,
    );
  }

  assert.match(allText, /의미 있는 결과물/);
  assert.match(allText, /@audit_chatroom_bot/);
  assert.match(allText, /다중 AI 협의/);
  assert.match(allText, /ClaudeBot과 CodexBot/);
  assert.match(allText, /실행/);
  assert.match(allText, /검증/);
  assert.match(allText, /문서 동기화 체크/);
  assert.match(allText, /GITHUB_QUICKSTART.md/);
  assert.match(allText, /15분/);
});