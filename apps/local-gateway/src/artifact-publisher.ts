// 웹 산출물을 공개 주소로 올린다.
//
// 왜 필요한가: 방장은 폰으로 방을 본다. 실행이 만든 파일은 이 PC 안에만 있고, 산출물
// 기록에도 `file:///C:/...` 로 남는다 — 폰에서는 눌러도 아무 일이 안 일어난다. "게임을
// 만들어 줬으면 연결을 시켜줘야 하는데 안 시켜준다"가 이 상태였다.
//
// 왜 Supabase Storage 가 아닌가: `*.supabase.co` 는 HTML 응답을 text/plain + nosniff 로
// 덮어써서 브라우저가 소스를 그대로 보여준다(라이브 확인, scripts/build-miniapp-web.mjs
// 상단 주석과 같은 이유). 게임을 올려도 실행되지 않으므로 목적을 못 이룬다.
//
// 왜 깃 저장소에 안 넣는가: 산출물마다 커밋이 붙으면 이력이 결과물로 뒤덮이고, 배포도
// 저장소 상태에 묶인다. 배포는 임시 폴더에서 파일만 올린다.

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type PublishableArtifact = { path: string; uri?: string };

export type ArtifactPublishResult = {
  // 로컬 경로 → 공개 주소.
  publishedUrlByPath: Map<string, string>;
  // 올리지 못한 이유. 배포 실패가 작업 실패로 번지면 안 되므로 사유만 남긴다.
  failureReason?: string;
};

export type ArtifactPublisherConfig = {
  // 배포할 Vercel 프로젝트. 없으면 배포하지 않는다 — 기능을 끄는 스위치이기도 하다.
  vercelProject?: string;
  runCommand?: (command: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
};

// 웹으로 열어야 뜻이 있는 것만 올린다. 문서(hwp·xlsx·pdf)는 방에 파일로 전달하는 쪽이 맞다.
const WEB_ARTIFACT_PATTERN = /\.(html?|htm)$/i;

export function isWebArtifact(filePath: string): boolean {
  return WEB_ARTIFACT_PATTERN.test(filePath.split(/[?#]/)[0] ?? filePath);
}

// 배포 출력에서 주소만 뽑는다. Vercel 은 진행 로그를 섞어 내보내므로 마지막 URL 을 쓴다.
export function extractDeploymentUrl(stdout: string): string | undefined {
  const matches = stdout.match(/https:\/\/[^\s]+\.vercel\.app/g);
  return matches?.[matches.length - 1];
}

export async function publishWebArtifacts(
  artifacts: readonly PublishableArtifact[],
  config: ArtifactPublisherConfig
): Promise<ArtifactPublishResult> {
  const publishedUrlByPath = new Map<string, string>();
  if (!config.vercelProject) return { publishedUrlByPath };

  const webArtifacts = artifacts.filter((artifact) => isWebArtifact(artifact.path));
  if (webArtifacts.length === 0) return { publishedUrlByPath };

  const run = config.runCommand ?? runVercel;
  let stagingDir: string | undefined;
  try {
    stagingDir = await mkdtemp(path.join(tmpdir(), "huai-artifact-"));
    for (const artifact of webArtifacts) {
      const target = path.join(stagingDir, path.basename(artifact.path));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(artifact.path, target);
    }

    // 한 번의 배포에 이번 실행이 만든 웹 파일을 함께 올린다. 파일마다 배포하면 주소가
    // 흩어지고 배포 횟수도 파일 수만큼 늘어난다.
    const result = await run("vercel", ["deploy", "--prod", "--yes", "--name", config.vercelProject], stagingDir);
    const baseUrl = extractDeploymentUrl(result.stdout);
    if (result.exitCode !== 0 || !baseUrl) {
      return { publishedUrlByPath, failureReason: `vercel-deploy-failed:${result.exitCode}` };
    }

    for (const artifact of webArtifacts) {
      publishedUrlByPath.set(artifact.path, `${baseUrl}/${encodeURIComponent(path.basename(artifact.path))}`);
    }
    return { publishedUrlByPath };
  } catch (error) {
    // 배포가 안 됐다고 작업까지 실패시키지 않는다 — 결과물은 이 PC 에 이미 만들어져 있다.
    return { publishedUrlByPath, failureReason: `artifact-publish-error:${String(error).slice(0, 120)}` };
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runVercel(command: string, args: readonly string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    // Windows 에서 vercel 은 .cmd 셸 스크립트라 shell 없이는 실행되지 않는다.
    const child = spawn(command, [...args], { cwd, shell: true, windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => resolve({ stdout, exitCode: 1 }));
    child.on("close", (code) => resolve({ stdout, exitCode: code ?? 1 }));
  });
}
