import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type ArtifactManifest, type ArtifactPolicy, type ExecutionRequest } from "../../../packages/contracts/src/index.js";

export type ArtifactCollector = {
  collect(input: { request: ExecutionRequest; startedAtMs: number }): Promise<ArtifactManifest[]>;
};

export type ArtifactFileEntry = {
  relativePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  content: Uint8Array;
};

export type ArtifactFileSystem = {
  listChangedFiles(root: string, sinceMs: number): Promise<ArtifactFileEntry[]>;
};

export const defaultArtifactPolicy: ArtifactPolicy = {
  collectGlobs: ["**/*"],
  maxArtifactBytes: 1_048_576
};

export const MAX_COLLECTED_ARTIFACTS = 50;

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "__pycache__"
]);

// 저장소가 무시하는 파일은 작업 산출물이 아니다.
//
// EXCLUDED_DIRECTORIES 는 이름을 하나씩 적어두는 방식이라 늘 뒤처진다. 라이브에서
// `.codex-browser-profile-egg/` 안의 브라우저 캐시가 산출물로 수집됐고, 그 때문에
// "package.json version 값 조사" 같은 순수 조회 작업이 파일을 바꾼 것으로 판정되어
// 자동 감사(AI 실행 한 번)까지 붙었다. 목록에 그 이름을 추가하면 다음 부산물에서 또 같은
// 일이 난다.
//
// 무엇이 부산물인지는 저장소가 이미 .gitignore 에 적어두고 있다. 그 답을 쓴다.
// git 이 없거나 저장소가 아니면(isIgnored 가 undefined) 예전대로 전부 수집한다 —
// 수집이 과해지는 것이지 없어지는 것이 아니라, 못 쓰게 만드는 것보다 낫다.
export function createArtifactCollector(
  fileSystem: ArtifactFileSystem = createNodeArtifactFileSystem(),
  ignoreLookup: ArtifactIgnoreLookup = createGitArtifactIgnoreLookup()
): ArtifactCollector {
  return {
    async collect(input) {
      const policy = normalizeArtifactPolicy(input.request.artifactPolicy);
      const entries = await fileSystem.listChangedFiles(input.request.projectPath, input.startedAtMs);
      const candidates = entries
        .filter((entry) => entry.sizeBytes <= policy.maxArtifactBytes)
        .filter((entry) => matchesAnyGlob(entry.relativePath, policy.collectGlobs));

      const ignored = await ignoreLookup.ignoredPaths(
        input.request.projectPath,
        candidates.map((entry) => entry.relativePath)
      );
      const matched = candidates
        .filter((entry) => !ignored.has(entry.relativePath))
        .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)
        .slice(0, MAX_COLLECTED_ARTIFACTS);

      return matched.map((entry) => ({
        path: entry.relativePath,
        sizeBytes: entry.sizeBytes,
        checksum: sha256Hex(entry.content),
        version: input.request.attemptId,
        uri: toArtifactUri(input.request.projectPath, entry.relativePath)
      }));
    }
  };
}

export function normalizeArtifactPolicy(policy: ArtifactPolicy | undefined): ArtifactPolicy {
  const globs = policy?.collectGlobs?.filter((glob) => typeof glob === "string" && glob.length > 0) ?? [];
  const maxArtifactBytes = typeof policy?.maxArtifactBytes === "number" && policy.maxArtifactBytes > 0
    ? policy.maxArtifactBytes
    : defaultArtifactPolicy.maxArtifactBytes;
  return {
    collectGlobs: globs.length > 0 ? globs : [...defaultArtifactPolicy.collectGlobs],
    maxArtifactBytes
  };
}

export function matchesAnyGlob(relativePath: string, globs: readonly string[]): boolean {
  const normalized = relativePath.split(sep).join("/");
  return globs.some((glob) => globToRegExp(glob).test(normalized));
}

export function globToRegExp(glob: string): RegExp {
  const normalized = glob.split(sep).join("/");
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        const skipsSlash = normalized[index + 2] === "/";
        pattern += skipsSlash ? "(?:.*/)?" : ".*";
        index += skipsSlash ? 2 : 1;
        continue;
      }
      pattern += "[^/]*";
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
}

export function toArtifactUri(projectPath: string, relativePath: string): string {
  return pathToFileURL(join(resolve(projectPath), relativePath)).href;
}

export function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export type ArtifactIgnoreLookup = {
  ignoredPaths(root: string, relativePaths: readonly string[]): Promise<Set<string>>;
};

// `git check-ignore --stdin` 한 번으로 전부 판정한다. 파일마다 부르면 수집이 느려진다.
export function createGitArtifactIgnoreLookup(): ArtifactIgnoreLookup {
  return {
    async ignoredPaths(root, relativePaths) {
      if (relativePaths.length === 0) return new Set();
      try {
        const output = await runGitCheckIgnore(root, relativePaths);
        return new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
      } catch {
        // git 이 없거나 저장소가 아니면 아무것도 무시하지 않는다(예전 동작).
        return new Set();
      }
    }
  };
}

function runGitCheckIgnore(root: string, relativePaths: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["check-ignore", "--stdin"], { cwd: root, windowsHide: true });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      // 0 = 무시되는 경로가 있음, 1 = 하나도 없음. 둘 다 정상이다.
      if (code === 0 || code === 1) resolvePromise(stdout);
      else rejectPromise(new Error(`git-check-ignore-failed:${code}`));
    });
    child.stdin.end(relativePaths.join("\n"));
  });
}

export function createNodeArtifactFileSystem(): ArtifactFileSystem {
  return {
    async listChangedFiles(root, sinceMs) {
      const absoluteRoot = resolve(root);
      const collected: ArtifactFileEntry[] = [];
      await walkDirectory(absoluteRoot, absoluteRoot, sinceMs, collected);
      return collected;
    }
  };
}

async function walkDirectory(
  absoluteRoot: string,
  directory: string,
  sinceMs: number,
  collected: ArtifactFileEntry[]
): Promise<void> {
  if (collected.length >= MAX_COLLECTED_ARTIFACTS * 4) return;

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      await walkDirectory(absoluteRoot, join(directory, entry.name), sinceMs, collected);
      continue;
    }
    if (!entry.isFile()) continue;

    const absolutePath = join(directory, entry.name);
    try {
      const stats = await stat(absolutePath);
      if (stats.mtimeMs < sinceMs) continue;
      if (stats.size > defaultArtifactPolicy.maxArtifactBytes) continue;
      collected.push({
        relativePath: relative(absoluteRoot, absolutePath).split(sep).join("/"),
        sizeBytes: stats.size,
        modifiedAtMs: stats.mtimeMs,
        content: await readFile(absolutePath)
      });
    } catch {
      continue;
    }
  }
}
