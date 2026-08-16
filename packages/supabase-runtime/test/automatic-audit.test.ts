import assert from "node:assert/strict";
import test from "node:test";
import { buildSingleWorkerAuditPrompt, producedRealArtifacts, realArtifactPaths } from "../src/index.js";
import { type GatewayEvent } from "../../contracts/src/index.js";

// 자동 검증 기준: 이 실행이 실제로 무언가를 만들거나 고쳤는가.
//
// 예전 기준은 프롬프트·결과 문자열의 단어표(검증·감사·구현 완료·supabase·migration …)
// 였다. 요청자가 고른 단어로 감사 여부가 갈리는 건 근거가 없었고, 실제로 단일 작업자
// 자동감사는 라이브에서 한 번도 실행되지 않았다(감사 실행 9건은 전부 다중 AI 경로).

test("파일을 바꾼 작업은 감사 대상이다", () => {
  assert.equal(producedRealArtifacts([artifact("packages/orchestrator/src/index.ts")]), true);
});

test("아무것도 안 바꾼 질의응답은 감사 대상이 아니다", () => {
  // "줄 수 알려줘" 류. 독립 감사를 붙일 대상이 없는데 돌리면 AI 실행 한 번이 그냥 낭비다.
  assert.equal(producedRealArtifacts([]), false);
  assert.equal(producedRealArtifacts([{ type: "stdout", taskId: "t", attemptId: "a", text: "86줄입니다." }]), false);
});

test("세션 기록 파일은 작업 산출물로 세지 않는다", () => {
  // Claude Code 훅이 자기 세션을 남기며 만드는 부산물이다. 라이브에서 README 줄 수를
  // 세는 작업에도 3건이 붙었다 — 이걸 세면 모든 질의응답이 감사 대상이 된다.
  const events = [
    artifact("sessions/.wiki-distill.log"),
    artifact("sessions/wiki/INDEX.md"),
    artifact("sessions/summary/2026_08_16__09.48_요약.md")
  ];

  assert.equal(producedRealArtifacts(events), false);
  assert.deepEqual(realArtifactPaths(events), []);
});

test("세션 기록에 실제 산출물이 섞여 있으면 감사한다", () => {
  const events = [artifact("sessions/wiki/INDEX.md"), artifact("packages/workflow/src/index.ts")];

  assert.equal(producedRealArtifacts(events), true);
  assert.deepEqual(realArtifactPaths(events), ["packages/workflow/src/index.ts"]);
});

test("역슬래시 경로에서도 세션 기록을 알아본다", () => {
  // 게이트웨이가 Windows 경로를 그대로 실어 보낸다.
  assert.equal(producedRealArtifacts([artifact("C:\\Dev\\HuAIChatroomSystem\\sessions\\raw\\x.jsonl")]), false);
});

test("이름에 sessions 가 들어간 실제 소스는 살린다", () => {
  // 경로 구분자로 둘러싸인 sessions 만 기록용으로 본다. 부분 문자열로 잡으면
  // session-store.ts 같은 진짜 소스가 감사에서 빠진다.
  assert.equal(producedRealArtifacts([artifact("apps/bot-service/src/session-store.ts")]), true);
  assert.equal(producedRealArtifacts([artifact("packages/sessions-view/src/index.ts")]), true);
});

test("감사 프롬프트에 작업자 보고와 바뀐 파일이 담긴다", () => {
  const prompt = buildSingleWorkerAuditPrompt(
    "task-1",
    "ClaudeBot",
    "옵션 파싱을 고쳤습니다.",
    ["packages/orchestrator/src/index.ts"]
  );

  assert.match(prompt, /대상 작업: task-1/);
  assert.match(prompt, /작업자: ClaudeBot/);
  assert.match(prompt, /옵션 파싱을 고쳤습니다/);
  assert.match(prompt, /- packages\/orchestrator\/src\/index\.ts/);
  // 감사 결과가 방으로 나가므로 내부 출력 금지는 프롬프트에 남아 있어야 한다.
  assert.match(prompt, /금지/);
});

test("작업자 보고가 비어도 프롬프트가 빈칸으로 나가지 않는다", () => {
  const prompt = buildSingleWorkerAuditPrompt("task-1", "CodexBot", "", []);

  assert.match(prompt, /\(보고 없음\)/);
  assert.match(prompt, /\(없음\)/);
});

function artifact(path: string): GatewayEvent {
  return {
    type: "artifact_collected",
    taskId: "task-1",
    artifact: { path, uri: path.startsWith("C:") ? path : `file:///C:/Dev/HuAIChatroomSystem/${path}`, version: "attempt-1" }
  } as GatewayEvent;
}
