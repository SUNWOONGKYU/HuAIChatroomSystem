import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createNodeGitRunner,
  createVariantWorktrees,
  createWorktree,
  parseWorktreeListPorcelain,
  removeWorktree,
  type WorktreeRunner
} from "../src/worktree.js";

// 버즈처럼 "버전 N개 만들어줘"를 서로 안 부딪히게 병렬로 돌리려면 각 변형이 자기만의
// 작업 디렉터리(워크트리)를 가져야 한다. 순수 로직은 가짜 git 러너로 검증하고, 진짜 git
// 동작(아래 REPO_ROOT 대상)은 별도 통합 테스트로 확인한다.

test("createWorktree 는 add -b <branch> <path> 로 git 을 호출한다", async () => {
  const calls: Array<{ cwd: string; command: string; args: readonly string[] }> = [];
  const runner: WorktreeRunner = {
    async run(call) {
      calls.push(call);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };

  const handle = await createWorktree({ runner, repoPath: "C:\\repo", taskId: "task-abc", variantIndex: 2 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "git");
  assert.equal(calls[0].cwd, "C:\\repo");
  assert.deepEqual(calls[0].args.slice(0, 2), ["worktree", "add"]);
  assert.equal(handle.branch, "variant/task-abc-v2");
  assert.match(handle.path, /task-abc-v2$/);
});

test("createWorktree 실패하면 stderr 를 담아 던진다", async () => {
  const runner: WorktreeRunner = { async run() { return { exitCode: 1, stdout: "", stderr: "fatal: already exists" }; } };
  await assert.rejects(
    createWorktree({ runner, repoPath: "C:\\repo", taskId: "t1", variantIndex: 1 }),
    /worktree-create-failed.*already exists/
  );
});

test("taskId 에 git ref 로 못 쓰는 문자가 있어도 안전한 이름으로 바꾼다", async () => {
  const runner: WorktreeRunner = { async run() { return { exitCode: 0, stdout: "", stderr: "" }; } };
  const handle = await createWorktree({ runner, repoPath: "C:\\repo", taskId: "task:with spaces/slashes", variantIndex: 1 });
  assert.equal(handle.branch, "variant/taskwithspacesslashes-v1");
  const taskIdDerivedPart = handle.branch.slice("variant/".length);
  assert.doesNotMatch(taskIdDerivedPart, /[ :\/]/, "taskId 원문의 공백·콜론·슬래시가 새어 들어가면 안 된다");
});

test("removeWorktree 는 remove <path> 를 호출하고, force 옵션이면 --force 를 붙인다", async () => {
  const calls: Array<readonly string[]> = [];
  const runner: WorktreeRunner = {
    async run({ args }) {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };
  await removeWorktree({ runner, repoPath: "C:\\repo", handle: { path: "C:\\repo\\.worktrees\\t1-v1", branch: "variant/t1-v1" } });
  await removeWorktree({ runner, repoPath: "C:\\repo", handle: { path: "C:\\repo\\.worktrees\\t1-v2", branch: "variant/t1-v2" }, force: true });

  assert.deepEqual(calls[0], ["worktree", "remove", "C:\\repo\\.worktrees\\t1-v1"]);
  assert.deepEqual(calls[1], ["worktree", "remove", "C:\\repo\\.worktrees\\t1-v2", "--force"]);
});

test("createVariantWorktrees 는 요청한 개수만큼 만든다", async () => {
  const runner: WorktreeRunner = { async run() { return { exitCode: 0, stdout: "", stderr: "" }; } };
  const handles = await createVariantWorktrees({ runner, repoPath: "C:\\repo", taskId: "t1", variantCount: 3 });
  assert.equal(handles.length, 3);
  assert.deepEqual(handles.map((h) => h.branch), ["variant/t1-v1", "variant/t1-v2", "variant/t1-v3"]);
});

test("createVariantWorktrees 는 중간에 실패하면 이미 만든 것들을 정리하고 원래 오류를 던진다", async () => {
  let createCount = 0;
  const removedPaths: string[] = [];
  const runner: WorktreeRunner = {
    async run({ args }) {
      if (args[0] === "worktree" && args[1] === "add") {
        createCount += 1;
        if (createCount === 3) return { exitCode: 1, stdout: "", stderr: "fatal: disk full" };
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        removedPaths.push(args[2]);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
  };

  await assert.rejects(
    createVariantWorktrees({ runner, repoPath: "C:\\repo", taskId: "t1", variantCount: 3 }),
    /disk full/
  );
  assert.equal(removedPaths.length, 2, "실패 전에 만든 2개는 정리돼야 한다");
});

test("parseWorktreeListPorcelain 은 variant/ 브랜치만 골라낸다", () => {
  const output = [
    "worktree C:/repo",
    "HEAD abc123",
    "branch refs/heads/main",
    "",
    "worktree C:/repo/.worktrees/t1-v1",
    "HEAD def456",
    "branch refs/heads/variant/t1-v1",
    ""
  ].join("\n");

  const handles = parseWorktreeListPorcelain(output);
  assert.deepEqual(handles, [{ path: "C:/repo/.worktrees/t1-v1", branch: "variant/t1-v1" }]);
});

// 실제 git 을 이 저장소 위에서 돌려본다 — 가짜 러너 테스트는 우리가 만든 호출 규약이
// 맞는지만 보증하고, git 이 그 인자를 실제로 어떻게 받아들이는지는 보증하지 않는다.
test("실제 git 으로 워크트리를 만들고 지운다 (통합)", async () => {
  const repoRoot = findRepoRoot(import.meta.dirname);
  if (!repoRoot) {
    console.log("skip: .git 없음 (git worktree 통합 테스트 건너뜀)");
    return;
  }

  const runner = createNodeGitRunner();
  const taskId = `worktree-test-${Date.now()}`;
  const handle = await createWorktree({ runner, repoPath: repoRoot, taskId, variantIndex: 1 });

  try {
    assert.ok(existsSync(handle.path), "워크트리 디렉터리가 실제로 생겨야 한다");
    assert.ok(existsSync(path.join(handle.path, "package.json")), "원본 저장소 파일이 워크트리에도 보여야 한다");

    const list = await runner.run({ cwd: repoRoot, command: "git", args: ["worktree", "list", "--porcelain"] });
    const handles = parseWorktreeListPorcelain(list.stdout);
    assert.ok(handles.some((h) => h.branch === handle.branch), "git worktree list 에도 실제로 잡혀야 한다");
  } finally {
    await removeWorktree({ runner, repoPath: repoRoot, handle, force: true });
    assert.ok(!existsSync(handle.path), "정리 후엔 디렉터리가 사라져야 한다");
    // 브랜치 자체는 removeWorktree 의 설계대로 남는다 — 테스트 잔여물이니 여기서 지운다.
    await runner.run({ cwd: repoRoot, command: "git", args: ["branch", "-D", handle.branch] });
  }
});

// dist/apps/local-gateway/test 에서 실행되든 src 에서 실행되든, .git 이 있는 조상
// 디렉터리를 찾아 올라간다 — 고정된 ".." 개수는 dist 빌드 경로가 하나 더 깊어서 깨졌었다.
function findRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
