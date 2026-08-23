import assert from "node:assert/strict";
import test from "node:test";
import { baseUrlOf, groupByBaseUrl, promoteApprovedArtifacts, type ArtifactPromotionStore } from "../src/artifact-promotion.js";

// 방장 완료 승인 전엔 프리뷰만 있다(artifact-publisher.test.ts). 이 파일은 완료 승인
// 이후 그 프리뷰를 프로덕션으로 승격하는 쪽 — Grok Bot 사례 반영, 2026-08-23.

test("vercel.app 이 아닌 주소는 승격 대상에서 뺀다", () => {
  assert.equal(baseUrlOf("https://huai-artifacts-xyz.vercel.app/game.html"), "https://huai-artifacts-xyz.vercel.app");
  assert.equal(baseUrlOf("file:///C:/work/game.html"), undefined);
  assert.equal(baseUrlOf("아무거나"), undefined);
});

test("같은 배포를 공유하는 파일들은 한 그룹으로 묶는다", () => {
  const groups = groupByBaseUrl([
    { artifactId: "a1", taskId: "t1", publicUrl: "https://huai-artifacts-xyz.vercel.app/game.html" },
    { artifactId: "a2", taskId: "t1", publicUrl: "https://huai-artifacts-xyz.vercel.app/index.html" },
    { artifactId: "a3", taskId: "t2", publicUrl: "https://huai-artifacts-abc.vercel.app/report.html" }
  ]);

  assert.equal(groups.size, 2);
  assert.equal(groups.get("https://huai-artifacts-xyz.vercel.app")?.length, 2);
  assert.equal(groups.get("https://huai-artifacts-abc.vercel.app")?.length, 1);
});

function fakeStore(artifacts: Array<{ artifactId: string; taskId: string; publicUrl: string }>): {
  store: ArtifactPromotionStore;
  markedIds: string[][];
} {
  const markedIds: string[][] = [];
  return {
    store: {
      async fetchPromotable() {
        return artifacts;
      },
      async markPromoted(ids) {
        markedIds.push([...ids]);
      }
    },
    markedIds
  };
}

test("승격 성공한 배포의 산출물만 최종으로 표시한다", async () => {
  const { store, markedIds } = fakeStore([
    { artifactId: "a1", taskId: "t1", publicUrl: "https://ok.vercel.app/game.html" },
    { artifactId: "a2", taskId: "t2", publicUrl: "https://fail.vercel.app/report.html" }
  ]);

  const promoted: string[] = [];
  const failures: Array<[string, string | undefined]> = [];
  const result = await promoteApprovedArtifacts({
    store,
    async promote(deploymentUrl) {
      promoted.push(deploymentUrl);
      if (deploymentUrl.includes("fail")) return { ok: false, failureReason: "vercel-promote-failed:1" };
      return { ok: true };
    },
    onFailure(baseUrl, reason) {
      failures.push([baseUrl, reason]);
    }
  });

  assert.deepEqual(promoted.sort(), ["https://fail.vercel.app", "https://ok.vercel.app"]);
  assert.equal(result.checked, 2);
  assert.equal(result.promoted, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(markedIds, [["a1"]]);
  assert.deepEqual(failures, [["https://fail.vercel.app", "vercel-promote-failed:1"]]);
});

test("승격할 게 없으면 아무것도 안 부른다", async () => {
  let promoteCalled = false;
  const result = await promoteApprovedArtifacts({
    store: { async fetchPromotable() { return []; }, async markPromoted() {} },
    async promote() { promoteCalled = true; return { ok: true }; }
  });

  assert.equal(promoteCalled, false);
  assert.deepEqual(result, { checked: 0, promoted: 0, failed: 0 });
});

test("한 배포에 파일이 여러 개여도 승격은 한 번만 부른다", async () => {
  const { store, markedIds } = fakeStore([
    { artifactId: "a1", taskId: "t1", publicUrl: "https://ok.vercel.app/index.html" },
    { artifactId: "a2", taskId: "t1", publicUrl: "https://ok.vercel.app/game.html" }
  ]);

  let calls = 0;
  const result = await promoteApprovedArtifacts({
    store,
    async promote() { calls += 1; return { ok: true }; }
  });

  assert.equal(calls, 1, "같은 baseUrl 을 두 번 승격하면 안 된다");
  assert.equal(result.promoted, 2);
  assert.deepEqual(markedIds[0]?.sort(), ["a1", "a2"]);
});
