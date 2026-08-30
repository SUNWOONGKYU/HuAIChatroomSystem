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
//
// 왜 여기서 바로 --prod 로 안 올리는가(2026-08-23, Grok Bot 사례 반영): 예전엔 실행이
// 끝나자마자 프로덕션에 바로 올라갔다 — 방장이 완료 승인을 누르기도 전에 결과물이 이미
// 공개돼 있었다("결과물 공개"와 "방장 승인"의 순서가 뒤집혀 있었다). 이제는 프리뷰만
// 올린다(Vercel 배포 URL은 프리뷰든 프로덕션이든 형태가 같아 방장이 미리 눌러볼 수 있다).
// 프로덕션 승격은 완료 승인이 실제로 기록된 뒤 artifact-promotion.ts 가 별도로 한다.

import { spawn, spawnSync } from "node:child_process";
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

const STAGING_DIR_CLEANUP_ATTEMPTS = 3;
const STAGING_DIR_CLEANUP_RETRY_DELAY_MS = 500;

// 결함(2차 감사) 대응 — 타임아웃 강제종료(killVercelProcess)는 settle() 과 별개로 최대
// FORCE_KILL_GRACE_MS(+ taskkill 자체 소요) 뒤에야 끝난다. settle() 이 먼저 resolve 되면
// publishWebArtifacts 의 finally 가 그 틈에 rm 을 실행하는데, 아직 살아있는 vercel
// 프로세스가 stagingDir 안 파일을 잠그고 있으면(Windows) 그 rm 이 즉시 실패한다.
// 예전에는 .catch(()=>undefined) 로 조용히 삼켜 temp 디렉터리가 누적됐다 — 이제는
// 재시도하고, 그래도 안 되면 사유를 구조화 로그로 남긴다(기존 형식 그대로).
// export 하는 이유: 재시도·최종 실패 로그를 직접 단위 테스트하기 위함(파일 잠금을 실제로
// 재현해서 검증한다 — mock 없이).
export async function cleanupStagingDir(stagingDir: string): Promise<void> {
  for (let attempt = 1; attempt <= STAGING_DIR_CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await rm(stagingDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === STAGING_DIR_CLEANUP_ATTEMPTS) {
        console.error(
          JSON.stringify({
            type: "artifact-publish-staging-cleanup-failed",
            stagingDir,
            attempts: attempt,
            error: String(error).slice(0, 200)
          })
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, STAGING_DIR_CLEANUP_RETRY_DELAY_MS * attempt));
    }
  }
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
    // --prod 를 빼서 프리뷰로만 올린다 — 프로덕션 승격은 완료 승인 이후(promoteDeployment)에만.
    const result = await run("vercel", ["deploy", "--yes", "--name", config.vercelProject], stagingDir);
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
    if (stagingDir) await cleanupStagingDir(stagingDir);
  }
}

export type DeploymentPromoteResult = { ok: boolean; failureReason?: string };
export type DeploymentPromoter = (deploymentUrl: string) => Promise<DeploymentPromoteResult>;

// 프리뷰로 올려둔 배포 하나를 프로덕션으로 승격한다. 파일을 다시 올리지 않는다 —
// Vercel 이 이미 갖고 있는 그 빌드를 프로덕션 별칭에 연결만 한다. 그래서 로컬
// 작업트리(worktree)가 이미 정리됐어도(완료 승인은 실행 한참 뒤에 올 수 있다) 문제없다.
export async function promoteDeployment(
  deploymentUrl: string,
  runCommand: (command: string, args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number }> = runVercel
): Promise<DeploymentPromoteResult> {
  const result = await runCommand("vercel", ["promote", deploymentUrl, "--yes"], process.cwd());
  if (result.exitCode !== 0) {
    return { ok: false, failureReason: `vercel-promote-failed:${result.exitCode}` };
  }
  return { ok: true };
}

// vercel deploy/promote 가 멈추면(토큰 만료 인터랙티브 프롬프트, 네트워크 블랙홀) 이
// 자식 프로세스를 기다리는 runVercel 이 영원히 안 끝난다. consumer.ts 의
// DEFAULT_CONCURRENCY=1 과 겹치면 게이트웨이 프로세스 전체가 그 한 건 때문에 영구
// 정지하고 모든 방의 작업이 멈춘다. process-runner.ts 가 이미 쓰는 패턴(타임아웃 →
// 정상 종료 신호 → 그래도 안 죽으면 SIGKILL)을 그대로 가져와 강제 종료를 보장한다.
const DEFAULT_DEPLOY_TIMEOUT_MS = 180_000;
const DEFAULT_PROMOTE_TIMEOUT_MS = 90_000;
const FORCE_KILL_GRACE_MS = 1_000;
// timeout(1) 관례를 따른다 — 자연스러운 vercel 종료코드와 겹치지 않아 로그만 보고도
// "멈춰서 강제 종료됐다"를 구분할 수 있다.
const TIMEOUT_EXIT_CODE = 124;

function readTimeoutMs(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function vercelTimeoutMsFor(args: readonly string[]): number {
  return args[0] === "promote"
    ? readTimeoutMs("LOCAL_GATEWAY_ARTIFACT_PROMOTE_TIMEOUT_MS", DEFAULT_PROMOTE_TIMEOUT_MS)
    : readTimeoutMs("LOCAL_GATEWAY_ARTIFACT_DEPLOY_TIMEOUT_MS", DEFAULT_DEPLOY_TIMEOUT_MS);
}

// shell:true 를 그대로 쓰는 이유(결함 인지 + 완전 제거는 보류): Windows 에서 .cmd
// 래퍼(vercel.cmd)를 shell 없이 안전하게 실행하려면 Win32 인자 인용 규칙과 cmd.exe
// 자체의 배치 문법(메타문자가 따옴표 안에서도 일부 살아있는 등 일관성이 없다)을 모두
// 손으로 재현해야 한다(cross-spawn 류가 하는 이중 이스케이프). 이걸 검증할 실제
// Windows + vercel 환경이 이 작업 범위엔 없어, 잘못 짜면 결함 1이 막으려는 것과 정반대로
// 배포 자체가 조용히 깨지는 위험(인자가 깨져 vercel 이 못 알아들음)이 이스케이프를
// 손으로 다시 구현하는 이득보다 크다고 판단했다. 대신 여기로 들어오는 인자를
// 화이트리스트로 검증해 cmd.exe 가 특별히 해석하는 문자(& | < > ^ % ! " ' 공백 등)가
// 아예 섞여 들어갈 수 없게 막는다 — 실제로 여기 오는 값(서브커맨드 리터럴, --yes/--name
// 같은 고정 플래그, config.vercelProject, extractDeploymentUrl 이 vercel 자신의 출력에서
// 뽑은 https://*.vercel.app 주소)은 전부 이 화이트리스트를 통과한다.
// export 하는 이유: 이 화이트리스트 자체의 경계(cmd.exe 메타문자 각각의 거부, 실제
// 사용되는 정상 인자의 통과)를 직접 단위 테스트하기 위함이다 — 기존에는 runVercel을
// 통째로 mock runCommand 레벨에서만 간접 커버했다(품질 인프라 감사에서 지적).
export const SAFE_VERCEL_ARG_PATTERN = /^[A-Za-z0-9._:/=+-]+$/;

export function assertSafeVercelArgs(command: string, args: readonly string[]): void {
  for (const value of [command, ...args]) {
    if (!SAFE_VERCEL_ARG_PATTERN.test(value)) {
      throw new Error(`unsafe-shell-argument:${value.slice(0, 40)}`);
    }
  }
}

// shell:true 로 띄운 cmd.exe 아래에는 vercel.cmd → 실제 vercel(node.exe) 프로세스가
// 자식으로 걸린다. child.kill() 은 맨 위 cmd.exe 만 끝내고 그 아래는 고아로 남아 계속
// 도는 것을 직접 재현해 확인했다 — 그러면 타임아웃을 걸어도 실제로는 아무것도 안 끝난
// 것과 같아 결함 1이 막으려는 영구 정지가 그대로 재발한다. Windows 에서는 taskkill
// /T 로 트리 전체(cmd.exe + 그 자식들)를 내려야 한다.
function killVercelProcess(child: ReturnType<typeof spawn>, force: boolean): void {
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      // 최상위(cmd.exe)를 먼저 끝내버리면 taskkill /T 가 트리를 찾을 PID 자체가
      // 사라져 그 아래(vercel.cmd → 실제 vercel node.exe)를 더는 못 내린다 — 직접
      // 재현해 확인했다: 여기서 child.kill() 을 먼저 호출하면 이후 taskkill /T /F 가
      // "지정한 프로세스를 찾을 수 없습니다"로 실패하고 자식이 고아로 남아 그대로
      // 자연 종료될 때까지(최대 수십 분) 돈다. 그래서 force 가 아닐 때는 child.kill()
      // 을 부르지 않는다 — 콘솔 프로그램은 대개 /F 없이는 안 죽으므로 이 시도는
      // 실패해도 무해하게 넘어가는 것으로 충분하다.
      const args = force ? ["/pid", String(child.pid), "/T", "/F"] : ["/pid", String(child.pid), "/T"];
      spawnSync("taskkill", args, { windowsHide: true });
      if (force) child.kill("SIGKILL");
      return;
    } catch {
      // taskkill 실행 자체가 안 되면(설치 안 됨 등) 여기로 온다 — 아래 child.kill() 로
      // 최소한 최상위 프로세스라도 내린다.
    }
  }
  child.kill(force ? "SIGKILL" : undefined);
}

// 테스트가 실제 kill 동작을 검증할 수 있도록 export 한다(publishWebArtifacts/
// promoteDeployment 는 기본값으로 이 함수를 쓴다 — config.runCommand 를 안 주면 이 경로다).
export function runVercel(command: string, args: readonly string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  const timeoutMs = vercelTimeoutMsFor(args);
  return new Promise((resolve) => {
    try {
      assertSafeVercelArgs(command, args);
    } catch (error) {
      resolve({ stdout: `artifact-publish-unsafe-argument:${String(error).slice(0, 160)}`, exitCode: 1 });
      return;
    }
    // Windows 에서 vercel 은 .cmd 셸 스크립트라 shell 없이는 실행되지 않는다.
    const child = spawn(command, [...args], { cwd, shell: true, windowsHide: true });
    let stdout = "";
    let settled = false;

    // settle() 은 프로미스 해소만 담당한다 — 실제 프로세스(트리)가 죽었는지는 별개
    // 문제라 아래 타임아웃 콜백의 강제종료 예약을 settle() 이 취소하면 안 된다.
    // (예전 버전은 settle() 안에서 forceKillTimer 를 clearTimeout 해버려, 예약한
    // 직후 같은 틱에서 취소돼 강제종료가 실제로는 한 번도 실행되지 않는 결함이
    // 있었다 — 타임아웃 자체는 걸렸지만 vercel 프로세스는 고아로 계속 돌았다.)
    const settle = (value: { stdout: string; exitCode: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(value);
    };

    const timeoutTimer = setTimeout(() => {
      // 정상 종료 신호를 무시하는 프로세스가 있을 수 있어 유예를 두고 강제 종료로 마무리한다.
      // 이미 죽은 프로세스에 다시 강제 종료를 걸어도 안전하다(taskkill/kill 모두
      // 대상이 없으면 조용히 실패할 뿐이다) — 그래서 settled 여부와 무관하게 실행한다.
      killVercelProcess(child, false);
      setTimeout(() => killVercelProcess(child, true), FORCE_KILL_GRACE_MS);
      settle({ stdout: `${stdout}\nartifact-publish-timeout:${args[0] ?? command}:${timeoutMs}ms`, exitCode: TIMEOUT_EXIT_CODE });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", () => settle({ stdout, exitCode: 1 }));
    child.on("close", (code) => settle({ stdout, exitCode: code ?? 1 }));
  });
}
