import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const text = readFileSync(".env.operation.example", "utf8");
const requiredKeys = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "BOT_SERVICE_PUBLIC_BASE_URL",
  "BOT_SERVICE_PLATOON_BOT_TOKEN",
  "BOT_SERVICE_CLAUDE_BOT_TOKEN",
  "BOT_SERVICE_CODEX_BOT_TOKEN",
  "BOT_SERVICE_AUDITOR_BOT_TOKEN",
  "BOT_SERVICE_PLATOON_WEBHOOK_SECRET",
  "BOT_SERVICE_CLAUDE_WEBHOOK_SECRET",
  "BOT_SERVICE_CODEX_WEBHOOK_SECRET",
  "BOT_SERVICE_AUDITOR_WEBHOOK_SECRET",
  "LOCAL_GATEWAY_ALLOWED_ROOTS",
  "LOCAL_GATEWAY_ALLOWED_ADAPTERS"
];

// 다방화 이후 이 셋은 부팅 필수값이 아니다(huai_rooms 에서 active room 전체를 로드
// 하므로). 여전히 문서로는 남겨두되(로컬 단일방 개발 편의 + 모드 감지 신호), 주석
// 처리된 상태로만 있어야 한다 — 실수로 값이 채워진 채 커밋되면 "이 env 가 곧 그 방"
// 이라는 옛 오해를 다시 심을 수 있다.
const optionalLegacyRoomKeys = [
  "BOT_SERVICE_ROOM_ID",
  "BOT_SERVICE_TELEGRAM_CHAT_ID",
  "BOT_SERVICE_OWNER_TELEGRAM_USER_ID"
];

test("operation env template contains required keys, uncommented", () => {
  for (const key of requiredKeys) {
    assert.match(text, new RegExp(`^${key}=`, "m"));
  }
});

test("legacy single-room selectors are documented but commented out, not required", () => {
  for (const key of optionalLegacyRoomKeys) {
    // 주석 처리된 형태(`# KEY=`)로는 존재해야 한다 — 존재 자체를 지우면 로컬 단일방
    // 개발 편의를 위한 사용법을 아무도 못 찾는다.
    assert.match(text, new RegExp(`^# ${key}=`, "m"), `${key} should still be documented (commented) in the template`);
    // 주석 없이 활성화된 형태로는 있으면 안 된다 — 있으면 "이 env 가 방 하나를
    // 가리킨다"는 옛 요구사항이 되살아난 것처럼 보인다.
    assert.doesNotMatch(text, new RegExp(`^${key}=`, "m"), `${key} must not appear as a required, uncommented key anymore`);
  }
});

test("operation env template does not include raw token-shaped secrets", () => {
  assert.equal(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/.test(text), false);
  assert.equal(/\bservice_role_[A-Za-z0-9_-]{16,}\b/.test(text), false);
});
