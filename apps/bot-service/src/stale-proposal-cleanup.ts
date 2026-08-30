// 결정되지 않고 쌓인 제안을 bot-service 가 주기적으로 정리한다.
//
// 왜 필요한가: scripts/cancel-stale-proposals.mjs 는 --apply 를 사람이 직접 쳐야 도는
// 수동 CLI 였다. 저장소 어디에도 실제 정리 실행이 기동·스케줄 경로에 연결돼 있지
// 않아, 방장이 응답 안 한 제안이 영원히 쌓였다(라이브에서 한 방의 제안 150건 중
// 결정된 것이 9건뿐이었고, 나머지가 5일치 재고로 협업 운영센터 첫 화면을 122건으로
// 채운 사례 — cancel-stale-proposals.mjs 자체 주석 참고).
//
// 판정 로직(selectStaleProposals/buildCancellationRows)을 여기서 다시 구현하지 않는
// 이유: cancel-stale-proposals.mjs 가 이미 검증된 단일 출처이고, 로직을 복제하면
// 두 코드가 갈라져(드리프트) 한쪽만 고쳐지는 결함이 난다. 그런데 bot-service(TS,
// tsc 로 dist/ 에 컴파일)와 scripts/(빌드 없이 바로 도는 plain ESM, tsconfig.build.json
// 의 컴파일 대상이 아니라 dist 에도 안 들어간다)는 별도 빌드 경계라 상대경로 import
// 로 직접 묶을 수 없다(소스 기준 경로와 dist 기준 경로의 깊이가 dist/ 한 겹만큼
// 어긋난다). 그래서 그 스크립트를 있는 그대로 자식 프로세스로 실행한다 — 사람이
// --apply 로 수동 실행하는 것과 bot-service 가 주기적으로 실행하는 것이 물리적으로
// 완전히 같은 코드 한 벌을 탄다.

import { spawn } from "node:child_process";
import path from "node:path";

export type StaleProposalCleanupResult = { exitCode: number; stdout: string; stderr: string };

export type StaleProposalCleanupPorts = {
  run(): Promise<StaleProposalCleanupResult>;
  onResult?(result: StaleProposalCleanupResult): void;
  onError?(error: unknown): void;
};

// 한 번 정리를 시도한다. 실행 자체가 실패해도(스크립트 오류, Supabase 접속 실패 등)
// 예외를 던지지 않는다 — 다음 주기에 다시 시도하면 되고, 정리 실패가 bot-service
// 전체를 죽이면 안 된다.
export async function runStaleProposalCleanupOnce(ports: StaleProposalCleanupPorts): Promise<void> {
  try {
    const result = await ports.run();
    ports.onResult?.(result);
  } catch (error) {
    ports.onError?.(error);
  }
}

export type StaleProposalCleanupHandle = { stop(): void };

export function startStaleProposalCleanupLoop(
  ports: StaleProposalCleanupPorts & { intervalMs?: number }
): StaleProposalCleanupHandle {
  // 1시간 — 방장이 응답 안 한 제안이 쌓이는 속도(라이브 사례: 5일치 150건)에 비해
  // 넉넉하다. 너무 짧으면 Supabase 호출만 잦아지고, 너무 길면 다시 쌓인다.
  const intervalMs = ports.intervalMs ?? 60 * 60 * 1000;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runStaleProposalCleanupOnce(ports);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

// scripts/cancel-stale-proposals.mjs 를 --apply 로 실행하는 자식 프로세스를 만든다.
// cwd 는 저장소 루트를 가정한다 — start-services.mjs/restart-operation-services-
// from-live-env.mjs 등 기존 운영 스크립트들도 전부 저장소 루트를 cwd 로 두고
// dist/apps/... 상대경로를 그대로 쓰는 것과 같은 전제다.
export function createStaleProposalCleanupRunner(
  options: { cwd?: string; scriptRelativePath?: string; reason?: string; env?: NodeJS.ProcessEnv } = {}
): () => Promise<StaleProposalCleanupResult> {
  const cwd = options.cwd ?? process.cwd();
  const scriptPath = path.join(cwd, options.scriptRelativePath ?? "scripts/cancel-stale-proposals.mjs");
  const reason = options.reason ?? "bot-service 자동 정리 — 결정되지 않고 누적된 제안";

  return () =>
    new Promise<StaleProposalCleanupResult>((resolve) => {
      const child = spawn(process.execPath, [scriptPath, "--apply", "--reason", reason], {
        cwd,
        windowsHide: true,
        env: options.env ?? process.env
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => resolve({ exitCode: 1, stdout, stderr: `${stderr}\n${String(error)}` }));
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
}
