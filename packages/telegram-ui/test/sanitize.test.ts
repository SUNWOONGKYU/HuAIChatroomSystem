import assert from "node:assert/strict";
import test from "node:test";
import { maskTelegramSensitiveText, safeTelegramTraceUri, sanitizeTelegramVisibleText } from "../src/sanitize.js";

test("masks telegram and auth secrets", () => {
  const text = 'bot123:ABC_def Bearer token.value apikey: SECRET authorization "AUTH" service_role=ROLEKEY';
  const masked = maskTelegramSensitiveText(text);
  assert.equal(masked.includes('ABC_def'), false);
  assert.equal(masked.includes('token.value'), false);
  assert.equal(masked.includes('SECRET'), false);
  assert.equal(masked.includes('AUTH'), false);
  assert.equal(masked.includes('ROLEKEY'), false);
});

test("masks trace uri query secrets", () => {
  const uri = 'supabase://bucket/report.md?token=SECRET&signature=SIG&public=ok';
  const masked = safeTelegramTraceUri(uri);
  assert.equal(masked.includes('SECRET'), false);
  assert.equal(masked.includes('SIG'), false);
  assert.match(masked, /public=ok/);
});

test("Telegram visible text removes internal JSON logs and stack traces", () => {
  const text = sanitizeTelegramVisibleText([
    "작업 실행 완료",
    '{"type":"item.completed","token":"secret"}',
    "2026-08-13T10:00:00Z DEBUG hook started",
    "stderr: Error: private failure",
    "at run (C:\\Dev\\worker.ts:10:2)",
    "결과: 사용자용 요약"
  ].join("\n"));
  assert.equal(text, "작업 실행 완료\n결과: 사용자용 요약");
});

test("Telegram visible text replaces output containing only internals", () => {
  assert.equal(
    sanitizeTelegramVisibleText('{"type":"debug","payload":{"secret":"value"}}'),
    "내부 실행 정보는 Telegram에 표시하지 않습니다. 운영 기록에서 확인해 주세요."
  );
});

test("Telegram visible text preserves normal bracketed human text", () => {
  assert.equal(sanitizeTelegramVisibleText("[완료] 배포 검증 통과"), "[완료] 배포 검증 통과");
});

test("Telegram visible text removes fenced pretty JSON", () => {
  assert.equal(
    sanitizeTelegramVisibleText("결과\n```json\n{\n  \"debug\": true\n}\n```\n요약 완료"),
    "결과\n요약 완료"
  );
});
