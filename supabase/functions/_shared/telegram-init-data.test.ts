// verifyTelegramInitData 실제 서명 검증 왕복 테스트. 실행 방법은 proposal-payload.test.ts
// 상단 주석 참고.
//
// 팀장님 지적(핵심 공백): 지금까지 이 프로젝트의 모든 handler 테스트는 authenticate 를
// `async () => ({ok:true, telegramUserId:"111"})` 같은 통짜 가짜로 갈아끼웠다 — 즉 "거부
// 경로"만 검증됐고, 진짜 initData 서명을 만들어 진짜로 검증을 통과시키는 "정상 경로"는
// 한 번도 실행된 적이 없었다. 이 파일이 그 공백을 메운다: Telegram 공식 서명 절차를
// (검증 코드와 독립적으로) 그대로 구현해 유효한 initData 를 만들고, 실제
// verifyTelegramInitData() 에 넣어 통과하는지 확인한다.
import test from "node:test";
import assert from "node:assert/strict";
import { verifyTelegramInitData, DEFAULT_MAX_AUTH_DATE_AGE_SECONDS } from "./telegram-init-data";
import { signInitData, validInitDataFields } from "./test-support";

// 앞자리를 4자리로 둔다. verify-no-secrets 스캐너가 `\d{5,}:[A-Za-z0-9_-]{20,}` 를
// 자격증명 모양으로 보고 막는데, 실제 Telegram bot id 는 8~10자리라 4자리는 그 모양에
// 걸리지 않으면서 픽스처로는 그대로 쓸 수 있다(토큰은 HMAC 키로만 쓰이고 형식 파싱은 없다).
const TEST_BOT_TOKEN = "1234:AAtest-bot-token-for-regression-only";
const validFields = validInitDataFields;

test("유효하게 서명된 initData는 통과하고 telegramUserId를 정확히 뽑아낸다 (정상 경로, 처음 실행)", async () => {
  const initData = signInitData(validFields(), TEST_BOT_TOKEN);
  const result = await verifyTelegramInitData(initData, TEST_BOT_TOKEN);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.telegramUserId, "123456789");
  }
});

test("start_param이 있으면 서명 검증을 통과하면서 그 값도 함께 반환된다", async () => {
  const initData = signInitData(validFields({ start_param: "847d1638-d23b-43a8-a445-54ecb29560f7" }), TEST_BOT_TOKEN);
  const result = await verifyTelegramInitData(initData, TEST_BOT_TOKEN);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.startParam, "847d1638-d23b-43a8-a445-54ecb29560f7");
});

test("한 글자라도 값이 변조되면(서명 대상 필드) 거부된다 — hash는 그대로인데 user만 바뀐 경우", async () => {
  const initData = signInitData(validFields(), TEST_BOT_TOKEN);
  const tampered = initData.replace(/user=[^&]+/, "user=" + encodeURIComponent(JSON.stringify({ id: 999999999 })));
  const result = await verifyTelegramInitData(tampered, TEST_BOT_TOKEN);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad-signature");
});

test("다른 봇 토큰으로 서명된 initData는 우리 봇 토큰으로 검증하면 거부된다", async () => {
  const initData = signInitData(validFields(), "000000000:different-bot-token");
  const result = await verifyTelegramInitData(initData, TEST_BOT_TOKEN);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad-signature");
});

test("auth_date가 만료 창을 넘으면 서명이 유효해도 거부된다(재생 공격 방지)", async () => {
  const expiredAuthDate = String(Math.floor(Date.now() / 1000) - DEFAULT_MAX_AUTH_DATE_AGE_SECONDS - 3600);
  const initData = signInitData(validFields({ auth_date: expiredAuthDate }), TEST_BOT_TOKEN);
  const result = await verifyTelegramInitData(initData, TEST_BOT_TOKEN);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
});

test("maxAgeSeconds를 넉넉히 주면 같은 오래된 auth_date도 통과한다(만료 판정이 auth_date 값 자체가 아니라 창 크기에 달렸다는 것의 증명)", async () => {
  const oldAuthDate = String(Math.floor(Date.now() / 1000) - 3600);
  const initData = signInitData(validFields({ auth_date: oldAuthDate }), TEST_BOT_TOKEN);
  const result = await verifyTelegramInitData(initData, TEST_BOT_TOKEN, 7200);
  assert.equal(result.ok, true);
});
