// index.ts 에서 뽑아낸 AI 엔진 폴백 판정/선택 로직. 순수 함수(I/O 없음).
import { isLeaderPlanningAttempt } from "../../orchestrator/src/index.js";
import { AI_ADAPTER_TYPES, type AiAdapterType, type ExecutionRequest, type GatewayEvent } from "../../contracts/src/index.js";
import { collectedArtifactsFromEvents } from "./message-rendering.js";

// \uC138\uC158 \uAE30\uB85D\uC6A9 \uD30C\uC77C. \uC791\uC5C5\uC790\uAC00 \uB9CC\uB4E0 \uC0B0\uCD9C\uBB3C\uC774 \uC544\uB2C8\uB77C Claude Code \uD6C5\uC774 \uC790\uAE30 \uC138\uC158\uC744
// \uB0A8\uAE30\uBA74\uC11C \uC0DD\uAE30\uB294 \uBD80\uC0B0\uBB3C\uC774\uB77C, \uC774\uAC78 \uC0B0\uCD9C\uBB3C\uB85C \uC138\uBA74 "\uBA87 \uC904\uC778\uC9C0 \uC870\uC0AC\uD574\uC918" \uAC19\uC740 \uC21C\uC218
// \uC9C8\uC758\uC751\uB2F5\uB3C4 \uD30C\uC77C\uC744 \uBC14\uAFBC \uAC83\uCC98\uB7FC \uBCF4\uC778\uB2E4(\uB77C\uC774\uBE0C\uC5D0\uC11C README \uC904 \uC218 \uC870\uC0AC\uC5D0 3\uAC74 \uC7A1\uD614\uB2E4).
const BOOKKEEPING_ARTIFACT_PATTERN = /(^|[\\/])sessions([\\/]|$)/i;

// 폴백마다 이 접미사를 attemptId에 붙여 몇 번째 넘김인지 센다(fallbackHopCount).
export const FALLBACK_ATTEMPT_SUFFIX = "-fallback";

// 엔진이 셋이므로 넘기기는 최대 세 번이다 — 세 엔진이 모두 한 번씩 기회를 갖고
// (2번), 그래도 다 막히면 처음 엔진으로 한 바퀴 더 돈다(3번, PO 요청 2026-08-24).
//
// 처음엔 한 번뿐이었다: Claude 가 막히고 Codex 도 막히자 Antigravity 가 멀쩡한데도
// 작업이 거기서 끝났다 — 남은 엔진이 있는데 멈추는 것은 폴백을 붙인 이유를 스스로
// 지운다(그래서 2로 올렸다). 이후 "셋 다 막혔었어도 그새 풀렸을 수 있다"는 이유로
// 한 바퀴 더(3)로 다시 올렸다. 상한이 있어야 하는 이유는 그대로다: 계속 넘기면
// 방만 시끄럽고 아무것도 안 된다 — 그래서 무한이 아니라 딱 한 바퀴만 더다.
export const MAX_FALLBACK_HOPS = 3;

export function fallbackHopCount(attemptId: string): number {
  return attemptId.split(FALLBACK_ATTEMPT_SUFFIX).length - 1;
}

// 이미 시도한 엔진을 빼고 다음을 고른다. 두 번째 넘길 때 첫 번째로 막힌 엔진을 다시
// 고르면 같은 실패를 반복한다.
//
// 고정된 배열 순서(claude_code→codex→antigravity)로 고르면 코덱스가 막혔을 때 항상
// 클로드부터 가고, 안티그래비티는 클로드까지 막혀야만 차례가 온다 — "코덱스가 막히면
// 안티그래비티로" 라는 실제 기대(라이브 확인 후 PO 지적)와 어긋난다. 그래서 막힌
// 엔진의 "다음 자리"부터 순환한다 — 방금 막힌 엔진 바로 뒤가 다음 후보다.
//
// 세 엔진을 한 바퀴 다 돌아 더 이상 안 써본 엔진이 없으면(PO 요청, 2026-08-24),
// 처음 엔진부터 한 번 더 돈다 — 무한 반복이 아니라 딱 한 바퀴만 더다. 상한은
// MAX_FALLBACK_HOPS(호출부 shouldFallbackToOtherEngine)가 막으므로 여기서는 "다시
// 돌 수 있는 엔진이 있는가"만 본다.
export function nextEngineAfterTried(
  tried: readonly AiAdapterType[],
  workerAdapterType?: AiAdapterType
): AiAdapterType | undefined {
  const blocked = tried[tried.length - 1];
  const blockedIndex = AI_ADAPTER_TYPES.indexOf(blocked);
  const rotated = blockedIndex === -1
    ? AI_ADAPTER_TYPES
    : [...AI_ADAPTER_TYPES.slice(blockedIndex + 1), ...AI_ADAPTER_TYPES.slice(0, blockedIndex + 1)];
  const remaining = rotated.filter((engine) => !tried.includes(engine));
  const candidates = remaining.length > 0 ? remaining : rotated;
  const independent = candidates.filter((engine) => engine !== workerAdapterType);
  return independent[0] ?? candidates[0];
}

// 막힌 엔진 다음으로 넘길 엔진을 고른다.
//
// 엔진이 셋(claude_code · codex · antigravity)이므로, 감사가 막혔을 때도 작업자와 다른
// 엔진이 하나 더 남는다. 둘뿐이던 때는 Codex 가 막히면 Claude 가 자기 일을 검사할 수밖에
// 없었다 — 그건 독립 검증이 아니다.
//
// workerAdapterType 은 그 작업을 실제로 한 엔진이다(감사일 때만 의미가 있다).
// 그 엔진은 뒤로 미뤄, 남는 게 그것뿐일 때만 쓴다.
export function nextEngineAfter(
  blocked: AiAdapterType,
  workerAdapterType?: AiAdapterType
): AiAdapterType {
  const candidates = AI_ADAPTER_TYPES.filter((engine) => engine !== blocked);
  const independent = candidates.filter((engine) => engine !== workerAdapterType);
  return independent[0] ?? candidates[0] ?? blocked;
}

// 방에 올리는 이름. 사람은 adapterType 을 읽지 않는다.
// 어느 봇 이름으로 방에 보고할지. 실제로 일한 엔진과 맞아야 한다.
export function reportBotRoleForAdapter(adapterType: AiAdapterType): "claude_leader" | "codex_leader" {
  // antigravity 는 아직 자기 봇이 없다. 방에 나가는 문구는 engineActorName 이 정확히
  // 밝히므로(AntigravityBot), 발신 봇만 claude_leader 를 빌려 쓴다.
  return adapterType === "codex" ? "codex_leader" : "claude_leader";
}

export function engineActorName(adapterType: AiAdapterType): string {
  if (adapterType === "codex") return "CodexBot";
  if (adapterType === "gemini_web" || adapterType === "antigravity") return "GeminiWeb";
  return "ClaudeBot";
}

export function shouldFallbackToOtherEngine(
  request: ExecutionRequest,
  errorKind: string | undefined,
  resultSummary: string
): boolean {
  if (fallbackHopCount(request.attemptId) >= MAX_FALLBACK_HOPS) return false;
  // 리더 판단은 방장 지시를 해석하는 단계라 엔진을 바꾸면 결과가 달라진다.
  // 여기서 넘기지 않고 실패를 그대로 보고해, 방장이 다시 말하게 한다.
  if (isLeaderPlanningAttempt(request.attemptId)) return false;

  const combined = `${errorKind ?? ""}\n${resultSummary}`;
  // resource-exhausted / too many requests 는 Antigravity 쪽 표현이다. 이게 없으면 그 엔진이
  // 막혀도 폴백이 안 걸리고 작업이 거기서 끝난다.
  return /agent-usage-limit|chatgpt\.com\/codex\/settings|hit your (?:session |usage |weekly )?limit|usage limit|session limit|weekly limit|quota exceeded|limit reached|too many requests|resource[- ]exhausted/i.test(combined);
}

export function producedRealArtifacts(events: readonly GatewayEvent[]): boolean {
  return realArtifactPaths(events).length > 0;
}

export function realArtifactPaths(events: readonly GatewayEvent[]): string[] {
  return collectedArtifactsFromEvents(events)
    .map((artifact) => String(artifact.path ?? artifact.uri ?? ""))
    .filter((location) => location.length > 0 && !BOOKKEEPING_ARTIFACT_PATTERN.test(location));
}
