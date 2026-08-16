import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyServiceProcesses,
  mergePidSources,
  parseEnvFile,
  parseGatewayInstances
} from "./restart-operation-services-from-live-env.mjs";

// 라이브 사고 재현: PID 파일에는 41020/32880 이 적혀 있었는데 실제로 도는 건
// 16176/6076 이었다. 파일만 믿으면 죽은 PID 를 죽이려다 실패하고 살아 있는 봇 위에
// 새 봇을 하나 더 띄운다 — bot-service 가 둘이면 같은 Telegram 업데이트를 두 번 처리한다.
test("PID 파일이 낡았어도 실제로 도는 프로세스를 놓치지 않는다", () => {
  const pids = mergePidSources(41020, [16176]);
  assert.equal(pids.includes(16176), true, "실제 프로세스가 정지 대상에서 빠졌다");
});

test("파일 값과 조회 값이 같으면 한 번만 다룬다", () => {
  assert.deepEqual(mergePidSources(16176, [16176]), [16176]);
});

test("조회가 빈손이어도 파일 값은 살린다 — 이전보다 나빠지지 않는다", () => {
  assert.deepEqual(mergePidSources(16176, []), [16176]);
  assert.deepEqual(mergePidSources(16176, undefined), [16176]);
});

test("파일이 없거나 깨졌어도 조회 값으로 정지한다", () => {
  assert.deepEqual(mergePidSources(undefined, [16176]), [16176]);
  assert.deepEqual(mergePidSources(Number.NaN, [16176]), [16176]);
  assert.deepEqual(mergePidSources(0, [16176]), [16176]);
});

test("같은 서비스가 이미 중복 실행 중이면 전부 정지 대상에 넣는다", () => {
  // 이 상황이 바로 예전 동작이 만들어내던 결과다. 하나만 죽이면 중복이 남는다.
  const pids = mergePidSources(41020, [16176, 20304]);
  assert.equal(pids.includes(16176), true);
  assert.equal(pids.includes(20304), true);
});

test("명령줄로 두 서비스를 가른다", () => {
  const result = classifyServiceProcesses([
    { ProcessId: 100, CommandLine: '"node.exe" --env-file=.env dist\\apps\\bot-service\\src\\cli.js' },
    { ProcessId: 200, CommandLine: '"node.exe" --env-file=.env dist\\apps\\local-gateway\\src\\cli.js' }
  ]);

  assert.deepEqual(result.botService, [100]);
  assert.deepEqual(result.localGateway, [200]);
});

test("무관한 node 프로세스는 건드리지 않는다", () => {
  // 이 저장소 밖의 node 를 정지 대상에 넣으면 사용자의 다른 작업을 죽인다.
  const result = classifyServiceProcesses([
    { ProcessId: 300, CommandLine: '"node.exe" some-other-project\\server.js' },
    { ProcessId: 400, CommandLine: '"node.exe" scripts/build-if-needed.mjs' },
    { ProcessId: 500, CommandLine: "" },
    { ProcessId: 600 }
  ]);

  assert.deepEqual(result.botService, []);
  assert.deepEqual(result.localGateway, []);
});

test("경로 구분자가 슬래시든 역슬래시든 같게 읽는다", () => {
  const back = classifyServiceProcesses([{ ProcessId: 1, CommandLine: "node dist\\apps\\bot-service\\src\\cli.js" }]);
  const forward = classifyServiceProcesses([{ ProcessId: 1, CommandLine: "node dist/apps/bot-service/src/cli.js" }]);

  assert.deepEqual(back.botService, forward.botService);
});

test("PID 가 숫자가 아니면 정지 대상으로 삼지 않는다", () => {
  const result = classifyServiceProcesses([
    { ProcessId: "not-a-pid", CommandLine: "node dist/apps/bot-service/src/cli.js" },
    { ProcessId: -1, CommandLine: "node dist/apps/local-gateway/src/cli.js" }
  ]);

  assert.deepEqual(result.botService, []);
  assert.deepEqual(result.localGateway, []);
});

// 라이브 결함 회귀 — 설정 파일을 고쳐도 옛 값이 대물림되던 문제.
//
// 이 스크립트는 살아 있는 프로세스에서 환경변수를 물려받는다(시크릿을 파일에서 다시
// 읽지 않으려는 것). 그런데 순서가 반대라 죽은 프로세스의 값이 파일을 덮었다.
// LOCAL_GATEWAY_MAX_RUNTIME_MS 를 5분에서 15분으로 고치고 재기동했는데도 실행이
// 여전히 5분에 끊겼고, 프로세스 환경을 직접 열어보고서야 원인을 알았다.
test("설정 파일에서 키와 값을 읽는다", () => {
  const parsed = parseEnvFile([
    "# 주석",
    "",
    "LOCAL_GATEWAY_MAX_RUNTIME_MS=900000",
    "BOT_SERVICE_RECEIVE_MODE=polling"
  ].join("\n"));

  assert.equal(parsed.LOCAL_GATEWAY_MAX_RUNTIME_MS, "900000");
  assert.equal(parsed.BOT_SERVICE_RECEIVE_MODE, "polling");
  assert.equal(Object.keys(parsed).length, 2, "주석과 빈 줄이 값으로 들어갔다");
});

test("값에 = 가 들어 있어도 첫 = 만 구분자로 본다", () => {
  // 봇 토큰과 키에 = 가 들어간다. 뒤를 잘라먹으면 인증이 통째로 깨진다.
  const parsed = parseEnvFile("SUPABASE_SERVICE_ROLE_KEY=eyJhbGci.payload==");

  assert.equal(parsed.SUPABASE_SERVICE_ROLE_KEY, "eyJhbGci.payload==");
});

test("따옴표로 감싼 값은 벗겨서 읽는다", () => {
  const parsed = parseEnvFile(['A="큰따옴표"', "B='작은따옴표'"].join("\n"));

  assert.equal(parsed.A, "큰따옴표");
  assert.equal(parsed.B, "작은따옴표");
});

test("= 가 없는 줄은 버린다", () => {
  const parsed = parseEnvFile(["쓰레기줄", "=값만있음", "OK=1"].join("\n"));

  assert.deepEqual(Object.keys(parsed), ["OK"]);
});

// 방마다 게이트웨이 하나. 잘못 적힌 설정으로 프로세스를 띄우면 그 방은 조용히 안 돈다 —
// 큐에 일만 쌓이고 방에는 아무 말도 안 나간다. 그래서 뜨기 전에 막는다.
test("방별 게이트웨이 설정을 라벨·id·포트·폴더로 가른다", () => {
  const parsed = parseGatewayInstances(
    "개인회생|16e2c574-3acb-45c0-a86b-0efd1f492b2d|8798|C:\Users\home\Desktop\pc;DCF|f0853c72-bd1f-4176-aff8-9d4dc1afe034|8800|G:\내 드라이브\DCF법_회계사용"
  );

  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    label: "개인회생",
    gatewayId: "16e2c574-3acb-45c0-a86b-0efd1f492b2d",
    healthPort: 8798,
    root: "C:\Users\home\Desktop\pc"
  });
  assert.equal(parsed[1].root, "G:\내 드라이브\DCF법_회계사용", "공백이 든 경로가 잘리면 안 된다");
});

test("설정이 비어 있으면 방별 게이트웨이는 안 띄운다", () => {
  assert.deepEqual(parseGatewayInstances(undefined), []);
  assert.deepEqual(parseGatewayInstances(""), []);
  assert.deepEqual(parseGatewayInstances("   ;  "), []);
});

test("빠진 항목이 있으면 띄우지 않고 멈춘다", () => {
  // 포트 없이 띄우면 기본 포트로 두 프로세스가 붙어 한쪽이 죽는다.
  assert.throws(() => parseGatewayInstances("개인회생|16e2c574||C:\Users\home\Desktop\pc"), /invalid-env/);
  assert.throws(() => parseGatewayInstances("개인회생|16e2c574|8798|"), /invalid-env/);
  assert.throws(() => parseGatewayInstances("|16e2c574|8798|C:\work"), /invalid-env/);
});
