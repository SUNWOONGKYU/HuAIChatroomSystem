import assert from "node:assert/strict";
import test from "node:test";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateLogIfOversized } from "./log-rotation.mjs";

function tempLogPath(name = "test.log") {
  const dir = mkdtempSync(join(tmpdir(), "huai-log-rotation-"));
  return join(dir, name);
}

test("under threshold: rotation is a no-op", () => {
  const logPath = tempLogPath();
  writeFileSync(logPath, "small content");

  const rotated = rotateLogIfOversized(logPath, { maxBytes: 1024, maxBackups: 5 });

  assert.equal(rotated, false);
  assert.equal(existsSync(`${logPath}.1`), false);
  assert.equal(readFileSync(logPath, "utf8"), "small content");
});

test("over threshold: copies content to .1 and truncates original to 0 bytes", () => {
  const logPath = tempLogPath();
  const content = "x".repeat(100);
  writeFileSync(logPath, content);

  const rotated = rotateLogIfOversized(logPath, { maxBytes: 10, maxBackups: 5 });

  assert.equal(rotated, true);
  assert.equal(readFileSync(`${logPath}.1`, "utf8"), content);
  assert.equal(existsSync(logPath), true);
  assert.equal(statSync(logPath).size, 0);
});

test("backup cap: shifts existing .1..N chain and drops the oldest beyond the cap", () => {
  const logPath = tempLogPath();
  writeFileSync(logPath, "current".repeat(20));
  writeFileSync(`${logPath}.1`, "backup-1");
  writeFileSync(`${logPath}.2`, "backup-2");
  writeFileSync(`${logPath}.3`, "backup-3");

  rotateLogIfOversized(logPath, { maxBytes: 10, maxBackups: 3 });

  // 옛 .1 -> .2, 옛 .2 -> .3, 옛 .3 은 cap(3) 을 넘으므로 삭제되고
  // 새 .1 은 방금 회전된 원본 내용을 담는다.
  assert.equal(readFileSync(`${logPath}.1`, "utf8"), "current".repeat(20));
  assert.equal(readFileSync(`${logPath}.2`, "utf8"), "backup-1");
  assert.equal(readFileSync(`${logPath}.3`, "utf8"), "backup-2");
  assert.equal(existsSync(`${logPath}.4`), false);
});

// 결함(3차 감사) 대응 — copy-then-truncate 는 그 자체로 원자적이지 않다. 지금은
// 두 호출부가 서로 다른 로그 경로를 써서 우연히 안전할 뿐이었다. 락 파일
// (`${logPath}.rotate.lock`) 로 같은 경로에 대한 동시 회전을 막는다.

test("동시 회전 방지: 락이 이미 잡혀 있으면 회전을 건너뛰고 원본을 그대로 둔다", () => {
  const logPath = tempLogPath();
  const content = "z".repeat(100);
  writeFileSync(logPath, content);
  // 다른 프로세스가 지금 이 파일을 회전 중이라고 가정하고 락을 미리 잡아 둔다.
  closeSync(openSync(`${logPath}.rotate.lock`, "wx"));

  const rotated = rotateLogIfOversized(logPath, { maxBytes: 10, maxBackups: 5 });

  assert.equal(rotated, false, "락을 쥔 다른 프로세스가 있으면 이번 회차는 건너뛴다");
  assert.equal(readFileSync(logPath, "utf8"), content, "건너뛰었으니 원본은 그대로여야 한다");
  assert.equal(existsSync(`${logPath}.1`), false);
});

test("동시 회전 방지: 회전이 끝나면 락 파일을 남기지 않는다", () => {
  const logPath = tempLogPath();
  writeFileSync(logPath, "w".repeat(100));

  const rotated = rotateLogIfOversized(logPath, { maxBytes: 10, maxBackups: 5 });

  assert.equal(rotated, true);
  assert.equal(existsSync(`${logPath}.rotate.lock`), false, "락은 회전이 끝나면 즉시 풀려야 한다");
});

test("동시 회전 방지: 죽은 프로세스가 남긴 오래된 락은 회수해서 회전을 진행한다", () => {
  const logPath = tempLogPath();
  const content = "v".repeat(100);
  writeFileSync(logPath, content);

  const lockPath = `${logPath}.rotate.lock`;
  closeSync(openSync(lockPath, "wx"));
  // 락을 쥔 프로세스가 크래시해 정리를 못 한 상태를 흉내낸다 — mtime 을 스테일
  // 판정 시한(60s)보다 훨씬 이전으로 되돌린다.
  const staleTime = new Date(Date.now() - 10 * 60_000);
  utimesSync(lockPath, staleTime, staleTime);

  const rotated = rotateLogIfOversized(logPath, { maxBytes: 10, maxBackups: 5 });

  assert.equal(rotated, true, "스테일 락은 회수하고 회전을 진행해야 한다");
  assert.equal(readFileSync(`${logPath}.1`, "utf8"), content);
  assert.equal(existsSync(lockPath), false, "회전 후에는 새로 잡은 락도 풀려 있어야 한다");
});

test("append-mode fd survives truncate: a write right after truncation lands at offset 0", () => {
  // 이 테스트는 회전 전략 전체의 핵심 가정을 검증한다: start-services.mjs 와
  // restart-operation-services-from-live-env.mjs 모두 append 모드로 연 fd 를 자식에게
  // 넘긴 채로 원본 파일을 truncate 한다. fd 를 다시 열지 않고도 그다음 write 가
  // 파일의 0바이트 지점부터 정확히 이어지지 않으면 이 fix 전체가 성립하지 않는다.
  const logPath = tempLogPath();
  writeFileSync(logPath, "y".repeat(100));

  const fd = openSync(logPath, "a");
  try {
    rotateLogIfOversized(logPath, { maxBytes: 10, maxBackups: 5 });

    writeSync(fd, "after-truncate");

    const finalContent = readFileSync(logPath, "utf8");
    assert.equal(finalContent, "after-truncate");
    assert.equal(statSync(logPath).size, "after-truncate".length);
  } finally {
    closeSync(fd);
  }
});
