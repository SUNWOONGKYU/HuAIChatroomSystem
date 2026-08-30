import assert from "node:assert/strict";
import test from "node:test";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertSafeVercelArgs,
  cleanupStagingDir,
  extractDeploymentUrl,
  isWebArtifact,
  promoteDeployment,
  publishWebArtifacts,
  runVercel,
  SAFE_VERCEL_ARG_PATTERN,
  vercelTimeoutMsFor
} from "../src/artifact-publisher.js";

// 방장 제기 — "게임을 만들어 줬으면 그걸 연결을 시켜줘야 되는데 연결을 안 시켜주지".
// 실행이 만든 파일은 이 PC 안에만 있어 폰에서는 열 수 없었다.

test("웹으로 열어야 뜻이 있는 것만 올린다", () => {
  assert.equal(isWebArtifact("supabase/miniapp-web/egg-crack-sound-game.html"), true);
  assert.equal(isWebArtifact("C:\\work\\report.HTML"), true);
  // 문서는 방에 파일로 전달하는 쪽이 맞다. 올려봐야 브라우저에서 열리지 않는다.
  assert.equal(isWebArtifact("사건보고서.hwpx"), false);
  assert.equal(isWebArtifact("packages/orchestrator/src/index.ts"), false);
});

test("배포 로그에서 주소만 뽑는다", () => {
  const stdout = [
    "Vercel CLI 48.4.0",
    "Inspect: https://vercel.com/finder-world/huai-artifacts/abc [2s]",
    "Production: https://huai-artifacts-xyz.vercel.app [2s]",
    "https://huai-artifacts-xyz.vercel.app"
  ].join("\n");

  assert.equal(extractDeploymentUrl(stdout), "https://huai-artifacts-xyz.vercel.app");
  assert.equal(extractDeploymentUrl("아무 주소도 없는 출력"), undefined);
});

test("올린 파일마다 열 수 있는 주소를 돌려준다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "huai-publish-test-"));
  const gamePath = path.join(dir, "egg-crack-sound-game.html");
  const notePath = path.join(dir, "note.md");
  await writeFile(gamePath, "<html></html>", "utf8");
  await writeFile(notePath, "# 메모", "utf8");

  const commands: Array<{ command: string; args: readonly string[] }> = [];
  const result = await publishWebArtifacts([{ path: gamePath }, { path: notePath }], {
    vercelProject: "huai-artifacts",
    async runCommand(command, args) {
      commands.push({ command, args });
      return { stdout: "Production: https://huai-artifacts-xyz.vercel.app [2s]", exitCode: 0 };
    }
  });

  assert.equal(commands.length, 1, "실행 하나에 배포도 한 번이어야 한다 — 파일마다 배포하면 주소가 흩어진다");
  // --prod 없음 — 완료 승인 전에는 프리뷰로만 올린다(방장 승인 전 프로덕션 노출 방지, 2026-08-23).
  assert.deepEqual(commands[0]?.args, ["deploy", "--yes", "--name", "huai-artifacts"]);
  assert.equal(result.publishedUrlByPath.get(gamePath), "https://huai-artifacts-xyz.vercel.app/egg-crack-sound-game.html");
  assert.equal(result.publishedUrlByPath.has(notePath), false, "문서는 올리지 않는다");
  assert.equal(result.failureReason, undefined);
});

test("배포가 실패해도 작업까지 실패시키지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "huai-publish-test-"));
  const gamePath = path.join(dir, "game.html");
  await writeFile(gamePath, "<html></html>", "utf8");

  const result = await publishWebArtifacts([{ path: gamePath }], {
    vercelProject: "huai-artifacts",
    async runCommand() {
      return { stdout: "Error: not authorized", exitCode: 1 };
    }
  });

  // 결과물은 이미 이 PC 에 만들어져 있다. 배포 실패로 그걸 없던 일로 만들면 안 된다.
  assert.equal(result.publishedUrlByPath.size, 0);
  assert.match(String(result.failureReason), /vercel-deploy-failed/);
});

test("프로젝트를 안 정하면 아무것도 올리지 않는다", async () => {
  let called = false;
  const result = await publishWebArtifacts([{ path: "C:\\work\\game.html" }], {
    async runCommand() {
      called = true;
      return { stdout: "", exitCode: 0 };
    }
  });

  assert.equal(called, false, "설정이 없으면 배포를 시도조차 하지 않는다");
  assert.equal(result.publishedUrlByPath.size, 0);
  assert.equal(result.failureReason, undefined);
});

test("프리뷰 배포를 프로덕션으로 승격한다", async () => {
  const commands: Array<{ command: string; args: readonly string[] }> = [];
  const result = await promoteDeployment("https://huai-artifacts-xyz.vercel.app", async (command, args) => {
    commands.push({ command, args });
    return { stdout: "Success! https://huai-artifacts-xyz.vercel.app promoted", exitCode: 0 };
  });

  assert.deepEqual(commands[0], { command: "vercel", args: ["promote", "https://huai-artifacts-xyz.vercel.app", "--yes"] });
  assert.equal(result.ok, true);
});

test("승격 실패는 사유를 남기고 끝난다", async () => {
  const result = await promoteDeployment("https://huai-artifacts-xyz.vercel.app", async () => ({
    stdout: "Error: deployment not found",
    exitCode: 1
  }));

  assert.equal(result.ok, false);
  assert.match(String(result.failureReason), /vercel-promote-failed/);
});

// 결함 회귀 — vercel deploy/promote 자식 프로세스에 타임아웃이 없어서, 멈추면(토큰 만료
// 인터랙티브 프롬프트, 네트워크 블랙홀) consumer.ts 의 DEFAULT_CONCURRENCY=1 과 겹쳐
// 게이트웨이 프로세스 전체가 영구 정지했다. 60초짜리 ping 으로 실제로 멈추는 자식
// 프로세스를 흉내내 타임아웃이 발동하고 강제 종료되는지 검증한다. process.execPath 를
// 직접 커맨드로 쓰지 않는 이유: shell:true 조합에서 "C:\Program Files\..." 처럼 경로에
// 공백이 있으면 cmd.exe 가 첫 단어만 커맨드로 오인해 즉시 실패하고(따로 재현 확인함),
// 화이트리스트 검증도 공백을 막는다 — 둘 다 이 테스트의 목적(느리게 끝나는 프로세스
// 흉내)과 무관하므로 공백 없는 ping 으로 우회한다.
test("멈춘 vercel 프로세스는 타임아웃으로 강제 종료된다 — 게이트웨이 영구 정지 방지", { timeout: 10_000 }, async (t) => {
  const envKey = "LOCAL_GATEWAY_ARTIFACT_DEPLOY_TIMEOUT_MS";
  const previous = process.env[envKey];
  process.env[envKey] = "200";
  t.after(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });

  const startedAt = Date.now();
  // 60초짜리 ping — shell:true 아래 cmd.exe → ping.exe 로 이어지는 트리를 만든다.
  // child.kill() 만으로는 맨 위 cmd.exe 만 끝나고 ping.exe 는 고아로 남아 계속
  // 돈다는 것을 별도로 재현 확인했다 — 그래서 taskkill /T 로 트리를 내리는지까지
  // 이 테스트가 시간(60초 vs 수백 ms)으로 검증한다.
  const result = await runVercel("ping", ["-n", "60", "127.0.0.1"], process.cwd());
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.exitCode, 124, "타임아웃은 자연 종료코드와 겹치지 않는 값(timeout(1) 관례)이어야 한다");
  assert.match(result.stdout, /artifact-publish-timeout/);
  // ping 은 60초(60000ms)를 채워야 자연 종료된다. 훨씬 못 미쳐 끝났다면 트리가 실제로
  // 강제 종료된 것이고, 60초에 가깝게 걸렸다면 자식(ping.exe)이 고아로 남아 돌다가
  // 스스로 끝난 것 — 강제 종료가 껍데기(cmd.exe)만 죽였다는 뜻이다.
  assert.ok(elapsedMs < 10_000, `타임아웃이 프로세스 트리 전체에 실제로 발동하지 않았을 수 있다: ${elapsedMs}ms 경과`);
});

test("promote 는 별도 환경변수로 타임아웃을 조절한다", () => {
  const deployKey = "LOCAL_GATEWAY_ARTIFACT_DEPLOY_TIMEOUT_MS";
  const promoteKey = "LOCAL_GATEWAY_ARTIFACT_PROMOTE_TIMEOUT_MS";
  const previousDeploy = process.env[deployKey];
  const previousPromote = process.env[promoteKey];
  try {
    delete process.env[deployKey];
    delete process.env[promoteKey];
    assert.equal(vercelTimeoutMsFor(["deploy", "--yes"]), 180_000, "기본 배포 타임아웃");
    assert.equal(vercelTimeoutMsFor(["promote", "https://x.vercel.app", "--yes"]), 90_000, "기본 승격 타임아웃");

    process.env[deployKey] = "1000";
    process.env[promoteKey] = "2000";
    assert.equal(vercelTimeoutMsFor(["deploy", "--yes"]), 1000);
    assert.equal(vercelTimeoutMsFor(["promote", "https://x.vercel.app", "--yes"]), 2000);
  } finally {
    if (previousDeploy === undefined) delete process.env[deployKey]; else process.env[deployKey] = previousDeploy;
    if (previousPromote === undefined) delete process.env[promoteKey]; else process.env[promoteKey] = previousPromote;
  }
});

// 결함 회귀 — shell:true + .cmd 조합은 인자에 섞인 cmd.exe 메타문자(& | < > ^ % 등)가
// 그대로 해석되는 인젝션 안티패턴이다. 완전한 이스케이프 대신 화이트리스트로 그런
// 문자가 섞인 인자를 아예 거부하는지 검증한다 — 실행 자체가 안 되므로 인젝션 표면이
// 없어진다.
test("cmd.exe 메타문자가 섞인 인자는 실행하지 않고 거부한다", async () => {
  const result = await runVercel("vercel", ["deploy", "--name", "proj & calc.exe"], process.cwd());

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /artifact-publish-unsafe-argument/);
});

test("정상 인자(프로젝트명·배포 URL)는 화이트리스트를 그대로 통과한다", () => {
  // 위 거부 테스트가 오탐(정상 값까지 막음)이 아님을 실제 사용 값으로 확인한다.
  // 실행까지 가지 않고 검증 로직만 확인하려고 존재하지 않는 커맨드를 써서 즉시
  // error 이벤트로 끝나게 한다(spawn ENOENT) — 화이트리스트 통과 여부만 구분하면 된다.
  return runVercel("not-a-real-vercel-command", ["deploy", "--yes", "--name", "huai-artifacts"], process.cwd()).then((result) => {
    assert.doesNotMatch(result.stdout, /artifact-publish-unsafe-argument/, "정상 프로젝트명을 화이트리스트가 잘못 막았다");
  });
});

// 위 두 테스트는 mock 없는 runVercel 호출(spawn 레벨)로만 화이트리스트를 간접 커버했다
// (품질 인프라 감사 지적) — 여기서는 SAFE_VERCEL_ARG_PATTERN/assertSafeVercelArgs 자체의
// 경계를 하나씩 직접 확인한다.
test("cmd.exe 가 특별히 해석하는 문자는 하나씩 전부 거부된다", () => {
  // 상단 주석이 나열한 메타문자 그대로: & | < > ^ % ! " ' 공백.
  const metaCharacters = ["&", "|", "<", ">", "^", "%", "!", '"', "'", " "];
  for (const ch of metaCharacters) {
    assert.equal(SAFE_VERCEL_ARG_PATTERN.test(`proj${ch}name`), false, `'${ch}' 가 섞인 인자를 막지 못했다`);
    assert.throws(
      () => assertSafeVercelArgs("vercel", [`proj${ch}name`]),
      /unsafe-shell-argument/,
      `assertSafeVercelArgs 가 '${ch}' 를 통과시켰다`
    );
  }
});

test("실제 쓰이는 정상 인자는 전부 통과한다 — 서브커맨드·고정 플래그·프로젝트명·배포 URL", () => {
  const realWorldArgs = [
    "vercel", // command 자체도 검사 대상이다
    "deploy",
    "promote",
    "--yes",
    "--name",
    "huai-artifacts",
    "huai-board-project", // 실제 프로젝트명(하이픈 포함)
    "https://huai-artifacts-xyz.vercel.app" // extractDeploymentUrl 이 뽑아내는 배포 URL
  ];
  for (const value of realWorldArgs) {
    assert.equal(SAFE_VERCEL_ARG_PATTERN.test(value), true, `정상 인자 '${value}' 를 화이트리스트가 거부했다`);
  }
  assert.doesNotThrow(() => assertSafeVercelArgs("vercel", realWorldArgs.slice(1)));
});

// 결함(2차 감사) 대응 — 타임아웃 강제종료 뒤 잠깐(최대 FORCE_KILL_GRACE_MS + taskkill
// 소요) 살아있는 vercel 프로세스가 stagingDir 안 파일을 잠그고 있으면 rm 이 즉시 실패한다.
// Windows 파일 잠금을 실제로 재현해(mock 없이) 재시도·최종 실패 로그를 검증한다.
test("stagingDir 삭제가 처음엔 파일 잠금으로 실패해도 재시도로 결국 정리된다", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "huai-cleanup-retry-"));
  const lockedFile = path.join(dir, "locked.txt");
  writeFileSync(lockedFile, "x");
  const fd = openSync(lockedFile, "r+"); // Windows 에서 열린 파일은 삭제/이름변경이 막힌다.

  // 재시도 대기(500ms) 중에 잠금을 풀어준다 — "타임아웃 강제종료가 뒤늦게 끝나 파일 잠금이
  // 잠깐 후 풀리는" 실제 상황을 흉내낸다.
  setTimeout(() => closeSync(fd), 300);

  await cleanupStagingDir(dir);

  assert.equal(existsSync(dir), false, "재시도 끝에 stagingDir 이 정리돼야 한다");
});

test("stagingDir 삭제가 끝까지 실패하면 조용히 삼키지 않고 구조화 로그를 남긴다", { timeout: 10_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "huai-cleanup-fail-"));
  const lockedFile = path.join(dir, "locked.txt");
  writeFileSync(lockedFile, "x");
  const fd = openSync(lockedFile, "r+");

  const originalConsoleError = console.error;
  const logged: string[] = [];
  console.error = (message?: unknown) => {
    logged.push(String(message));
  };

  try {
    await cleanupStagingDir(dir); // 잠금을 끝까지 안 풀어서 3번 다 실패하게 한다.
  } finally {
    console.error = originalConsoleError;
    closeSync(fd);
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined));
  }

  assert.equal(logged.length, 1, "최종 실패는 정확히 한 번만 로그로 남아야 한다(조용한 스킵 금지)");
  const parsed = JSON.parse(logged[0]);
  assert.equal(parsed.type, "artifact-publish-staging-cleanup-failed");
  assert.equal(parsed.stagingDir, dir);
  assert.equal(parsed.attempts, 3);
});
