import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// git worktree 로 병렬 변형 실행을 격리한다.
//
// 왜 필요한가: "버전 3개 만들어줘" 같은 요청을 순차 실행하면 서로 같은 파일을 밟는다.
// 버즈는 각 변형을 별도 워크트리에서 동시에 돌려 원본을 안 건드린다. 우리도 그렇게
// 한다 — projectPath 밑에 .worktrees/<taskId>-v<n> 을 만들고, 그 경로를 실행 cwd 로 쓰면
// 나머지(정책 검사·아웃박스·아티팩트 수집)는 기존 코드가 그대로 처리한다. 워크트리
// 경로는 이미 allowedProjectRoots 안(원본의 하위 폴더)이라 정책 쪽 변경이 필요 없다.

export type WorktreeRunner = {
  run(args: { cwd: string; command: string; args: readonly string[] }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

export type WorktreeHandle = {
  path: string;
  branch: string;
};

export function worktreeDirName(taskId: string, variantIndex: number): string {
  // 브랜치/폴더명은 taskId 원문을 그대로 쓰지 않는다 — UUID 는 안전하지만, 호출자가
  // 언젠가 사람이 읽는 id 를 넘길 수도 있으니 git ref 에 쓸 수 없는 문자를 미리 막는다.
  const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "task";
  return `${safe}-v${variantIndex}`;
}

export function worktreePathFor(repoPath: string, taskId: string, variantIndex: number): string {
  return joinPath(repoPath, ".worktrees", worktreeDirName(taskId, variantIndex));
}

export async function createWorktree(input: {
  runner: WorktreeRunner;
  repoPath: string;
  taskId: string;
  variantIndex: number;
}): Promise<WorktreeHandle> {
  const dirName = worktreeDirName(input.taskId, input.variantIndex);
  const branch = `variant/${dirName}`;
  const path = joinPath(input.repoPath, ".worktrees", dirName);

  const result = await input.runner.run({
    cwd: input.repoPath,
    command: "git",
    args: ["worktree", "add", "-b", branch, path]
  });
  if (result.exitCode !== 0) {
    throw new Error(`worktree-create-failed:${dirName}:${result.stderr.trim().slice(0, 300)}`);
  }
  return { path, branch };
}

// createWorktree 는 이미 있으면 git 이 실패한다(멱등이 아니다). 승인 하이드레이션이
// 재시도되면(네트워크 재시도 등) 같은 taskId 로 두 번 불릴 수 있으므로, 디스크에 이미
// 있으면 새로 만들지 않고 그 경로를 그대로 돌려준다.
export async function ensureWorktree(input: {
  runner: WorktreeRunner;
  repoPath: string;
  taskId: string;
  variantIndex: number;
}): Promise<WorktreeHandle> {
  const path = worktreePathFor(input.repoPath, input.taskId, input.variantIndex);
  if (existsSync(path)) {
    return { path, branch: `variant/${worktreeDirName(input.taskId, input.variantIndex)}` };
  }
  return createWorktree(input);
}

export async function removeWorktree(input: {
  runner: WorktreeRunner;
  repoPath: string;
  handle: WorktreeHandle;
  force?: boolean;
}): Promise<void> {
  const args = ["worktree", "remove", input.handle.path];
  if (input.force) args.push("--force");
  const result = await input.runner.run({ cwd: input.repoPath, command: "git", args });
  if (result.exitCode !== 0) {
    throw new Error(`worktree-remove-failed:${input.handle.path}:${result.stderr.trim().slice(0, 300)}`);
  }
  // 워크트리를 지워도 브랜치는 남는다 — 변형 결과를 나중에 다시 보고 싶을 수 있어서
  // 브랜치까지 지우는 것은 별도 정리 절차(사람이 결정)로 남긴다.
}

export async function listWorktrees(input: { runner: WorktreeRunner; repoPath: string }): Promise<WorktreeHandle[]> {
  const result = await input.runner.run({ cwd: input.repoPath, command: "git", args: ["worktree", "list", "--porcelain"] });
  if (result.exitCode !== 0) {
    throw new Error(`worktree-list-failed:${result.stderr.trim().slice(0, 300)}`);
  }
  return parseWorktreeListPorcelain(result.stdout);
}

export function parseWorktreeListPorcelain(output: string): WorktreeHandle[] {
  const handles: WorktreeHandle[] = [];
  let currentPath: string | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch ") && currentPath) {
      const ref = line.slice("branch ".length);
      const branch = ref.replace(/^refs\/heads\//, "");
      if (branch.startsWith("variant/")) handles.push({ path: currentPath, branch });
      currentPath = undefined;
    }
  }
  return handles;
}

// 여러 변형을 동시에(worktree 하나씩) 만든다. 하나라도 실패하면 이미 만든 것들을
// 정리하고 던진다 — 반쪽짜리 워크트리 무더기를 남기지 않는다.
export async function createVariantWorktrees(input: {
  runner: WorktreeRunner;
  repoPath: string;
  taskId: string;
  variantCount: number;
}): Promise<WorktreeHandle[]> {
  const created: WorktreeHandle[] = [];
  try {
    for (let index = 1; index <= input.variantCount; index += 1) {
      const handle = await createWorktree({
        runner: input.runner,
        repoPath: input.repoPath,
        taskId: input.taskId,
        variantIndex: index
      });
      created.push(handle);
    }
    return created;
  } catch (error) {
    for (const handle of created) {
      try {
        await removeWorktree({ runner: input.runner, repoPath: input.repoPath, handle, force: true });
      } catch {
        // 정리 실패는 원래 오류를 가리지 않는다 — 아래에서 원래 오류를 던진다.
      }
    }
    throw error;
  }
}

// 실제 git 프로세스를 돌리는 런너. 순수 로직(createWorktree 등)은 이걸 안 쓰고
// WorktreeRunner 를 주입받으므로, 테스트는 가짜 런너로 git 없이도 돈다.
export function createNodeGitRunner(): WorktreeRunner {
  return {
    run({ cwd, command, args }) {
      return new Promise((resolve, reject) => {
        const child = spawn(command, [...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => { stdout += chunk; });
        child.stderr?.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
      });
    }
  };
}

function joinPath(...parts: string[]): string {
  const sepChar = parts[0]?.includes("\\") ? "\\" : "/";
  return parts
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, "") : part.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sepChar);
}
