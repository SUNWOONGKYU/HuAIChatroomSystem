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
// .gitignore 를 못 읽으면 예전대로 전부 수집한다 — 수집이 과해지는 것이지 멎는 것이
// 아니라, 못 쓰게 만드는 것보다 낫다.
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

// .gitignore 한 줄을 경로 판정 규칙으로 바꾼다.
//
// 처음에는 `git check-ignore` 를 불렀다. 그런데 이 환경에서 자식 프로세스로 git 을
// 띄우면 절대경로로도 ENOENT 로 죽고, 그 실패를 catch 가 삼켜 필터가 통째로 무력화됐다 —
// 겉으로는 아무 일도 없어 보이는데 세션 기록 파일이 산출물로 잡히고, 조회 작업에
// 자동 감사(AI 실행 한 번)가 붙었다. 외부 프로세스에 기대지 않는 편이 옳다.
//
// 완전한 gitignore 문법을 구현하지 않는다. 이 저장소가 쓰는 형태만 다룬다:
//   name/        디렉터리와 그 아래 전부
//   *.log        확장자 글로브
//   .env*.local  이름 글로브
//   /name        최상위 고정
// 부정(!) 규칙은 쓰지 않으므로 다루지 않는다. 새 형태가 필요해지면 여기서 늘린다.
export function gitignoreMatcher(patterns: readonly string[]): (relativePath: string) => boolean {
  const rules = patterns
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));

  return (relativePath) => {
    const path = relativePath.split(sep).join("/").replace(/^\.\//, "");
    return rules.some((rule) => {
      const anchored = rule.startsWith("/");
      const body = anchored ? rule.slice(1) : rule;
      const directoryOnly = body.endsWith("/");
      const core = directoryOnly ? body.slice(0, -1) : body;
      if (!core) return false;

      const regex = globToRegExp(core);
      const segments = path.split("/");
      // 디렉터리 규칙은 경로 어느 마디에 걸려도 그 아래 전부를 덮는다(sessions/ 처럼).
      if (directoryOnly) {
        const candidates = anchored ? segments.slice(0, 1) : segments.slice(0, -1);
        return candidates.some((segment) => regex.test(segment));
      }
      if (anchored) return regex.test(path) || regex.test(segments[0] ?? "");
      // 이름 규칙은 마디 이름과 전체 경로 양쪽으로 본다(*.log, dist/ 아래 파일 등).
      return regex.test(path) || segments.some((segment) => regex.test(segment));
    });
  };
}

export function createGitArtifactIgnoreLookup(): ArtifactIgnoreLookup {
  const matcherByRoot = new Map<string, (relativePath: string) => boolean>();
  return {
    async ignoredPaths(root, relativePaths) {
      if (relativePaths.length === 0) return new Set();
      let matcher = matcherByRoot.get(root);
      if (!matcher) {
        let patterns: string[] = [];
        try {
          patterns = (await readFile(join(resolve(root), ".gitignore"), "utf8")).split(/\r?\n/);
        } catch {
          // .gitignore 가 없는 저장소면 아무것도 무시하지 않는다 — 수집이 과해지는
          // 것이지 멎는 것이 아니다.
          patterns = [];
        }
        matcher = gitignoreMatcher(patterns);
        matcherByRoot.set(root, matcher);
      }
      return new Set(relativePaths.filter((path) => matcher!(path)));
    }
  };
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
