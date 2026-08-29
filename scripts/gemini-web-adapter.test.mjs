import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionArgs,
  classify,
  defaultSessionScriptPath,
  isSuccessfulResult,
  parseArgs,
  parseLastJson,
  runGeminiWebBridge
} from "./gemini-web-adapter.mjs";

// 분류 순서가 곧 운영자의 첫 조치다 — CDP 가 안 붙으면 로그인 여부는 알 수 없으므로
// 둘 다 들어 있는 메시지는 CDP 쪽으로 분류돼야 한다.
test("실패 사유를 운영자가 조치할 수 있는 6종으로 분류한다", () => {
  assert.equal(classify({ reason: "ECONNREFUSED 127.0.0.1:9222" }, ""), "gemini-web-cdp-unavailable");
  assert.equal(classify({ error: "CDP connect failed; login page shown" }, ""), "gemini-web-cdp-unavailable");
  assert.equal(classify({ reason: "accounts.google.com 로그인 필요" }, ""), "gemini-web-login-required");
  assert.equal(classify({ reason: "입력 삽입 실패" }, ""), "gemini-web-submit-failed");
  assert.equal(classify(undefined, "timed out after 420s"), "gemini-web-response-timeout");
  assert.equal(classify({ reason: "no new answer detected" }, ""), "gemini-web-new-response-missing");
  assert.equal(classify({ reason: "something else" }, ""), "gemini-web-session-failed");
  assert.equal(classify(undefined, undefined), "gemini-web-session-failed");
});

test("session.js 출력에서 마지막 JSON 줄만 결과로 읽는다", () => {
  const stdout = "progress: opening tab\n{\"step\":1}\nnoise line\n{\"ok\":true,\"new_answer\":true}\n";
  assert.deepEqual(parseLastJson(stdout), { ok: true, new_answer: true });
  assert.equal(parseLastJson("no json here"), undefined);
  assert.equal(parseLastJson(""), undefined);
  assert.equal(parseLastJson(undefined), undefined);
  // 배열·문자열 JSON 은 결과가 아니다.
  assert.deepEqual(parseLastJson("[1,2]\n{\"ok\":false}"), { ok: false });
});

// 실측 함정: 이전 답변을 다시 읽어 ok:true 로 끝나는 경우가 있다. new_answer 까지 봐야 한다.
test("성공 판정은 exit 0 + ok + new_answer 셋 다 필요하다", () => {
  assert.equal(isSuccessfulResult(0, { ok: true, new_answer: true }), true);
  assert.equal(isSuccessfulResult(0, { ok: true }), false);
  assert.equal(isSuccessfulResult(0, { ok: true, new_answer: false }), false);
  assert.equal(isSuccessfulResult(1, { ok: true, new_answer: true }), false);
  assert.equal(isSuccessfulResult(0, undefined), false);
});

test("--timeout 등 인자를 파싱하고 session.js 호출 인자를 조립한다", () => {
  const args = parseArgs(["--timeout", "30", "--other", "x"]);
  assert.equal(args.get("timeout"), "30");
  assert.equal(args.get("other"), "x");

  const withoutUrl = buildSessionArgs({ sessionScript: "S", promptFile: "P", outputFile: "O", timeoutSeconds: 30 });
  assert.deepEqual(withoutUrl, ["S", "chat", "--site", "gemini", "--prompt-file", "P", "--out", "O", "--timeout", "30"]);
  const withUrl = buildSessionArgs({ sessionScript: "S", promptFile: "P", outputFile: "O", timeoutSeconds: 30, chatUrl: "https://gemini.google.com/app/abc" });
  assert.deepEqual(withUrl.slice(-2), ["--url", "https://gemini.google.com/app/abc"]);
});

test("세션 스크립트 기본 경로는 홈 디렉터리 기준이고 env 가 우선한다", () => {
  assert.equal(defaultSessionScriptPath({}, "/home/x"), join("/home/x", ".codex", "skills", "웹세션-자동화", "session.js"));
  assert.equal(defaultSessionScriptPath({ GEMINI_WEB_SESSION_SCRIPT: "/custom/session.js" }, "/home/x"), "/custom/session.js");
});

function capture() {
  const out = { text: "" };
  return { sink: { write: (chunk) => { out.text += String(chunk); } }, out };
}

test("빈 프롬프트는 session.js 를 띄우지 않고 gemini-web-empty-prompt 로 끝난다", async () => {
  const stdout = capture(); const stderr = capture();
  let spawned = false;
  const code = await runGeminiWebBridge({
    prompt: "   ",
    timeoutSeconds: 5,
    sessionScript: "S",
    runProcess: async () => { spawned = true; return { exitCode: 0, stdout: "", stderr: "" }; },
    stdout: stdout.sink,
    stderr: stderr.sink
  });
  assert.equal(code, 1);
  assert.equal(spawned, false);
  assert.equal(stderr.out.text.trim(), "gemini-web-empty-prompt");
});

test("session.js 실패는 분류된 사유 한 줄을 stderr 로, 원본 stdout 은 그대로 넘긴다", async () => {
  const stdout = capture(); const stderr = capture();
  const code = await runGeminiWebBridge({
    prompt: "hello",
    timeoutSeconds: 5,
    sessionScript: "S",
    runProcess: async () => ({ exitCode: 1, stdout: "log\n{\"ok\":false,\"reason\":\"ECONNREFUSED 9222\"}", stderr: "" }),
    stdout: stdout.sink,
    stderr: stderr.sink
  });
  assert.equal(code, 1);
  assert.equal(stderr.out.text.trim(), "gemini-web-cdp-unavailable");
  assert.match(stdout.out.text, /ECONNREFUSED 9222/);
});

test("성공하면 답변 파일 내용을 stdout 으로 내보내고 프롬프트는 파일로 전달한다", async () => {
  const stdout = capture(); const stderr = capture();
  let seenPrompt = "";
  const code = await runGeminiWebBridge({
    prompt: "요약해 줘",
    timeoutSeconds: 5,
    sessionScript: "S",
    chatUrl: "https://gemini.google.com/app/abc",
    runProcess: async (_exe, args) => {
      const promptFile = args[args.indexOf("--prompt-file") + 1];
      const outputFile = args[args.indexOf("--out") + 1];
      seenPrompt = await readFile(promptFile, "utf8");
      await writeFile(outputFile, "답변입니다", "utf8");
      assert.equal(args[args.indexOf("--url") + 1], "https://gemini.google.com/app/abc");
      return { exitCode: 0, stdout: "{\"ok\":true,\"new_answer\":true}", stderr: "" };
    },
    stdout: stdout.sink,
    stderr: stderr.sink
  });
  assert.equal(code, 0);
  assert.equal(seenPrompt, "요약해 줘");
  assert.equal(stdout.out.text, "답변입니다");
  assert.equal(stderr.out.text, "");
});

test("ok 인데 답변 파일이 비어 있으면 gemini-web-empty-new-answer 다", async () => {
  const stdout = capture(); const stderr = capture();
  const code = await runGeminiWebBridge({
    prompt: "x",
    timeoutSeconds: 5,
    sessionScript: "S",
    runProcess: async () => ({ exitCode: 0, stdout: "{\"ok\":true,\"new_answer\":true}", stderr: "" }),
    stdout: stdout.sink,
    stderr: stderr.sink
  });
  assert.equal(code, 1);
  assert.equal(stderr.out.text.trim(), "gemini-web-empty-new-answer");
});

// 임시 디렉터리는 성공·실패 모두에서 정리돼야 한다 — 프롬프트에 방 대화가 실려 있다.
test("실행 후 임시 프롬프트·답변 파일을 남기지 않는다", async () => {
  let promptFile = "";
  await runGeminiWebBridge({
    prompt: "secret conversation",
    timeoutSeconds: 5,
    sessionScript: "S",
    runProcess: async (_exe, args) => { promptFile = args[args.indexOf("--prompt-file") + 1]; return { exitCode: 1, stdout: "", stderr: "boom" }; },
    stdout: capture().sink,
    stderr: capture().sink
  });
  assert.ok(promptFile);
  await assert.rejects(readFile(promptFile, "utf8"));
});

// import 만으로는 아무것도 실행되지 않아야 테스트가 stdin 을 기다리며 멈추지 않는다.
test("모듈 import 는 부수효과가 없다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-adapter-import-"));
  assert.ok(dir);
});
