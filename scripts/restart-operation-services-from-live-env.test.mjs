import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyServiceProcesses,
  mergePidSources
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
