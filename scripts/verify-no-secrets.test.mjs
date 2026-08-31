import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { patterns, findSecretHits, isScannable, collectFilesToScan, getOversizedSkips } from "./verify-no-secrets.mjs";

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
test("테스트/브라우저 테스트 파일은 여전히 제외된다", () => {
  assert.equal(isScannable("apps/local-gateway/test/artifact-publisher.test.ts"), false);
  assert.equal(isScannable("supabase/miniapp-web/egg-game.browser-test.mjs"), false);
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
