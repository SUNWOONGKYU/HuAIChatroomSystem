import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";

const sourcePath = new URL("./treasure-collector-runner.html", import.meta.url);

class SyntheticWorkflow {
  constructor(log) { this.log = log; this.state = "pending"; }
  emit(actor, action, evidence) { this.log.push({ actor, action, status: "PASS", evidence, issue: "없음", state: this.state }); }
  requireState(expected) { assert.equal(this.state, expected, `expected state ${expected}, got ${this.state}`); }
  requireActor(actual, expected) { assert.equal(actual, expected, `unauthorized actor: ${actual}`); }
  injectConversation(actor, action, evidence) { this.requireActor(actor, "9001"); this.emit(`가상 참여자 ${actor}`, action, evidence); }
  ownerInstruction(actor, action, evidence) { this.requireActor(actor, "5001"); this.emit(`가상 방장 ${actor}`, action, evidence); }
  plan(actor, action, evidence) { this.requireState("pending"); this.requireActor(actor, "leader-fixture"); this.state = "plan_pending"; this.emit("LeaderBot fixture", action, evidence); }
  ownerApprove(actor, label) {
    this.requireActor(actor, "5001");
    assert.ok(["plan_pending", "revision"].includes(this.state), `approval not allowed in ${this.state}`);
    this.state = "approved";
    this.emit(`가상 방장 ${actor}`, `${label} 승인`, "synthetic approval handler");
  }
  execute(actor, action, evidence) { this.requireState("approved"); this.requireActor(actor, "code-worker-fixture"); this.state = "executing"; this.emit("코드 작업자 fixture", action, evidence); }
  prepare(actor, action, evidence) { this.requireState("executing"); this.requireActor(actor, "code-worker-fixture"); this.emit("코드 작업자 fixture", action, evidence); }
  securityRequest(actor, action, evidence) { this.requireState("executing"); this.requireActor(actor, "code-worker-fixture"); this.state = "security_requested"; this.emit("보안 fixture", action, evidence); }
  securityRespond(actor, action, evidence) { this.requireState("security_requested"); this.requireActor(actor, "security-fixture"); this.state = "security_responded"; this.emit("가상 보안 응답", action, evidence); }
  securityApprove(actor, action, evidence) { this.requireState("security_responded"); this.requireActor(actor, "5001"); this.state = "approved"; this.emit("가상 방장 5001", action, evidence); }
  generate(actor, action, evidence) { this.requireState("approved"); this.requireActor(actor, "code-worker-fixture"); this.state = "generated"; this.emit("코드 작업자 fixture", action, evidence); }
  revisionRequested(actor, number, evidence) { this.requireState(number === 1 ? "generated" : "approved"); this.requireActor(actor, "5001"); this.state = "revision_requested"; this.emit("가상 방장 5001", `수정 ${number} 요청`, evidence); }
  revisionApplied(actor, number, evidence) { this.requireState("revision_requested"); this.requireActor(actor, "code-worker-fixture"); this.state = "revision"; this.emit("코드 작업자 fixture", `수정 ${number} 적용`, evidence); }
  complete(actor, action, evidence) { this.requireState("approved"); this.requireActor(actor, "audit-fixture"); this.state = "completed"; this.emit("AuditBot fixture", action, evidence); }
}

test("격리된 합성 게임 개발 흐름을 기록하고 보물 수집 러너를 브라우저로 검증한다", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "huai-synthetic-treasure-"));
  const workPath = join(workDir, "treasure-collector-runner.html");
  const log = [];
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const workflow = new SyntheticWorkflow(log);

  try {
    workflow.injectConversation("9001", "대화 3턴 주입", "room=synthetic-room; turns=3");
    workflow.ownerInstruction("5001", "보물 수집 러너 요구 지시", "room=synthetic-room; owner=5001; participant=9001");
    workflow.plan("leader-fixture", "최근 대화 요약·게임 계획 생성", "title/purpose/scope/completionCriteria present");
    const beforeUnauthorizedPlanApproval = workflow.state;
    assert.throws(() => workflow.ownerApprove("9001", "잘못된 초기 계획"), /unauthorized actor/);
    assert.equal(workflow.state, beforeUnauthorizedPlanApproval, "참여자 승인 시 상태가 변하면 안 된다");
    workflow.ownerApprove("5001", "초기 계획");
    workflow.execute("code-worker-fixture", "게임 파일 생성", `file=${workPath}`);
    workflow.prepare("code-worker-fixture", "초기 실행 준비", "isolated worktree copy; no production path");
    workflow.securityRequest("code-worker-fixture", "안전한 테스트 webhook 요청", "fixture-only; no privilege escalation; no secrets");
    workflow.securityRespond("security-fixture", "가상 보안 응답", "synthetic security response");
    const beforeUnauthorizedSecurityApproval = workflow.state;
    assert.throws(() => workflow.securityApprove("9001", "잘못된 보안 승인"), /unauthorized actor/);
    assert.equal(workflow.state, beforeUnauthorizedSecurityApproval, "참여자 보안 승인 시 상태가 변하면 안 된다");
    workflow.securityApprove("5001", "가상 보안 승인", "synthetic approval ledger");

    let content = await readFile(sourcePath, "utf8");
    await writeFile(workPath, content, "utf8");
    workflow.generate("code-worker-fixture", "보물 수집 러너 생성", `sha256=${hash(content)}`);

    for (const [number, replacements] of [
      [["data-revision=\"0\"", "data-revision=\"1\""], ["speed:16", "speed:18"]],
      [["data-revision=\"1\"", "data-revision=\"2\""], ["보물을 모으세요", "황금 보물을 모으세요"]],
      [["data-revision=\"2\"", "data-revision=\"3\""], ["보물 수집 러너", "보물 수집 러너 · 최종판"]]
    ].entries()) {
      const revisionNo = number + 1;
      let next = await readFile(workPath, "utf8");
      const beforeSha256 = hash(next);
      workflow.revisionRequested("5001", revisionNo, `beforeSha256=${beforeSha256}`);
      for (const [from, to] of replacements) {
        assert.ok(next.includes(from), `revision ${revisionNo} source marker missing: ${from}`);
        next = next.replace(from, to);
      }
      await writeFile(workPath, next, "utf8");
      workflow.revisionApplied("code-worker-fixture", revisionNo, { beforeSha256, afterSha256: hash(next), bytes: Buffer.byteLength(next) });
      const beforeUnauthorizedRevisionApproval = workflow.state;
      assert.throws(() => workflow.ownerApprove("9001", `잘못된 수정 ${revisionNo} 승인`), /unauthorized actor/);
      assert.equal(workflow.state, beforeUnauthorizedRevisionApproval, `참여자 수정 ${revisionNo} 승인 시 상태가 변하면 안 된다`);
      workflow.ownerApprove("5001", `수정 ${revisionNo}`);
    }

    const browser = await chromium.launch({ headless: true });
    const server = createServer(async (req, res) => {
      if (req.url !== "/treasure-collector-runner.html") { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(workPath));
    });
    const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/treasure-collector-runner.html`);
      await page.getByRole("button", { name: "게임 시작" }).click();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      assert.equal(await page.locator("#score").textContent(), "보물 1");
      assert.equal(await page.locator("#status").textContent(), "보물을 획득했습니다!");
      assert.equal(await page.locator("#revision").textContent(), "수정 3");
      await page.getByRole("button", { name: "다시 시작" }).click();
      assert.equal(await page.locator("#score").textContent(), "보물 0");
      workflow.complete("audit-fixture", "최종 브라우저 검증·완료", "click start/restart; 12 ArrowRight; treasure collected; revision=3");
    } finally {
      await browser.close();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    assert.equal(log.length, 20);
    assert.ok(log.filter((row) => row.action.includes("수정") && row.action.includes("적용")).every((row) => row.status === "PASS"));
    assert.equal(workflow.state, "completed");
    console.log(JSON.stringify({ result: "pass", scenario: "synthetic-treasure-collector-runner", steps: log.length, revisions: 3, security: "fixture-only", log }));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
