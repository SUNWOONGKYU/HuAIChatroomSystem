// 로그 회전 — 무한 증가 방지.
//
// 두 감독 스크립트(start-services.mjs, restart-operation-services-from-live-env.mjs) 모두
// 로그 파일을 append 모드("a" / FILE_APPEND_DATA)로 열어 그 fd 를 다른 곳에 넘긴다:
//   - start-services.mjs 는 자식 stdout/stderr 를 .pipe() 로 그 스트림에 흘려보낸다.
//   - restart-operation-services-from-live-env.mjs 는 openSync 로 연 fd 를 spawn 의
//     stdio 로 그대로 넘겨, 자식 프로세스가 그 fd 에 직접 쓴다.
//
// 그래서 rename 기반 회전(로그를 .1 로 옮기고 새 파일을 만드는 방식)은 여기서 못 쓴다.
// rename 은 경로만 바꿀 뿐 이미 열려 있는 fd 가 가리키는 대상(inode)은 그대로다 — 자식은
// 이름이 없어진 옛 파일에 계속 쓰고, 새로 생긴 경로는 아무도 쓰지 않는 채로 남는다.
// 로그가 volume 에서 줄어드는 게 아니라 안 보이는 곳에 계속 쌓이는 꼴이 되어 회전의
// 목적을 정확히 반대로 만든다.
//
// 대신 logrotate 의 copytruncate 전략을 쓴다: 현재 내용을 .1 로 복사(기존 .1.. 은 한 칸씩
// 밀고, cap 을 넘는 가장 오래된 것은 지운다)한 다음, 원본 경로 자체를 truncateSync 로
// 0바이트로 자른다. append 모드로 연 fd 의 쓰기 오프셋은 매 write 마다 "그 시점의 파일
// 끝"으로 커널이 다시 계산한다(Windows FILE_APPEND_DATA, POSIX O_APPEND 모두 동일) —
// 캐시된 오프셋을 쓰는 게 아니다. 그래서 truncate 직후의 write 는 fd 를 다시 열거나
// 자식 프로세스를 재시작하지 않아도 파일의 0바이트 지점부터 정확히 이어진다.
import { closeSync, copyFileSync, existsSync, openSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20MB
export const DEFAULT_MAX_BACKUPS = 5;
export const DEFAULT_WATCH_INTERVAL_MS = 60_000; // 60s

// 결함(3차 감사) 대응 — copy-then-truncate 는 그 자체로 원자적이지 않다. 지금은 이
// 파일을 부르는 두 호출부(start-services.mjs 의 상주 watcher, restart-operation-
// services-from-live-env.mjs 의 1회성 재기동)가 서로 다른 로그 경로(logs/ vs
// C:\tmp\huai-logs\)를 써서 우연히 안전할 뿐, 코드 자체에는 아무 가드가 없었다.
// 같은 로그 경로를 다루는 세 번째 호출부가 잘못 붙어 같은 파일을 동시에 회전시키면,
// 한쪽이 truncate 한 직후 다른 쪽이 그 truncate 이전(비어 있지 않던) 크기를 기준으로
// 또 shift/copy/truncate 를 실행해 방금 만든 .1 백업을 빈 내용으로 덮어쓸 수 있다.
//
// 이 락은 openSync(path, "wx")(exclusive create — 이미 있으면 EEXIST) 로 잡는다. 같은
// Node 프로세스 안에서는 rotateLogIfOversized 전체가 동기 함수라 애초에 끼어들 틈이
// 없지만, 이 함수를 부르는 두 프로세스가 서로 다른 OS 프로세스이므로 JS 의 단일 스레드
// 보장이 프로세스 경계를 넘지 못한다 — 그래서 프로세스 간에도 유효한 실제 파일시스템
// 잠금이 필요하다.
const LOCK_STALE_MS = 60_000; // 락을 쥔 프로세스가 죽어 락 파일만 남는 경우를 위한 회수 시한.

function acquireRotationLock(logPath) {
  const lockPath = `${logPath}.rotate.lock`;
  try {
    closeSync(openSync(lockPath, "wx"));
    return lockPath;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  // 락이 이미 있다 — 하지만 그 락을 쥔 프로세스가 죽고 파일만 남았을 수 있다(크래시,
  // kill -9 등은 정리 코드를 못 돈다). 너무 오래된 락은 죽은 락으로 보고 회수한다.
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age <= LOCK_STALE_MS) return null;
    rmSync(lockPath, { force: true });
    closeSync(openSync(lockPath, "wx"));
    return lockPath;
  } catch {
    // 회수 시도 중 실패(예: 그 사이 다른 프로세스가 먼저 회수) — 이번 회차는 건너뛴다.
    return null;
  }
}

function releaseRotationLock(lockPath) {
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // best-effort — 다음 회전 시도가 스테일 락 회수 경로로 알아서 정리한다.
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

// 코드 변경 없이 운영자가 조정할 수 있도록 환경변수로 오버라이드한다. 값이 없거나
// 잘못돼도 기본값으로 조용히 떨어진다 — 회전 설정 하나 때문에 감독자가 죽으면 안 된다.
export function maxBytesFromEnv(env = process.env) {
  return positiveInteger(env.HUAI_LOG_MAX_BYTES) ?? DEFAULT_MAX_BYTES;
}

export function maxBackupsFromEnv(env = process.env) {
  return positiveInteger(env.HUAI_LOG_MAX_BACKUPS) ?? DEFAULT_MAX_BACKUPS;
}

// 번호 붙은 백업을 한 칸씩 뒤로 민다: .(N-1) -> .N, ... 1 -> 2. .1 자리는 호출자가 바로
// 이어서 새로 채우므로 여기서는 옮기지 않는다. cap 을 넘어가는 가장 오래된 백업은 지운다.
function shiftNumberedBackups(logPath, maxBackups) {
  const oldest = `${logPath}.${maxBackups}`;
  if (existsSync(oldest)) {
    // best effort — 다음 회전에서 다시 정리되므로 실패해도 회전 자체를 막지 않는다.
    try { rmSync(oldest, { force: true }); } catch {}
  }
  for (let n = maxBackups - 1; n >= 1; n -= 1) {
    const from = `${logPath}.${n}`;
    if (!existsSync(from)) continue;
    const to = `${logPath}.${n + 1}`;
    try { renameSync(from, to); } catch {}
  }
}

// 로그 파일 하나를 검사해 max bytes 를 넘었으면 즉시 회전한다(1회성 호출).
// 넘지 않았으면 아무것도 하지 않는다 — no-op.
export function rotateLogIfOversized(logPath, options = {}) {
  const maxBytes = options.maxBytes ?? maxBytesFromEnv();
  const maxBackups = options.maxBackups ?? maxBackupsFromEnv();

  let size;
  try {
    size = statSync(logPath).size;
  } catch {
    // 파일이 아직 없으면 회전할 것도 없다.
    return false;
  }
  if (size <= maxBytes) return false;

  const lockPath = acquireRotationLock(logPath);
  if (!lockPath) {
    // 다른 프로세스가 지금 이 파일을 회전 중이다(또는 방금 회전을 끝냈다). 여기서
    // 강행하면 그 프로세스가 막 만든 .1 백업을 덮어쓸 수 있다 — 이번 회차는 건너뛴다.
    // 파일이 여전히 상한을 넘는다면 다음 검사(watcher 의 다음 tick, 또는 다음
    // 재기동)에서 다시 시도된다 — 데이터 유실보다 회전 한 번 늦는 편이 낫다.
    return false;
  }

  try {
    // 락을 기다리는 사이 다른 프로세스가 이미 회전을 끝냈을 수 있다 — 재확인한다.
    size = statSync(logPath).size;
    if (size <= maxBytes) return false;

    if (maxBackups > 0) {
      shiftNumberedBackups(logPath, maxBackups);
      // rename 이 아니라 copy — 원본은 곧이어 그대로 truncate 만 하고, 열려 있는 fd 는
      // 같은 경로를 계속 가리켜야 하기 때문이다(위 헤더 설명 참고).
      try { copyFileSync(logPath, `${logPath}.1`); } catch {}
    }
    truncateSync(logPath, 0);
    return true;
  } finally {
    releaseRotationLock(lockPath);
  }
}

// 상주 프로세스(감독자)용: 즉시 한 번 검사하고, 이후 setInterval 로 반복 검사한다.
// unref() 로 이 타이머 하나 때문에 프로세스가 종료를 못 하게 붙잡지 않게 한다 — 로그
// 회전은 부가 기능이지 이 프로세스가 살아 있어야 할 이유가 아니다.
export function startLogRotationWatcher(logPaths, options = {}) {
  const paths = Array.isArray(logPaths) ? logPaths : [logPaths];
  const intervalMs = options.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const rotateOptions = { maxBytes: options.maxBytes, maxBackups: options.maxBackups };

  const check = () => {
    for (const path of paths) {
      try {
        rotateLogIfOversized(path, rotateOptions);
      } catch {
        // 회전 실패가 감독자 본연의 임무(서비스 재시작)를 막으면 안 된다.
      }
    }
  };

  check();
  const timer = setInterval(check, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
