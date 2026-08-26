// HuAI 상주 서비스 감독자.
//
// bot-service 와 local-gateway 를 자식 프로세스로 띄우고, 죽으면 다시 올린다.
// 부팅 자동 실행(install-autostart.ps1)이 이 파일을 실행한다.
//
// 두 서비스를 하나의 감독자가 들고 있는 이유:
//   - 예약 작업이 하나면 되고, 로그 위치가 한 곳으로 모인다
//   - 한쪽이 죽어도 다른 쪽이 살아 있는 어중간한 상태를 감독자가 정리한다
//
// 수신 방식은 .env.operation.local 의 BOT_SERVICE_RECEIVE_MODE 가 정한다.
// polling 이면 공개 URL·터널이 필요 없다.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOperationEnvFile } from "./operation-env-loader.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_DIR = join(ROOT, "logs");
const PID_DIR = "C:\\tmp";

const SERVICES = [
  { name: "bot-service", entry: "dist/apps/bot-service/src/cli.js", healthPort: 8787, pidFile: join(PID_DIR, "huai-bot-service.pid") },
  { name: "local-gateway", entry: "dist/apps/local-gateway/src/cli.js", healthPort: 8797, pidFile: join(PID_DIR, "huai-local-gateway.pid") }
];

const RESTART_DELAY_MS = 3000;
const MAX_RESTART_DELAY_MS = 60_000;

async function main() {
  applyOperationEnvFile(process.env);
  mkdirSync(LOG_DIR, { recursive: true });

  for (const service of SERVICES) {
    const entryPath = join(ROOT, service.entry);
    if (!existsSync(entryPath)) {
      console.error(`[감독자] 빌드 산출물이 없습니다: ${service.entry} — 먼저 'npm run build' 를 실행하세요.`);
      process.exitCode = 1;
      return;
    }
  }

  // 이미 떠 있는데 또 띄우면 포트 충돌로 한쪽이 조용히 죽는다. 먼저 확인한다.
  for (const service of SERVICES) {
    if (await isPortInUse(service.healthPort)) {
      console.error(`[감독자] 포트 ${service.healthPort} 사용 중 — ${service.name} 이 이미 실행 중입니다. 중복 기동을 멈춥니다.`);
      process.exitCode = 1;
      return;
    }
  }

  const children = SERVICES.map((service) => superviseService(service));

  const shutdown = () => {
    for (const child of children) child.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`[감독자] 시작 — 수신 방식=${process.env.BOT_SERVICE_RECEIVE_MODE ?? "webhook"} 로그=${LOG_DIR}`);
}

function superviseService(service) {
  const log = createWriteStream(join(LOG_DIR, `${service.name}.log`), { flags: "a" });
  let stopped = false;
  let delay = RESTART_DELAY_MS;
  let child;

  const start = () => {
    if (stopped) return;
    const startedAt = Date.now();
    child = spawn(process.execPath, [join(ROOT, service.entry)], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });

    child.on("exit", (code, signal) => {
      clearPidFile(service.pidFile, child.pid);
      if (stopped) return;
      // 오래 살아 있었으면 일시적 오류로 보고 대기 시간을 되돌린다.
      // 곧바로 죽으면 설정 문제일 가능성이 높아 점점 천천히 재시도한다.
      const alive = Date.now() - startedAt;
      delay = alive > 60_000 ? RESTART_DELAY_MS : Math.min(delay * 2, MAX_RESTART_DELAY_MS);
      const line = `[감독자] ${service.name} 종료 (code=${code} signal=${signal ?? "none"}) — ${delay}ms 후 재시작\n`;
      log.write(line);
      console.error(line.trim());
      setTimeout(start, delay);
    });

    child.on("error", (error) => {
      log.write(`[감독자] ${service.name} 기동 실패: ${maskSecrets(String(error))}\n`);
    });

    log.write(`[감독자] ${service.name} 기동 (pid=${child.pid}) ${new Date().toISOString()}\n`);
    writeFileSync(service.pidFile, `${child.pid}\n`, "utf8");
    console.log(`[감독자] ${service.name} 기동 pid=${child.pid}`);
  };

  start();
  return {
    stop() {
      stopped = true;
      child?.kill();
    }
  };
}

function clearPidFile(pidFile, pid) {
  try {
    if (Number(readFileSync(pidFile, "utf8").trim()) === Number(pid)) unlinkSync(pidFile);
  } catch {
    // PID file cleanup is best effort; stale files are ignored by live checks.
  }
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (inUse) => {
      socket.destroy();
      resolve(inUse);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1500, () => done(false));
  });
}

function maskSecrets(text) {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/\b(?:sk|pk|service_role)_[A-Za-z0-9_-]{16,}\b/g, "<redacted>");
}

await main();
