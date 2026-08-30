// index.ts 에서 뽑아낸 게이트웨이 실행 결과 → 사람이 읽을 텍스트 렌더링/정제. 순수 함수(I/O 없음).
import { maskTelegramSensitiveText as maskSensitiveText } from "../../telegram-ui/src/sanitize.js";
import { type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";
import { engineActorName } from "./engine-fallback.js";
import { stripTaskQuizBlock } from "./task-quiz.js";

// renderAutomaticAuditRequestText \uB294 \uC81C\uAC70\uD588\uB2E4. \uBC29\uC7A5\uC5D0\uAC8C "\uAC80\uC99D\uD574 \uB4DC\uB9B4\uAE4C\uC694"\uB97C \uBB3B\uACE0
// \uBC84\uD2BC\uC744 \uBD99\uC774\uB358 \uBA54\uC2DC\uC9C0\uC778\uB370, \uC774\uC81C \uD30C\uC77C\uC744 \uBC14\uAFBC \uC791\uC5C5\uC740 \uBB3B\uC9C0 \uC54A\uACE0 \uBC14\uB85C \uAC10\uC0AC\uAC00 \uB3C8\uB2E4.
// \uB0A8\uACA8\uB450\uBA74 \uB2E4\uC74C \uC0AC\uB78C\uC774 \uB2E4\uC2DC \uBD99\uC5EC \uACB0\uC815 \uCC3D\uAD6C\uAC00 \uBC29\uACFC \uC791\uC5C5\uD310\uC73C\uB85C \uAC08\uB77C\uC9C4\uB2E4.


export function renderGatewayReportText(input: {
  request: ExecutionRequest;
  status: "completed" | "failed" | "rejected";
  events: GatewayEvent[];
  errorKind?: string;
}): string {
  // \uAC10\uC0AC\uB294 \uC791\uC5C5\uC774 \uC544\uB2C8\uB2E4. \uB458\uC744 \uAC19\uC740 \uBB38\uAD6C\uB85C \uBCF4\uACE0\uD558\uBA74 \uAC10\uC0AC\uAC00 \uC2E4\uD328\uD588\uC744 \uB54C \uBC29\uC7A5\uC774 \uC791\uC5C5\uC774
  // \uC2E4\uD328\uD55C \uC904 \uC548\uB2E4 \u2014 \uB77C\uC774\uBE0C\uC5D0\uC11C \uC2E4\uC81C\uB85C \uADF8\uB807\uAC8C \uC77D\uD614\uB2E4(\uC791\uC5C5\uC740 \uC131\uACF5, \uAC10\uC0AC\uB9CC \uD55C\uB3C4\uB85C \uC8FD\uC74C).
  const isAudit = input.request.reportBotRole === "auditor";
  // \uBC29\uC7A5\uC774 \uC2E4\uC81C\uB85C \uC5B4\uB290 \uC5D4\uC9C4\uC774 \uC77C\uD588\uB294\uC9C0 \uBA54\uC2DC\uC9C0 \uC790\uCCB4\uC5D0\uC11C \uC54C \uC218 \uC788\uC5B4\uC57C \uD55C\uB2E4. \uBC1C\uC2E0 \uBD07
  // \uC774\uB984(ClaudeBot/CodexBot)\uB9CC\uC73C\uB85C\uB294 \uC548\uD2F0\uADF8\uB798\uBE44\uD2F0 \uD3F4\uBC31\uC744 \uAD6C\uBD84\uD560 \uC218 \uC5C6\uB2E4 \u2014 \uC548\uD2F0\uADF8\uB798\uBE44\uD2F0\uB294
  // \uC544\uC9C1 \uC790\uAE30 \uBD07\uC774 \uC5C6\uC5B4 ClaudeBot \uC774\uB984\uC744 \uBE4C\uB824 \uBCF4\uB0B4\uBBC0\uB85C(engineActorName\u00B7reportBotRoleForAdapter
  // \uCC38\uACE0), \uC2E4\uC81C \uC2E4\uD589 \uC5D4\uC9C4\uC744 \uBCF8\uBB38\uC5D0 \uC9C1\uC811 \uBC1D\uD78C\uB2E4(\uB77C\uC774\uBE0C \uD655\uC778 \uD6C4 PO \uC9C0\uC801, 2026-08-23).
  // engineActorName 은 "ClaudeBot"/"CodexBot"/"AntigravityBot" 처럼 텔레그램 봇 이름
  // 형태를 돌려준다 — 안티그래비티는 실제로 등록된 봇이 아닌데(ClaudeBot 이름을 빌려
  // 발신) "AntigravityBot" 이라고 쓰면 방장이 없는 봇으로 착각한다(PO 지적,
  // 2026-08-23). 여기서는 순수 엔진 이름만 쓴다 — "봇" 접미어를 뗀다.
  const engineLabel = "(엔진: " + engineActorName(input.request.adapterType).replace(/Bot$/, "") + ")";
  const subject = isAudit ? "\uAC10\uC0AC \uC2E4\uD589" : "\uC791\uC5C5 \uC2E4\uD589";

  if (input.status === "completed") {
    const summary = summarizeGatewayOutput(input.events);
    const lines = summary
      ? [subject + " \uC644\uB8CC " + engineLabel, "\uACB0\uACFC:", summary]
      : [subject + " \uC644\uB8CC " + engineLabel + "."];
    const collectionFailure = input.events.find(
      (event): event is Extract<GatewayEvent, { type: "artifact_collection_failed" }> =>
        event.type === "artifact_collection_failed"
    );
    if (collectionFailure) {
      lines.push("\uC8FC\uC758: \uC0B0\uCD9C\uBB3C \uC218\uC9D1\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. \uC791\uC5C5 \uACB0\uACFC\uB294 \uC815\uC0C1\uC774\uC9C0\uB9CC \uC0B0\uCD9C\uBB3C \uC774\uB825\uC774 \uB0A8\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
    }
    return lines.join("\n");
  }

  const outputSummary = summarizeGatewayOutput(input.events);
  const reason = humanReadableGatewayError(input.errorKind ?? outputSummary ?? "failed", gatewayFailureEvidence(input.events) || outputSummary, input.request.adapterType);
  return [
    subject + " \uC2E4\uD328 " + engineLabel,
    "\uC6D0\uC778: " + reason,
    isAudit
      // \uAC10\uC0AC\uAC00 \uC8FD\uC5C8\uC5B4\uB3C4 \uC791\uC5C5 \uACB0\uACFC\uB294 \uADF8\uB300\uB85C \uC788\uB2E4. \uBC29\uC7A5\uC774 \uBB34\uC5C7\uC744 \uC783\uC5C8\uB294\uC9C0 \uC54C\uC544\uC57C \uC2B9\uC778 \uC5EC\uBD80\uB97C
      // \uD310\uB2E8\uD560 \uC218 \uC788\uB2E4 \u2014 \uC783\uC740 \uAC83\uC740 \uC791\uC5C5\uC774 \uC544\uB2C8\uB77C \uB3C5\uB9BD \uAC80\uC99D\uC774\uB2E4.
      ? "\uC791\uC5C5 \uACB0\uACFC \uC790\uCCB4\uB294 \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4. \uAC80\uC99D \uC5C6\uC774 \uC2B9\uC778\uD560\uC9C0, \uB2E4\uC2DC \uAC80\uC99D\uD560\uC9C0 \uC815\uD574 \uC8FC\uC138\uC694."
      : "\uD544\uC694\uD558\uBA74 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uAC70\uB098 \uC791\uC5C5\uC790 \uBCF4\uC644\uC744 \uC694\uCCAD\uD574 \uC8FC\uC138\uC694."
  ].join("\n");
}
// 실패를 판정할 때 쓰는 원본 출력. 사람이 읽을 문장으로 정제하기 전의 것이다.
//
// CLI 가 한도·인증 같은 사정을 알리는 자리는 사람이 읽을 문장이 아니라 JSON 줄인 경우가
// 많다. 정제본은 그 줄을 버리므로, 무엇이 왜 실패했는지 기계가 판정할 때는 여기를 본다.
export function gatewayFailureEvidence(events: readonly GatewayEvent[]): string {
  return events
    .map((event) => {
      if ((event.type === "stdout" || event.type === "stderr") && "text" in event) return event.text;
      if (event.type === "failed" && "errorKind" in event) return event.errorKind;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function summarizeGatewayOutput(events: GatewayEvent[]): string | undefined {
  const stdout = [...events].reverse().find((event): event is GatewayEvent & { type: "stdout"; text: string } =>
    event.type === "stdout" && typeof event.text === "string" && event.text.trim().length > 0
  );
  const stderr = [...events].reverse().find((event): event is GatewayEvent & { type: "stderr"; text: string } =>
    event.type === "stderr" && typeof event.text === "string" && event.text.trim().length > 0
  );
  const text = stdout?.text ?? stderr?.text;
  if (!text) return undefined;
  const visible = cleanHumanVisibleOutput(extractAgentResultText(text));
  return visible ? maskSensitiveText(visible) : undefined;
}

// 두 엔진 출력의 겉포장을 벗겨 사람이 볼(또는 파서가 읽을) 실제 텍스트만 남긴다.
// codex 는 JSONL 스트림(agent_message), claude 는 --output-format json 통짜 객체
// (result 필드) — 어느 쪽도 아니면(과거 텍스트 모드 등) 원본을 그대로 돌려준다.
// Telegram 보고문 요약과 리더 판단(DECISION: 줄 파싱) 둘 다 이 함수로 겉포장을
// 벗긴 뒤 처리한다 — 벗기지 않으면 파서가 JSON 이스케이프된 \n 뒤에 숨은
// "DECISION: plan" 을 못 찾는다(실전에서 실제로 이 증상이 났다).
export function extractAgentResultText(text: string): string {
  return extractCodexAgentMessage(text) ?? extractClaudeAgentMessage(text) ?? text;
}


export function cleanHumanVisibleOutput(text: string): string | undefined {
  // QUIZ 블록은 방장 이해도 확인용 데이터지 방에 보일 문장이 아니다 — 줄 단위 필터
  // 이전에 통째로 잘라낸다(JSON 내부 줄이 isInternalOutputLine 에 우연히 안 걸려도
  // 새어나가지 않게, 그리고 길이 절단이 블록 중간을 자르는 것도 막게).
  const withoutQuiz = stripTaskQuizBlock(text);
  const lines = withoutQuiz
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isInternalOutputLine(line))
    .filter((line) => !isLowValueHumanLine(line));
  const summarized = compactHumanVisibleLines(lines);
  return summarized || undefined;
}

// 사람이 볼 본문을 만든다. 내부 잡음(isInternalOutputLine·isLowValueHumanLine)은 이미
// 걸러진 뒤라, 여기 남은 줄은 전부 작업자가 사람에게 하려던 말이다.
//
// 예전에는 "결론·판정·조치·완료" 같은 단어표로 중요한 줄을 골라내고 나머지를 버렸다.
// 그게 정확히 답을 지웠다 — 라이브에서 ClaudeBot 이
//   README.md 줄 수: **86줄**
//   근거: `wc -l README.md` 실행 결과 `86 README.md`.
//   후속 조치: 불필요. 단순 조사 요청이라 완료.
// 를 냈는데, 방에는 마지막 줄만 갔다("조치"·"완료"가 표에 있어서다). 답에는 그런
// 관료적 단어가 안 들어가므로 단어표는 답을 골라내는 게 아니라 답을 떨어뜨린다.
//
// 그래서 고르지 않는다. 작업자가 쓴 순서 그대로 두고 길이로만 자른다 — 답은 보통
// 맨 앞에 오므로, 잘리더라도 사라지는 건 꼬리지 답이 아니다.
// 보고가 잘리는 지점.
//
// 예전 값 3200 은 "한 메시지에 담자"로 정한 것인데, 전송 쪽에는 이미 분할이 있다
// (apps/bot-service/src/outbox.ts splitTelegramText, 3900자마다 쪼개 여러 메시지로
// 보낸다). 그래서 3200 은 Telegram 의 한계가 아니라 우리가 스스로 버린 양이었다 —
// 방장이 긴 보고를 받으면 뒷부분이 사라졌다.
//
// 완전히 풀지는 않는다. 작업자가 로그를 통째로 뱉으면 방이 그걸로 덮인다. 세 메시지쯤
// 되는 12000자를 상한으로 두고, 넘으면 잘렸다는 사실을 문장으로 알린다 — "..." 만
// 붙으면 뒤에 뭐가 더 있었는지 방장이 알 수 없다.
const HUMAN_VISIBLE_MAX_LENGTH = 12000;

export function compactHumanVisibleLines(lines: string[]): string {
  const joined = lines.join("\n").trim();
  if (joined.length <= HUMAN_VISIBLE_MAX_LENGTH) return joined;
  const kept = joined.slice(0, HUMAN_VISIBLE_MAX_LENGTH).trimEnd();
  return `${kept}\n\n(보고가 길어 여기까지만 표시했습니다. 전체는 /trace 로 확인해 주세요.)`;
}

// \uC0AC\uB78C\uC5D0\uAC8C \uBCF4\uC77C \uAC12\uC774 \uC5C6\uB294 \uC904\uB9CC \uAC78\uB7EC\uB0B8\uB2E4.
//
// \uC5EC\uAE30 \uC788\uB358 \uADDC\uCE59 \uB300\uBD80\uBD84\uC774 \uB2F5\uC744 \uC9C0\uC6B0\uACE0 \uC788\uC5C8\uB2E4. \uB3C5\uB9BD \uAC80\uC99D(Codex)\uC774 \uC9DA\uC740 \uADF8\uB300\uB85C\uB2E4:
//   /^\|/          \uD45C \uD55C \uC904\uC529 \u2014 \uBE44\uAD50 \uACB0\uACFC\uB294 \uD45C\uB85C \uC624\uB294 \uACBD\uC6B0\uAC00 \uB9CE\uB2E4. \uB2F5\uC774 \uD1B5\uC9F8\uB85C \uC0AC\uB77C\uC9C4\uB2E4
//   /^#{1,6}\s/    \uC81C\uBAA9 \u2014 "## \uACB0\uB860" \uAC19\uC740 \uC904\uC774 \uC5C6\uC5B4\uC838 \uBCF8\uBB38 \uAD6C\uC870\uAC00 \uBB34\uB108\uC9C4\uB2E4
//   /^[A-Z_]+:/    \uB300\uBB38\uC790 \uC811\uB450\uC5B4 \u2014 DEBUG/INFO \uB958\uB294 isInternalOutputLine \uC774 \uC774\uBBF8 \uC7A1\uB294\uB2E4.
//                  \uC5EC\uAE30 \uB0A8\uC73C\uBA74 "API:", "SQL:" \uAC19\uC740 \uC815\uC0C1 \uB2F5\uAE4C\uC9C0 \uC9C0\uC6B4\uB2E4
//   \uD83D\uDCC1 \uD83D\uDCC4          \uC774 \uD504\uB85C\uC81D\uD2B8\uAC00 \uD30C\uC77C \uACBD\uB85C\uB97C \uD45C\uAE30\uD558\uB77C\uACE0 \uC815\uD574\uB454 \uAE30\uD638\uB2E4. \uADF8 \uC904\uC774 \uACE7 \uB2F5\uC774\uB2E4
//   "\uC624\uCC28 \uBC94\uC704" \uB4F1  \uCE21\uC815 \uACB0\uACFC\uB97C \uB9D0\uD558\uB294 \uC815\uC0C1 \uBB38\uC7A5\uACFC \uAD6C\uBD84\uB418\uC9C0 \uC54A\uB294\uB2E4
//
// \uC624\uB298 \uAC19\uC740 \uC885\uB958\uC758 \uD544\uD130\uAC00 \uC138 \uBC88 \uB2F5\uC744 \uC9C0\uC6E0\uB2E4(\uC911\uC694 \uB2E8\uC5B4\uD45C, \uD655\uC7A5\uC790 \uBAA9\uB85D, \uADF8\uB9AC\uACE0 \uC774\uAC83).
// \uAD6C\uC870\uC801 \uC7A1\uC74C(JSON\u00B7\uB85C\uADF8\u00B7\uC2A4\uD0DD\uD504\uB808\uC784\u00B7\uD6C5)\uC740 isInternalOutputLine \uC774 \uC774\uBBF8 \uAC77\uC5B4\uB0B8\uB2E4.
// \uC5EC\uAE30 \uB0A8\uAE38 \uAC83\uC740 \uADF8\uAC83\uC73C\uB85C\uB3C4 \uC548 \uAC78\uB9AC\uB294, \uAC12\uC774 \uD655\uC2E4\uD788 \uC5C6\uB294 \uB450 \uAC00\uC9C0\uBFD0\uC774\uB2E4.
export function isLowValueHumanLine(line: string): boolean {
  return (
    // \uB0B4\uC6A9 \uC5C6\uB294 \uBAA9\uB85D \uAE30\uD638 \uD55C \uAE00\uC790
    /^[-*]\s*$/.test(line) ||
    // \uC904 \uC804\uCCB4\uAC00 \uACBD\uB85C\uBFD0 \u2014 \uD30C\uC77C \uB098\uC5F4, \uBE4C\uB4DC \uC0B0\uCD9C\uBB3C \uB364\uD504
    isBarePathLine(line)
  );
}

// 줄 전체가 경로 하나인 것만 잡는다 — 파일 목록, 빌드 산출물 나열 같은 것들이다.
//
// 예전에는 /node_modules|dist\/|\.json|\.ts|\.js/ 로 "그 문자열이 어디든 들어 있으면"
// 버렸다. 그래서 답이 파일 이름을 언급하는 순간 통째로 사라졌다 — 라이브에서
// ClaudeBot 이 낸
//   조사 결과: `package.json` name 필드 값 = `"hu-ai-chatroom-system"`.
//   근거: `<프로젝트 루트>\package.json` 2번째 줄 직접 읽음.
// 두 줄이 `.json` 때문에 버려지고 방에는 "결과:" 만 갔다. 소프트웨어 작업에서
// 답이 파일 이름을 말하는 건 정상이고, 오히려 그게 답의 핵심인 경우가 많다.
//
// 문장 안에 파일 이름이 나오는 것과 줄이 경로 그 자체인 것을 가르는 기준은 공백이다.
// 스택프레임·JSON·로그 줄은 여기가 아니라 isInternalOutputLine 이 이미 걸러낸다.
export function isBarePathLine(line: string): boolean {
  return /^[^\s]+$/.test(line) && /[\\/]/.test(line);
}
export function isInternalOutputLine(line: string): boolean {
  return (
    /^```/.test(line) ||
    line.startsWith("{") ||
    line.startsWith("[") ||
    /^[}\]],?$/.test(line) ||
    /^"[^"\r\n]+"\s*:/.test(line) ||
    /^at\s+\S+\s+\(.+?:\d+:\d+\)$/i.test(line) ||
    /^(?:\d{4}-\d{2}-\d{2}[T\s]\S+\s+)?(?:DEBUG|INFO|WARN|ERROR|TRACE)\b/i.test(line) ||
    /^(?:stdout|stderr|stack|trace|payload|rawOutput)\s*[:=]/i.test(line) ||
    /^Session(Start|End) hook/i.test(line) ||
    /^Hook\s/i.test(line) ||
    /^\[DEBUG\]/i.test(line) ||
    /^\[INFO\]/i.test(line) ||
    /^Skill descriptions were shortened/i.test(line) ||
    /^clamping SessionEnd hook timeout/i.test(line) ||
    /^Assertion failed:/i.test(line) ||
    /^Node\.js v/i.test(line) ||
    /^EXECUTION\s+(COMPLETED|FAILED|REJECTED)\s*:?$/i.test(line) ||
    /^(OUTPUT|ERROR|STDOUT|STDERR)\s*:?$/i.test(line)
  );
}
export function humanReadableGatewayError(error: string, outputSummary?: string, adapterType = "codex"): string {
  const masked = maskSensitiveText(error);
  const combined = masked + (outputSummary ? "\n" + outputSummary : "");
  if (/gemini-web-cdp-unavailable/i.test(combined)) return "Gemini 웹 연결 실패: 전용 Chrome CDP(9222)가 실행 중인지 확인해 주세요.";
  if (/gemini-web-login-required/i.test(combined)) return "Gemini 웹 로그인 필요: 전용 자동화 Chrome에서 Gemini에 직접 로그인해 주세요.";
  if (/gemini-web-submit-failed/i.test(combined)) return "Gemini 웹 제출 실패: 프롬프트가 전송되지 않았습니다.";
  if (/gemini-web-response-timeout/i.test(combined)) return "Gemini 웹 응답 시간 초과: 새 응답을 받지 못했습니다.";
  if (/gemini-web-new-response-missing/i.test(combined)) return "Gemini 웹 신규 응답 없음: 이전 답변을 결과로 인정하지 않았습니다.";
  if (/gemini-web-session-failed/i.test(combined)) return "Gemini 웹 세션 오류: 웹 자동화 결과를 확정하지 못했습니다.";
  if (adapterType === "claude_code" && /agent-usage-limit|hit your (?:session |usage |weekly )?limit|usage limit|session limit|weekly limit|rate limit|limit reached|resets?\s+(?:at\s+)?\d/i.test(combined)) {
    return "ClaudeBot 현재 상태: 사용 한도 초과. Claude Code 한도가 초기화된 뒤 다시 시도하거나 CodexBot으로 작업해야 합니다.";
  }
  // Codex 한도도 사람 말로 옮긴다.
  //
  // 한도 초과는 exit code 1 로 끝나므로 아래 exit-code 분기에 걸려 "실행 중 오류가
  // 발생했습니다" 로만 나갔다. 라이브에서 감사가 그렇게 실패했고, 방에서는 우리 코드가
  // 잘못된 것처럼 보였다. 한도는 기다리면 풀리고 오류는 고쳐야 하므로 조치가 완전히
  // 다르다 — 그 둘을 같은 문장으로 덮으면 안 된다.
  //
  // ClaudeBot 쪽은 이미 이렇게 옮기고 있었다. Codex 쪽만 빠져 있었다.
  if (adapterType === "codex" && /chatgpt\.com\/codex\/settings|agent-usage-limit|hit your (?:session |usage |weekly )?limit|usage limit|quota exceeded/i.test(combined)) {
    return "CodexBot 현재 상태: 사용 한도 초과. 한도가 초기화된 뒤 다시 시도하거나 ClaudeBot으로 작업해야 합니다.";
  }
  // 세 번째 엔진도 자기 한도에 걸린다. 안 알아보면 그냥 "실행 중 오류"로 끝나고 폴백도
  // 안 걸린다 — 남은 두 엔진이 멀쩡한데 작업이 거기서 멈춘다.
  if ((adapterType === "antigravity" || adapterType === "gemini_web") && /usage limit|quota|rate limit|too many requests|limit reached|resource[- ]exhausted/i.test(combined)) {
    return "Gemini 웹 현재 상태: 사용 한도 또는 요청 제한입니다. 다른 엔진으로 작업해야 합니다.";
  }
  if (/BUTTON_DATA_INVALID/i.test(masked)) return "텔레그램 버튼 데이터가 너무 길어 전송이 실패했습니다.";
  if (/process-timeout/i.test(masked)) return "작업 시간이 초과되었습니다.";
  if (/spawn .*ENOENT/i.test(masked)) return "실행 프로그램을 찾지 못했습니다.";
  if (/agent-tool-error|codex_core::tools::router|An empty pipe element|timeout_ms must be at least 10000/i.test(combined)) {
    return "CodexBot 내부 명령 실행이 실패해 결과를 확정하지 못했습니다. 작업 범위를 좁혀 다시 시도해 주세요.";
  }
  if (/agent-write-blocked|read-only sandbox|workspace is read-only|writing is blocked|patch rejected/i.test(combined)) {
    return "작업자가 승인된 폴더에 쓰지 못했습니다. 로컬 게이트웨이 권한과 프로젝트 폴더 연결을 확인해 주세요.";
  }
  if (/exit-code-\d+/i.test(masked)) return "실행 중 오류가 발생했습니다.";
  return "실행 중 내부 오류가 발생했습니다. 상세 로그는 운영 기록에서 확인해 주세요.";
}
export function extractCodexAgentMessage(text: string): string | undefined {
  let latest: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: string; item?: { type?: string; text?: unknown }; text?: unknown };
      if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
        latest = parsed.item.text;
      } else if (parsed.type === "agent_message" && typeof parsed.text === "string") {
        latest = parsed.text;
      }
    } catch {
      continue;
    }
  }
  return latest;
}
// claude --print --output-format json 은 codex 와 달리 JSONL 스트림이 아니라
// 통째로 하나의 JSON 객체를 돌려준다(실측: {"type":"result","result":"<사람이 볼 답>",
// "session_id":"...",...}). 앞뒤에 다른 줄이 섞여 있을 수 있으니 "{"로 시작하는
// 통짜 JSON을 찾아 파싱한다 — 못 찾거나 형식이 다르면 undefined 로 원본 텍스트 표시로 폴백한다.
export function extractClaudeAgentMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { type?: string; result?: unknown };
    if (parsed.type === "result" && typeof parsed.result === "string") return parsed.result;
  } catch {
    return undefined;
  }
  return undefined;
}
