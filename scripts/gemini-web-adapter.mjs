// Gemini 웹 실행기 브리지. local-gateway 가 adapter_type=gemini_web 인 실행을 이 스크립트로
// 보낸다(packages/ai-adapters). 프롬프트는 stdin, 답변은 stdout, 실패 사유는 stderr 한 줄.
//
// 실제 브라우저 조작은 웹세션-자동화 스킬의 session.js 가 한다 — 여기서는 그 결과 JSON
// (stdout 마지막 줄)을 읽어 성공/실패를 판정하고, 실패면 운영자가 조치할 수 있는 사유로
// 분류한다. 사유 목록과 대응은 2026_08_12__OPERATION_INCIDENT_RUNBOOK.md 의
// "Gemini Web Executor Health" 절이 단일 출처다.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_SECONDS = 420;

// 웹세션-자동화 스킬은 사용자 홈 아래에 깔린다. 절대경로를 박으면 다른 계정·다른 PC에서
// 조용히 없는 파일을 실행하고, 실패 원인이 "제출 실패"처럼 엉뚱하게 분류된다.
export function defaultSessionScriptPath(env = process.env, home = homedir()) {
  return env.GEMINI_WEB_SESSION_SCRIPT ?? join(home, ".codex", "skills", "웹세션-자동화", "session.js");
}

export function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key?.startsWith("--")) args.set(key.slice(2), argv[i + 1]);
  }
  return args;
}

// session.js 는 진행 로그 뒤에 결과 JSON 한 줄을 남긴다. 마지막 JSON 객체가 결과다.
export function parseLastJson(text) {
  const lines = String(text ?? "").trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return undefined;
}

// 실패 사유 분류. 앞의 것이 우선한다 — CDP 가 안 붙으면 로그인 여부는 알 수도 없다.
export function classify(meta, stderr) {
  const text = `${meta?.reason ?? ""} ${meta?.error ?? ""} ${stderr ?? ""}`;
  if (/CDP|9222|connect|ECONNREFUSED/i.test(text)) return "gemini-web-cdp-unavailable";
  if (/로그인|login|signin|auth|accounts/i.test(text)) return "gemini-web-login-required";
  if (/제출|submit|입력 삽입/i.test(text)) return "gemini-web-submit-failed";
  if (/제한시간|timeout|timed out|시간 초과/i.test(text)) return "gemini-web-response-timeout";
  if (/new answer|신규 답변|empty/i.test(text)) return "gemini-web-new-response-missing";
  return "gemini-web-session-failed";
}

// session.js 결과가 "새 답변을 받았다"인지. ok 만 보면 안 된다 — 이전 답변을 다시 읽어
// ok:true 로 끝나는 경우가 있어 new_answer 까지 확인한다.
export function isSuccessfulResult(exitCode, meta) {
  return exitCode === 0 && meta?.ok === true && meta?.new_answer === true;
}

export function buildSessionArgs({ sessionScript, promptFile, outputFile, timeoutSeconds, chatUrl }) {
  const args = [sessionScript, "chat", "--site", "gemini", "--prompt-file", promptFile, "--out", outputFile, "--timeout", String(timeoutSeconds)];
  if (chatUrl) args.push("--url", chatUrl);
  return args;
}

export async function runGeminiWebBridge({ prompt, timeoutSeconds, sessionScript, chatUrl, runProcess = run, stdout = process.stdout, stderr = process.stderr }) {
  if (!String(prompt ?? "").trim()) {
    stderr.write("gemini-web-empty-prompt\n");
    return 1;
  }
  const dir = await mkdtemp(join(tmpdir(), "huai-gemini-"));
  const promptFile = join(dir, "prompt.txt");
  const outputFile = join(dir, "answer.txt");
  try {
    await writeFile(promptFile, prompt, "utf8");
    const childArgs = buildSessionArgs({ sessionScript, promptFile, outputFile, timeoutSeconds, chatUrl });
    const result = await runProcess(process.execPath, childArgs, timeoutSeconds * 1000 + 5000);
    const meta = parseLastJson(result.stdout);
    if (!isSuccessfulResult(result.exitCode, meta)) {
      stderr.write(classify(meta, result.stderr) + "\n");
      if (result.stdout.trim()) stdout.write(result.stdout.trim() + "\n");
      return 1;
    }
    const answer = await readFile(outputFile, "utf8").catch(() => "");
    if (!answer.trim()) {
      stderr.write("gemini-web-empty-new-answer\n");
      return 1;
    }
    stdout.write(answer);
    return 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

// 직접 실행될 때만 stdin 을 읽는다. 테스트가 위 순수 함수를 import 하면 아무것도 실행되지 않는다.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const args = parseArgs(process.argv.slice(2));
  const timeoutSeconds = Number(args.get("timeout") ?? DEFAULT_TIMEOUT_SECONDS);
  const prompt = await readStdin();
  process.exitCode = await runGeminiWebBridge({
    prompt,
    timeoutSeconds,
    sessionScript: defaultSessionScriptPath(),
    chatUrl: process.env.GEMINI_WEB_CHAT_URL
  });
}
