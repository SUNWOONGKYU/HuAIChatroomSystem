import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key?.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}

const timeoutSeconds = Number(args.get("timeout") ?? 420);
// 웹세션-자동화 스킬은 사용자 홈 아래에 깔린다. 절대경로를 박으면 다른 계정·다른 PC에서
// 조용히 없는 파일을 실행하고, 실패 원인이 "제출 실패"처럼 엉뚱하게 분류된다.
const sessionScript = process.env.GEMINI_WEB_SESSION_SCRIPT
  ?? join(homedir(), ".codex", "skills", "웹세션-자동화", "session.js");
const chatUrl = process.env.GEMINI_WEB_CHAT_URL;
const input = await readStdin();
if (!input.trim()) fail("gemini-web-empty-prompt");

const dir = await mkdtemp(join(tmpdir(), "huai-gemini-"));
const promptFile = join(dir, "prompt.txt");
const outputFile = join(dir, "answer.txt");
try {
  await writeFile(promptFile, input, "utf8");
  const childArgs = [sessionScript, "chat", "--site", "gemini", "--prompt-file", promptFile, "--out", outputFile, "--timeout", String(timeoutSeconds)];
  if (chatUrl) childArgs.push("--url", chatUrl);
  const result = await run(process.execPath, childArgs, timeoutSeconds * 1000 + 5000);
  const meta = parseLastJson(result.stdout);
  if (result.exitCode !== 0 || !meta?.ok || meta.new_answer !== true) {
    const reason = classify(meta, result.stderr);
    process.stderr.write(reason + "\n");
    if (result.stdout.trim()) process.stdout.write(result.stdout.trim() + "\n");
    process.exitCode = 1;
  } else {
    const answer = await readFile(outputFile, "utf8").catch(() => "");
    if (!answer.trim()) fail("gemini-web-empty-new-answer");
    process.stdout.write(answer);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

function classify(meta, stderr) {
  const text = `${meta?.reason ?? ""} ${meta?.error ?? ""} ${stderr ?? ""}`;
  if (/CDP|9222|connect|ECONNREFUSED/i.test(text)) return "gemini-web-cdp-unavailable";
  if (/로그인|login|signin|auth|accounts/i.test(text)) return "gemini-web-login-required";
  if (/제출|submit|입력 삽입/i.test(text)) return "gemini-web-submit-failed";
  if (/제한시간|timeout|timed out|시간 초과/i.test(text)) return "gemini-web-response-timeout";
  if (/new answer|신규 답변|empty/i.test(text)) return "gemini-web-new-response-missing";
  return "gemini-web-session-failed";
}

function parseLastJson(text) {
  const lines = String(text ?? "").trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try { const parsed = JSON.parse(line); if (parsed && typeof parsed === "object") return parsed; } catch {}
  }
  return undefined;
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

function run(command, commandArgs, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish({ exitCode: 124, stdout, stderr: stderr + " timeout" }); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ exitCode: 1, stdout, stderr: stderr + " " + error.message }));
    child.on("close", (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
  });
}
