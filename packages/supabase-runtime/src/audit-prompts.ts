// index.ts 에서 뽑아낸 감사(audit) 프롬프트 빌더 + 자동 감사 판정. 순수 함수(I/O 없음, process.env 읽기만 예외).
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";
import { producedRealArtifacts } from "./engine-fallback.js";
import { extractClaudeAgentMessage, extractCodexAgentMessage, cleanHumanVisibleOutput } from "./gateway-report-rendering.js";
import { truncate } from "./small-utils.js";


// \uBB34\uC5C7\uC744 \uC790\uB3D9 \uAC10\uC0AC\uD560\uC9C0 \uC815\uD55C\uB2E4.
//
// \uAC80\uC99D\uC740 "\uBC14\uB010 \uAC83"\uC744 \uBCF4\uB294 \uC77C\uC774\uB2E4. \uADF8\uB798\uC11C \uAE30\uC900\uC740 \uC774 \uC2E4\uD589\uC774 \uC2E4\uC81C\uB85C \uBB34\uC5B8\uAC00\uB97C \uB9CC\uB4E4\uAC70\uB098
// \uACE0\uCCE4\uB294\uAC00 \uD558\uB098\uB2E4. \uD30C\uC77C\uC744 \uAC74\uB4DC\uB9AC\uC9C0 \uC54A\uC740 \uC9C8\uC758\uC751\uB2F5("\uC904 \uC218 \uC54C\uB824\uC918")\uC740 \uB3C5\uB9BD \uAC10\uC0AC\uB97C
// \uBD99\uC77C \uB300\uC0C1\uC774 \uC5C6\uC73C\uBBC0\uB85C \uAC74\uB108\uB6F4\uB2E4 \u2014 \uAC10\uC0AC \uD55C \uBC88\uC774 AI \uC2E4\uD589 \uD55C \uBC88\uC774\uB77C \uADF8\uB0E5 \uBE44\uC6A9\uC774\uB2E4.
//
// \uC608\uC804\uC5D0\uB294 \uD504\uB86C\uD504\uD2B8\uC640 \uACB0\uACFC \uBB38\uC790\uC5F4\uC744 \uB2E8\uC5B4\uD45C(\uAC80\uC99D\u00B7\uAC10\uC0AC\u00B7\uBCF4\uC548\u00B7\uAD6C\uD604 \uC644\uB8CC\u00B7\uD14C\uC2A4\uD2B8 \uD1B5\uACFC\u00B7
// supabase\u00B7migration \u2026)\uC5D0 \uB123\uC5B4 \uD310\uC815\uD588\uB2E4. \uC694\uCCAD\uC790\uAC00 \uBB34\uC2A8 \uB2E8\uC5B4\uB97C \uACE8\uB790\uB294\uC9C0\uB85C \uAC10\uC0AC \uC5EC\uBD80\uAC00
// \uAC08\uB9AC\uB294 \uAC74 \uADFC\uAC70\uAC00 \uC5C6\uB2E4 \u2014 "supabase"\uB97C \uC5B8\uAE09\uD558\uBA74 \uAC10\uC0AC\uD558\uACE0 \uAC19\uC740 \uBCC0\uACBD\uC744 \uB2E4\uB978 \uB9D0\uB85C
// \uC124\uBA85\uD558\uBA74 \uC548 \uD558\uB294 \uC2DD\uC774\uC5C8\uB2E4. \uC624\uB298 \uAC19\uC740 \uAD6C\uC870\uC758 \uB2E8\uC5B4\uD45C\uAC00 \uC81C\uBAA9\uACFC \uBCF4\uACE0 \uBCF8\uBB38\uC5D0\uC11C \uAC01\uAC01
// \uB2F5\uC744 \uC9C0\uC6B4 \uAC83\uC744 \uC7A1\uC558\uACE0, \uC5EC\uAE30\uB3C4 \uAC19\uC740 \uAC83\uC774\uB2E4.
export function shouldRunAutomaticAudit(request: ExecutionRequest, events: readonly GatewayEvent[]): boolean {
  if (process.env.HUAI_AUTO_AUDIT_ENABLED !== "true") return false;
  // \uAC10\uC0AC \uACB0\uACFC\uB97C \uB2E4\uC2DC \uAC10\uC0AC\uD558\uBA74 \uB05D\uB098\uC9C0 \uC54A\uB294\uB2E4.
  if (request.reportBotRole === "auditor") return false;
  // \uB2E4\uC911 AI \uC2E4\uD589\uC740 enqueueMultiAiAuditIfReady \uAC00 \uB450 \uACB0\uACFC\uB97C \uBAA8\uC544 \uD55C \uBC88\uC5D0 \uAC10\uC0AC\uD55C\uB2E4.
  if (multiAiAttemptGroup(request.attemptId)) return false;
  return producedRealArtifacts(events);
}

export function buildSingleWorkerAuditPrompt(
  taskId: string,
  actor: string,
  resultSummary: string,
  artifactPaths: readonly string[],
  // 이 방에서 되풀이된 지적. 같은 실수를 매번 처음처럼 발견하지 않게 미리 알려준다.
  // 방 기억(sessions/rooms/<방>/<날짜>_위키.md)의 "반복 지적" 절에서 온다.
  recurringFindings: readonly string[] = []
): string {
  const recurringLines = recurringFindings.length > 0
    ? [
        "",
        "이 방에서 되풀이된 지적 — 이번 결과에도 해당하는지 먼저 확인하라:",
        ...recurringFindings.map((finding) => "- " + finding)
      ]
    : [];

  return [
    "HuAI Collab Chatroom System\uC758 \uC791\uC5C5 \uACB0\uACFC\uB97C \uB3C5\uB9BD \uAC10\uC0AC\uD558\uC138\uC694.",
    "\uB300\uC0C1 \uC791\uC5C5: " + taskId,
    "\uC791\uC5C5\uC790: " + actor,
    "\uD310\uC815 \uAE30\uC900: \uACB0\uACFC\uC758 \uC815\uD655\uC131, \uC644\uB8CC \uC870\uAC74 \uCDA9\uC871 \uC5EC\uBD80, \uB204\uB77D\uB41C \uC2E4\uD589 \uC870\uCE58, \uC0AC\uC6A9\uC790\uC5D0\uAC8C \uD544\uC694\uD55C \uB2E4\uC74C \uC120\uD0DD\uC9C0.",
    "\uBCF4\uACE0: \uC0AC\uB78C\uC774 \uC54C\uC544\uC57C \uD560 \uACB0\uB860\uACFC \uD544\uC694\uD55C \uC870\uCE58\uB9CC \uAC04\uACB0\uD558\uAC8C \uC791\uC131\uD558\uC138\uC694.",
    "\uAE08\uC9C0: \uB0B4\uBD80 JSON, hook log, stack trace, token, API key, \uC6D0\uBB38 \uC2DC\uD06C\uB9BF \uCD9C\uB825.",
    "",
    "\uC791\uC5C5\uC790 \uBCF4\uACE0:",
    resultSummary || "(\uBCF4\uACE0 \uC5C6\uC74C)",
    "",
    "\uBCC0\uACBD\uB41C \uC0B0\uCD9C\uBB3C:",
    ...(artifactPaths.length > 0 ? artifactPaths.map((path) => "- " + path) : ["(\uC5C6\uC74C)"]),
    ...recurringLines
  ].join("\n");
}

export function multiAiAttemptGroup(attemptId: string): { baseAttemptId: string; role: "claude" | "codex" } | undefined {
  if (attemptId.endsWith("-claude")) return { baseAttemptId: attemptId.slice(0, -"-claude".length), role: "claude" };
  if (attemptId.endsWith("-codex")) return { baseAttemptId: attemptId.slice(0, -"-codex".length), role: "codex" };
  return undefined;
}

export function isCompletedMultiAiSibling(payload: Record<string, unknown>, taskId: string, baseAttemptId: string): boolean {
  return payload.taskId === taskId && payload.status === "completed" && (payload.attemptId === baseAttemptId + "-claude" || payload.attemptId === baseAttemptId + "-codex");
}

export function buildMultiAiAuditPrompt(taskId: string, claudePayload: Record<string, unknown>, codexPayload: Record<string, unknown>): string {
  return [
    "HuAI Collab Chatroom System의 다중 AI 협의 결과를 독립 감사하세요.",
    "대상 작업: " + taskId,
    "판정 기준: 두 작업자 결과의 정확성, 상호 일치성, 누락된 실행 조치, 사용자에게 필요한 다음 선택지.",
    "보고: 사람이 알아야 할 결론과 필요한 조치만 간결하게 작성하세요.",
    "금지: 내부 JSON, hook log, stack trace, token, API key, 원문 시크릿 출력.",
    "",
    "ClaudeBot 결과:",
    summarizePersistedGatewayPayload(claudePayload),
    "",
    "CodexBot 결과:",
    summarizePersistedGatewayPayload(codexPayload)
  ].join("\n");
}

// 다중 AI 감사 프롬프트에 실을 요약. ClaudeBot·CodexBot 둘 다의 결과를 감사에게
// 보여줘야 하는데, 예전에는 extractCodexAgentMessage 만 시도했다 — Claude Code
// stdout(`--output-format json`)은 이 파서가 못 알아보는 형식이라 원본 JSON 한
// 덩어리가 그대로 감사 프롬프트에 실렸다(실측: task d364326a, ClaudeBot 이 실제로는
// 완료했는데 감사가 그 stdout JSON 원문을 보고 "결과가 없어 정확성 평가 불가"라고
// 오판정했다). 두 파서를 다 시도해 어느 엔진의 출력이든 사람이 읽는 문장으로
// 뽑히게 한다 — 형식이 안 맞는 파서는 undefined 를 돌려주므로 순서는 안전하다.
export function summarizePersistedGatewayPayload(payload: Record<string, unknown>): string {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const stdoutTexts = events
    .filter((event) => event && typeof event === "object" && (event as { type?: unknown }).type === "stdout")
    .map((event) => String((event as { text?: unknown }).text ?? ""));
  const otherTexts = events
    .filter((event) => event && typeof event === "object" && (event as { type?: unknown }).type !== "stderr")
    .map((event) => String((event as { text?: unknown }).text ?? ""));
  const texts = (stdoutTexts.length > 0 ? stdoutTexts : otherTexts)
    .map((text) => extractClaudeAgentMessage(text) ?? extractCodexAgentMessage(text) ?? text)
    .map((text) => cleanHumanVisibleOutput(text) ?? "")
    .filter(Boolean);
  return truncate(texts.at(-1) ?? String(payload.errorKind ?? payload.status ?? "결과 요약 없음"), 3200);
}
// 감사가 판정을 내놓지 못한 것을 알아본다.
//
// 종료코드는 0 이어도 실제로는 아무것도 안 본 실행이 있다. CLI 가 권한 때문에 도구를 하나도
// 못 쓴 경우가 그렇고, 그때 남는 것은 "출력 없음" 이라는 안내문뿐이다. 이걸 판정으로 받으면
// inferVerificationVerdict 가 기본값 conditional_pass 를 매겨 근거 없는 보완 요구가 나간다.
export function auditProducedNoVerdict(resultSummary: string): boolean {
  const text = resultSummary.trim();
  if (text.length === 0) return true;
  return /no output produced|auto-denied|cannot prompt for/i.test(text);
}

export function inferVerificationVerdict(summary: string): "pass" | "conditional_pass" | "fail" {
  const lower = summary.toLowerCase();
  if (/실패|불합격|문제 있음|보완 필요|수정 필요|fail|failed|reject/.test(lower)) return "fail";
  if (/조건부|일부|주의|conditional/.test(lower)) return "conditional_pass";
  if (/통과|승인|문제 없음|완료|pass|passed|ok/.test(lower)) return "pass";
  return "conditional_pass";
}
