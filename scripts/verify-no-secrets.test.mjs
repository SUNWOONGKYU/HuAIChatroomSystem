import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  patterns,
  findSecretHits,
  isScannable,
  collectFilesToScan,
  getOversizedSkips,
  getSkippedFiles,
  looksBinary,
  controlByteRatio,
  stripControlCharacters
} from "./verify-no-secrets.mjs";

function regexFor(name) {
  const found = patterns.find((pattern) => pattern.name === name);
  assert.ok(found, `패턴 ${name} 이 정의돼 있어야 한다`);
  return found.regex;
}

// 결함(4차 감사) 대응 — telegram-bot-token 접미부 문자클래스가 개행(\n)을 안 받아,
// 토큰을 줄바꿈으로 쪼개면 매치가 끊겨 통과했다(4차 평가관 실증). 콜론 뒤 접미부에만
// \n 을 허용해 재붙임한다.
test("텔레그램 봇 토큰을 탐지한다(줄바꿈 없는 정상 형태)", () => {
  const regex = regexFor("telegram-bot-token");
  assert.match("BOT_TOKEN=123456789:AAFooBarBaz0123456789AbCdEfGhIj", regex);
});
test("줄바꿈으로 쪼갠 텔레그램 봇 토큰도 탐지한다 — 4차 감사 우회 재현", () => {
  const regex = regexFor("telegram-bot-token");
  assert.match("leak: 123456789:ABCdefGHI\nJKLmnoPQRstuVWXyz12", regex);
});
test("숫자열:콜론 뒤가 20자 미만이면(줄바꿈으로 쪼개도) 통과한다", () => {
  const regex = regexFor("telegram-bot-token");
  assert.doesNotMatch("id: 123456789:short\nmore", regex);
});

// 결함(6차 감사) 대응 — 5차에 telegram-bot-token 만 줄바꿈 분할을 고쳤고
// service-role-key/telegram-chat-id-dump/telegram-chat-id-bare-value 는 그대로
// 남아 6차 평가관이 세 패턴 전부 재현했다. 같은 방식(식별자/숫자열 문자클래스에만
// \n 추가)으로 넓혔는지 양성(분할 탐지)·음성(오탐 안 늘어남) 둘 다 검증한다.
test("service_role_ 키를 탐지한다(줄바꿈 없는 정상 형태)", () => {
  const regex = regexFor("service-role-key");
  assert.match("SUPABASE_SERVICE_ROLE_KEY=service_role_aBc123XyZ9876543210defgh", regex);
});
test("줄바꿈으로 쪼갠 service_role_ 키도 탐지한다 — 6차 감사 우회 재현", () => {
  const regex = regexFor("service-role-key");
  assert.match("leak: service_role_aBc123XyZ98765\n43210defgh", regex);
});
test("service_role_ 뒤 식별자가 16자 미만이면(줄바꿈으로 쪼개도) 통과한다", () => {
  const regex = regexFor("service-role-key");
  assert.doesNotMatch("id: service_role_short\nmore", regex);
});

// 결함 2 대응 — 벤더 API 키 접두사 8종. 실제 키 모양(양성)은 잡고, 문서·예제
// 플레이스홀더(음성)는 통과해야 한다.

test("Anthropic 키를 탐지한다", () => {
  const regex = regexFor("anthropic-api-key");
  assert.match("ANTHROPIC_API_KEY=sk-ant-api03-aBc123XyZ9876543210defghijklmnop", regex);
});
test("Anthropic 문서 플레이스홀더는 통과한다", () => {
  const regex = regexFor("anthropic-api-key");
  assert.doesNotMatch("ANTHROPIC_API_KEY=sk-ant-YOUR_KEY_HERE", regex);
});

test("OpenAI project 키를 탐지한다", () => {
  const regex = regexFor("openai-project-key");
  assert.match("OPENAI_API_KEY=sk-proj-aBc123XyZ9876543210defghijklmnop", regex);
});
test("OpenAI project 플레이스홀더는 통과한다", () => {
  const regex = regexFor("openai-project-key");
  assert.doesNotMatch("OPENAI_API_KEY=sk-proj-YOUR_OPENAI_PROJECT_KEY", regex);
});

test("OpenAI legacy 키를 탐지한다", () => {
  const regex = regexFor("openai-legacy-key");
  assert.match("OPENAI_API_KEY=sk-aBc123XyZ9876543210defghijklmnop", regex);
});
test("OpenAI legacy 플레이스홀더는 통과한다", () => {
  const regex = regexFor("openai-legacy-key");
  assert.doesNotMatch("OPENAI_API_KEY=sk-YOUR-OPENAI-KEY-HERE", regex);
});

test("Google API 키를 탐지한다", () => {
  const regex = regexFor("google-api-key");
  assert.match("GOOGLE_API_KEY=AIzaSyD9876543210aBcDeFgHiJkLmNoPqRsTuVw", regex);
});
test("Google API 문서 플레이스홀더는 통과한다", () => {
  const regex = regexFor("google-api-key");
  assert.doesNotMatch("GOOGLE_API_KEY=AIzaSyYOUR_GOOGLE_API_KEY_GOES_HERE", regex);
});

test("GitHub classic PAT 를 탐지한다", () => {
  const regex = regexFor("github-pat-classic");
  assert.match("token: ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", regex);
});
test("GitHub classic PAT 플레이스홀더는 통과한다", () => {
  const regex = regexFor("github-pat-classic");
  assert.doesNotMatch("token: ghp_YOUR_GITHUB_PERSONAL_ACCESS_TOKEN", regex);
});

test("GitHub fine-grained PAT 를 탐지한다", () => {
  const regex = regexFor("github-pat-fine-grained");
  assert.match("token: github_pat_11AABBCCDD0aBcDeFgHiJ1234567890xyz", regex);
});
test("GitHub fine-grained PAT 플레이스홀더는 통과한다", () => {
  const regex = regexFor("github-pat-fine-grained");
  assert.doesNotMatch("token: github_pat_REPLACE_WITH_YOUR_TOKEN", regex);
});

test("Slack 토큰을 탐지한다", () => {
  const regex = regexFor("slack-token");
  assert.match("SLACK_BOT_TOKEN=xo" + "xb-1234567890123-1234567890123-abcdefghijklmnopqrstuv", regex);
});
test("Slack 문서 플레이스홀더는 통과한다", () => {
  const regex = regexFor("slack-token");
  assert.doesNotMatch("SLACK_BOT_TOKEN=xo" + "xb-your-slack-bot-token-here", regex);
});

test("AWS Access Key ID 를 탐지한다", () => {
  const regex = regexFor("aws-access-key-id");
  assert.match("aws_access_key_id = AKIATESTKEY1234567AB", regex);
});
test("AWS 공식 문서 예시 문자열(EXAMPLE)은 통과한다", () => {
  const regex = regexFor("aws-access-key-id");
  // AWS 공식 문서 자신이 쓰는 예시 — 이 문자열 자체는 실제 키가 아니다.
  assert.doesNotMatch("aws_access_key_id = AKIAIOSFODNN7EXAMPLE", regex);
});

// 결함 2 대응 — 스캔 범위(roots 바깥, 저장소 루트)와 확장자 화이트리스트.
test("스캔 대상 확장자에 .txt 가 포함된다 — audit_msg.txt 류 대응", () => {
  assert.equal(isScannable("audit_msg.txt"), true);
});
test("node_modules/dist/.git 은 스캔 대상에서 제외된다", () => {
  assert.equal(isScannable("node_modules/pkg/index.js"), false);
  assert.equal(isScannable("dist/apps/local-gateway/src/index.js"), false);
  assert.equal(isScannable(".git/config"), false);
});
// 결함(6차 감사) 대응 — isScannable() 은 더 이상 테스트/브라우저 테스트 파일을 통째로
// 걸러내지 않는다(machine-absolute-path 같은 진짜 결함이 test 제외 뒤에 숨어 5라운드
// 안 걸렸던 사건 대응, verify-no-secrets.mjs 의 isScannable 주석 참고). 어떤 패턴을
// 적용할지는 findSecretHits() 가 파일 종류로 골라서 처리한다 — 이 테스트는 그 역할
// 분담이 유지되는지 확인한다.
test("테스트/브라우저 테스트 파일도 이제 스캔 대상이다(패턴 선별은 findSecretHits 가 맡는다)", () => {
  assert.equal(isScannable("apps/local-gateway/test/artifact-publisher.test.ts"), true);
  assert.equal(isScannable("supabase/miniapp-web/egg-game.browser-test.mjs"), true);
});

// 결함(3차 감사) 대응 — 화이트리스트를 블랙리스트로 뒤집었다. start-services-detached.ps1
// (.ps1 이 화이트리스트에 없어 개발자 PC 절대경로를 안 열어봤다)류 재발을 막는다.
test("블랙리스트 전환 — 화이트리스트에 없던 확장자(.csv/.log/.ps1/.cmd/.py/.sh)도 이제 스캔한다", () => {
  assert.equal(isScannable("scripts/some-dump.csv"), true);
  assert.equal(isScannable("scripts/service.log"), true);
  assert.equal(isScannable("scripts/start-services-detached.ps1"), true);
  assert.equal(isScannable("scripts/nightly-room-archive.cmd"), true);
  assert.equal(isScannable("scripts/agent.py"), true);
  assert.equal(isScannable("scripts/deploy.sh"), true);
});
test("블랙리스트 전환 — 알려진 바이너리 확장자는 여전히 제외한다", () => {
  assert.equal(isScannable("supabase/miniapp-web/_task-artifacts/foo.png"), false);
  assert.equal(isScannable("assets/logo.ico"), false);
  assert.equal(isScannable("scripts/tool.exe"), false);
});

test("collectFilesToScan 은 apps/packages/supabase/scripts 바깥, 저장소 루트의 추적 파일도 포함한다", () => {
  // 결함 회귀 — roots=[apps,packages,supabase,scripts] 만 보던 예전 스캔은 저장소
  // 루트에 떨어진 파일(outbox_all.json 류)을 전혀 못 봤다. README.md 는 루트에 있는
  // 실제 추적 파일이라, 이게 결과에 들어와야 그 구멍이 막힌 것이다.
  const files = collectFilesToScan();
  assert.ok(files.includes("README.md"), "루트 추적 파일이 스캔 대상에 들어와야 한다");
});

// 결함(4차 감사) 대응 — "루트 직속" 추적 파일만 보던 스캔은 roots 바깥·저장소 루트도
// 아닌 서브디렉터리(docs/, .github/, _archive/, assets/ 등)를 커밋 이후 영구히 못 봤다
// (4차 평가관이 collectFilesToScan() 실제 출력으로 확인). 그 각 디렉터리에서 실제로
// 추적 중인 파일 하나씩을 대표로 뽑아 스캔 대상에 들어오는지 회귀 테스트로 고정한다.
test("collectFilesToScan 은 roots 바깥의 추적 서브디렉터리(docs/.github/_archive/assets)도 포함한다", () => {
  const files = collectFilesToScan();
  assert.ok(files.includes("docs/kpi-measurement.json"), "docs/ 아래 추적 파일이 스캔 대상에 들어와야 한다");
  assert.ok(files.includes(".github/workflows/verify.yml"), ".github/ 아래 추적 파일이 스캔 대상에 들어와야 한다");
  assert.ok(files.includes("_archive/gates/README.md"), "_archive/ 아래 추적 파일이 스캔 대상에 들어와야 한다");
  assert.ok(files.includes("assets/telegram-bot-profiles/README.md"), "assets/ 아래 추적 파일이 스캔 대상에 들어와야 한다");
});

// 결함(4차 감사) 대응 — 5MB 초과 파일은 secret-scan-skip-oversized 로그만 남기고
// files 목록에서는 조용히 빠졌다. getOversizedSkips() 로 그 사실이 최종 판정에
// 반영될 수 있게 기록되는지 확인한다(roots 안에 있는 파일이라야 collect() 의 파일시스템
// 재귀 스캔이 git add 없이도 잡는다 — 실제 저장소 파일을 잠깐 만들었다가 지운다).
test("5MB 초과 파일은 files 목록에서 빠지고 getOversizedSkips() 에 기록된다", () => {
  const fixturePath = "scripts/__oversized-secret-scan-fixture.tmp.js";
  writeFileSync(fixturePath, "x".repeat(5 * 1024 * 1024 + 10));
  try {
    // collect() 는 node:path 의 join() 을 쓰는데, 이건 플랫폼 기본 구분자를 쓴다 —
    // Windows 에서는 백슬래시로 합쳐지므로("scripts\\__oversized-...") 비교 전에 슬래시를
    // 통일한다(gitFiles() 쪽 경로는 git 이 항상 "/" 로 내놓아 이 문제가 없다 — 바로 위
    // 테스트가 fixturePath 를 그대로 비교해도 통과하는 이유).
    const normalize = (path) => path.replace(/\\/g, "/");
    const files = collectFilesToScan().map(normalize);
    assert.ok(!files.includes(fixturePath), "5MB 초과 파일은 files 목록에 들어가면 안 된다");
    assert.ok(getOversizedSkips().map(normalize).includes(fixturePath), "getOversizedSkips() 에 기록돼야 한다");
  } finally {
    rmSync(fixturePath, { force: true });
  }
});

// 결함 2(4차 감사) 대응 — 오버사이즈 스킵이 있으면 시크릿이 안 걸려도 초록불(exit 0)로
// 끝나면 안 된다. 실제 스크립트를 서브프로세스로 돌려 종료 코드까지 확인한다(exit 1은
// 실제 시크릿 발견과 겹치므로, 구분되는 exit 2로 명확히 분리했는지 검증).
test("main() 은 시크릿 없이 오버사이즈 스킵만 있어도 초록불로 안 끝난다(exit 2)", () => {
  const fixturePath = "scripts/__oversized-secret-scan-fixture.tmp.js";
  writeFileSync(fixturePath, "x".repeat(5 * 1024 * 1024 + 10));
  try {
    const result = spawnSync(process.execPath, ["scripts/verify-no-secrets.mjs"], { encoding: "utf8" });
    assert.equal(result.status, 2, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /Secret scan skipped/);
  } finally {
    rmSync(fixturePath, { force: true });
  }
});

// 결함(2차 감사) 대응 — 자격증명 모양이 아닌 PII/운영데이터(진짜 telegram chat_id).
// outbox_all.json/tax_outbox2.json/tax_report2.txt 실측(승인 전문 21건, 진짜 chat_id
// -1004315119076 포함)이 8종 패턴 중 어디에도 안 걸렸던 것을 재현·검증한다.
test("JSON으로 직렬화된 telegramChatId 필드(운영 덤프)를 탐지한다", () => {
  const regex = regexFor("telegram-chat-id-dump");
  assert.match('{"idempotencyKey":"x","telegramChatId": "-1004334034373"}', regex);
});
test("snake_case telegram_chat_id 필드도 탐지한다(DB 컬럼명 그대로 직렬화된 경우)", () => {
  const regex = regexFor("telegram-chat-id-dump");
  assert.match('{"telegram_chat_id":"-1004315119076"}', regex);
});
test("이스케이프된 중첩 JSON(target 필드 안에 또 JSON 문자열)도 탐지한다 — tax_outbox2.json 재현", () => {
  const regex = regexFor("telegram-chat-id-dump");
  const nested = '"target":"{\\"kind\\":\\"telegram_bot\\",\\"telegramChatId\\":\\"-1004315119076\\"}"';
  assert.match(nested, regex);
});
test("TS 소스의 객체 리터럴 키(따옴표 없음)는 통과한다 — supabase-store.ts 오탐 방지", () => {
  const regex = regexFor("telegram-chat-id-dump");
  assert.doesNotMatch(
    'telegram_chat_id: toBigIntString(envelope.telegramChatId, "telegram_chat_id"),',
    regex
  );
});
test("테스트 fixture 의 짧은 placeholder chat_id(-1001 등)는 애초에 따옴표로 감싼 키가 아니라 통과한다", () => {
  const regex = regexFor("telegram-chat-id-dump");
  assert.doesNotMatch('telegram_chat_id: "-1001"', regex);
});
// 결함(6차 감사) 대응 — 값 숫자열(\d{4,})이 개행을 안 받아, 값 안쪽을 줄바꿈으로
// 쪼개면 매치가 끊겨 통과했다(6차 평가관 실증).
test("값의 숫자열을 줄바꿈으로 쪼개도 탐지한다 — 6차 감사 우회 재현", () => {
  const regex = regexFor("telegram-chat-id-dump");
  assert.match('{"telegramChatId": "-1\n004334034373"}', regex);
});
test("값 숫자열이 3자리 미만이면(줄바꿈으로 쪼개도) 통과한다", () => {
  const regex = regexFor("telegram-chat-id-dump");
  assert.doesNotMatch('{"telegramChatId": "-1\n2"}', regex);
});
// 결함(3차 감사) 대응 — telegram-chat-id-dump 는 `"key": "value"` 모양만 본다. 3차
// 평가관이 실측한 세 가지 우회(CSV·따옴표 없는 콜론·홑따옴표)를 재현·검증한다.
test("CSV 형태(키와 값이 다른 줄)의 진짜 chat_id 를 탐지한다", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.match("telegram_chat_id,text\n-1004315119076,승인 완료", regex);
});
test("따옴표 없는 콜론 형태를 탐지한다", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.match("telegramChatId: -1004315119076", regex);
});
test("홑따옴표 형태를 탐지한다", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.match("{'telegramChatId': '-1004315119076'}", regex);
});
test("키 이름이 전혀 없어도 값의 형태만으로 탐지한다 — '키 이름과 독립적으로' 요건", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.match("room owner chat is -1004315119076 now", regex);
});
test("이 저장소가 관행적으로 쓰는 placeholder(-1001234567890)는 통과한다 — dry-run-spec.mjs 오탐 방지", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.doesNotMatch('const CHAT_ID = "-1001234567890";', regex);
  assert.doesNotMatch("telegramChatId: -1001234567890", regex);
});
test("placeholder 와 자릿수가 같아도 다른 값이면 탐지한다 — 자릿수만으론 구분 못 하는 것을 값 비교로 메운다", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  // -1001234567890 과 똑같이 13자리이지만 실제 값은 다르다.
  assert.match("telegramChatId: -1009876543210", regex);
});
test("짧은 4자리 placeholder(-1001)는 자릿수 미달이라 애초에 통과한다", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.doesNotMatch("telegram_chat_id: -1001", regex);
});
// 결함(6차 감사) 대응 — "-100" 뒤 숫자열(\d{10,})이 개행을 안 받아, 그 안쪽을
// 줄바꿈으로 쪼개면 매치가 끊겨 통과했다(6차 평가관 실증).
test("숫자열을 줄바꿈으로 쪼개도 탐지한다 — 6차 감사 우회 재현", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.match("chat id -1004\n315119076 leaked", regex);
});
test("숫자열이 10자리 미만이면(줄바꿈으로 쪼개도) 통과한다", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.doesNotMatch("chat id -100\n12 short", regex);
});
test("placeholder(-1001234567890)를 줄바꿈으로 쪼개도 여전히 통과한다 — 분할이 오탐을 만들면 안 된다", () => {
  const regex = regexFor("telegram-chat-id-bare-value");
  assert.doesNotMatch('const CHAT_ID = "-1001234\n567890";', regex);
});

test("재발 시나리오 — 파일명이 달라도(outbox_all2.json) 내용이 같으면 잡힌다", () => {
  const hits = findSecretHits(
    "outbox_all2.json",
    '[{"payload":{"telegramChatId": "-1004334034373", "text":"승인 완료"}}]'
  );
  assert.ok(hits.some((hit) => hit.includes("telegram-chat-id-dump")));
});

test("findSecretHits 는 파일 경로와 패턴 이름을 함께 보고한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-no-secrets-test-"));
  const filePath = join(dir, "fixture.txt");
  writeFileSync(filePath, "leaked=sk-ant-api03-aBc123XyZ9876543210defghijklmnop", "utf8");
  try {
    const hits = findSecretHits(filePath, "leaked=sk-ant-api03-aBc123XyZ9876543210defghijklmnop");
    assert.equal(hits.length, 1);
    assert.match(hits[0], /anthropic-api-key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 결함(5차 감사) 대응 — 널바이트 1개로 스캔 자체를 무음으로 건너뛰던 우회 ─────────
//
// 예전 looksBinary() 는 "첫 512바이트에 널바이트가 있는가"만 봤다. 정상 텍스트
// 파일에 널바이트 하나만 심으면(뒤에 진짜 시크릿이 있어도) shouldScanContent() 가
// 조용히 건너뛰고 collectFilesToScan() 결과에도, getOversizedSkips() 에도 아무
// 흔적을 안 남긴 채 "Secret scan passed"(exit 0)로 끝났다. 이 블록은 그 구체적인
// 우회가 이제 막혔는지 실제 스크립트를 서브프로세스로 실행해 검증한다 — 되돌리면
// (looksBinary 를 "널바이트 존재 여부"로 되돌리면) 이 테스트는 exit 0 을 받아 실패한다.

test("controlByteRatio — 정상 텍스트(탭/개행/캐리지리턴 포함)는 비율 0", () => {
  const buffer = Buffer.from("line one\r\nline two\ttabbed\n한글도 포함", "utf8");
  assert.equal(controlByteRatio(buffer), 0);
});
test("controlByteRatio — 진짜 바이너리(대부분 제어바이트)는 비율이 높다", () => {
  const buffer = Buffer.alloc(600, 0x01);
  assert.ok(controlByteRatio(buffer) >= 0.99);
});
test("controlByteRatio — 널바이트 1개만 섞인 텍스트는 비율이 미미하다(임계값 30% 에 한참 못 미침)", () => {
  const buffer = Buffer.concat([Buffer.alloc(300, 0x61), Buffer.from([0]), Buffer.alloc(200, 0x61)]);
  assert.ok(controlByteRatio(buffer) < 0.3);
});

test("stripControlCharacters — 널바이트를 제거하고 앞뒤 텍스트를 이어붙인다", () => {
  assert.equal(stripControlCharacters("abc" + String.fromCharCode(0) + "def"), "abcdef");
});
test("stripControlCharacters — 제어문자가 없으면 그대로 돌려준다", () => {
  assert.equal(stripControlCharacters("no null bytes here"), "no null bytes here");
});
test("stripControlCharacters — 탭/개행/캐리지리턴은 지우지 않는다(정상 텍스트 보존)", () => {
  assert.equal(stripControlCharacters("a\tb\nc\rd"), "a\tb\nc\rd");
});
// 결함(6차 감사) 대응 — 널이 아닌 다른 제어문자(0x01 등)도 같은 방식으로 걷어내야
// 한다. 되돌리면(정규식을 \x00 하나로만 좁히면) 이 테스트가 실패한다.
test("stripControlCharacters — 널이 아닌 제어문자(0x01)도 제거한다 — 6차 감사 우회 재현", () => {
  const withControlChar = "abc" + String.fromCharCode(0x01) + "def";
  assert.equal(stripControlCharacters(withControlChar), "abcdef");
});

test("looksBinary — 널바이트 1개만 섞인 파일은 바이너리로 판정하지 않는다(예전엔 여기서 무음 스킵됐다)", () => {
  const fixturePath = "scripts/__nullbyte-lookbinary-fixture.tmp.js";
  const content = Buffer.concat([Buffer.alloc(300, 0x61), Buffer.from([0]), Buffer.alloc(200, 0x61)]);
  writeFileSync(fixturePath, content);
  try {
    assert.equal(looksBinary(fixturePath), false);
  } finally {
    rmSync(fixturePath, { force: true });
  }
});
test("looksBinary — 제어바이트 비율이 높은 진짜 바이너리는 여전히 바이너리로 판정한다", () => {
  const fixturePath = "scripts/__binary-lookbinary-fixture.tmp.dat";
  writeFileSync(fixturePath, Buffer.alloc(600, 0x01));
  try {
    assert.equal(looksBinary(fixturePath), true);
  } finally {
    rmSync(fixturePath, { force: true });
  }
});

test("재현 — 첫 512바이트 안 널바이트 1개 뒤에 숨긴 telegram bot token 을 실제로 잡는다(5차 감사 우회)", () => {
  const fixturePath = "scripts/__nullbyte-secret-scan-fixture.tmp.js";
  const content = Buffer.concat([
    Buffer.alloc(300, 0x61), // 정상 텍스트처럼 보이는 앞부분
    Buffer.from([0]), // 널바이트 1개 — 예전엔 이거 하나로 파일 전체가 무음 스킵됐다
    Buffer.alloc(150, 0x61),
    Buffer.from("\nBOT_TOKEN=123456789:AAFooBarBaz0123456789AbCdEfGhIj\n", "utf8")
  ]);
  writeFileSync(fixturePath, content);
  try {
    const result = spawnSync(process.execPath, ["scripts/verify-no-secrets.mjs"], { encoding: "utf8" });
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /Potential secret material found/);
    assert.match(result.stderr, /telegram-bot-token/);
  } finally {
    rmSync(fixturePath, { force: true });
  }
});

// 결함(6차 감사) 대응 — 널바이트가 아닌 다른 제어문자(0x01)로 토큰 한가운데를 쪼개도
// 예전엔(stripNullBytes 가 \x00 만 제거하던 시절) 무음 통과했다(6차 평가관 실증 — 되돌려서
// 직접 재현해 확인함). 이 테스트는 그 구체적인 우회가 이제 막혔는지 실제 스크립트를
// 서브프로세스로 실행해 검증한다 — 되돌리면(stripControlCharacters 의 정규식을 \x00 하나로만
// 좁히면) 이 테스트는 exit 0 을 받아 실패한다.
test("재현 — telegram bot token 한가운데를 널 아닌 제어문자(0x01)로 쪼개도 실제로 잡는다(6차 감사 우회)", () => {
  const fixturePath = "scripts/__ctrlchar-secret-scan-fixture.tmp.js";
  const content = Buffer.concat([
    Buffer.from("BOT_TOKEN=123456789:AAFooBarBaz0123", "utf8"),
    Buffer.from([0x01]), // 널바이트가 아닌 제어문자 1개 — 예전엔 이거 하나로 토큰 매치가 끊겨 통과했다
    Buffer.from("456789AbCdEfGhIj\n", "utf8")
  ]);
  writeFileSync(fixturePath, content);
  try {
    const result = spawnSync(process.execPath, ["scripts/verify-no-secrets.mjs"], { encoding: "utf8" });
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /Potential secret material found/);
    assert.match(result.stderr, /telegram-bot-token/);
  } finally {
    rmSync(fixturePath, { force: true });
  }
});

test("재현 — 진짜 바이너리(확장자 블랙리스트 밖)는 스킵되고 getSkippedFiles() 에 reason=binary 로 기록된다", () => {
  const fixturePath = "scripts/__binary-secret-scan-fixture.tmp.dat";
  writeFileSync(fixturePath, Buffer.alloc(600, 0x01));
  try {
    const normalize = (path) => path.replace(/\\/g, "/");
    const files = collectFilesToScan().map(normalize);
    assert.ok(!files.includes(fixturePath), "진짜 바이너리는 files 목록에 들어가면 안 된다");
    const skipped = getSkippedFiles();
    const entry = skipped.find((item) => normalize(item.path) === fixturePath);
    assert.ok(entry, "getSkippedFiles() 에 기록돼야 한다");
    assert.equal(entry.reason, "binary");
  } finally {
    rmSync(fixturePath, { force: true });
  }
});

test("main() 은 시크릿 없이 바이너리 스킵만 있어도 초록불로 안 끝난다(exit 2) — 오버사이즈 스킵과 동일 취급", () => {
  const fixturePath = "scripts/__binary-secret-scan-fixture.tmp.dat";
  writeFileSync(fixturePath, Buffer.alloc(600, 0x01));
  try {
    const result = spawnSync(process.execPath, ["scripts/verify-no-secrets.mjs"], { encoding: "utf8" });
    assert.equal(result.status, 2, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /Secret scan skipped/);
    assert.match(result.stderr, /binary/);
  } finally {
    rmSync(fixturePath, { force: true });
  }
});
