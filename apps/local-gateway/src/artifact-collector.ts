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

export function createArtifactCollector(fileSystem: ArtifactFileSystem = createNodeArtifactFileSystem()): ArtifactCollector {
  return {
    async collect(input) {
      const policy = normalizeArtifactPolicy(input.request.artifactPolicy);
      const entries = await fileSystem.listChangedFiles(input.request.projectPath, input.startedAtMs);
      const matched = entries
        .filter((entry) => entry.sizeBytes <= policy.maxArtifactBytes)
        .filter((entry) => matchesAnyGlob(entry.relativePath, policy.collectGlobs))
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
