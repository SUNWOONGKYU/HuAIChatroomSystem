import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractDeploymentUrl, isWebArtifact, publishWebArtifacts } from "../src/artifact-publisher.js";

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
  assert.deepEqual(commands[0]?.args, ["deploy", "--prod", "--yes", "--name", "huai-artifacts"]);
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
