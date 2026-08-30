// index.ts 에서 뽑아낸 텔레그램 메시지 렌더링/미리보기/산출물 경로 판정. 순수 함수(I/O 없음).
import { maskTelegramSensitiveText as maskSensitiveText, safeTelegramTraceUri } from "../../telegram-ui/src/sanitize.js";
import {
  type ArtifactManifest,
  type ExecutionRequest,
  type GatewayEvent,
  type TelegramSendResult
} from "../../contracts/src/index.js";
import { LEADER_PLANNING_ATTEMPT_PREFIX } from "../../orchestrator/src/index.js";
import { type LeaderPlan } from "../../orchestrator/src/leader-planning.js";
import { type WorkflowContext } from "../../workflow/src/index.js";
import { isUuid } from "./small-utils.js";

// 게이트웨이 결과 경로는 사람 행위자가 없다. 시스템 기본 맥락에서 출발하고
// 호출부가 실제 역할(검증자 등)을 덮어쓴다.
export function gatewaySystemContext(): WorkflowContext {
  return {
    actorRole: "system",
    isOwner: false,
    isAssignee: false,
    isVerifier: false,
    hasOwnerTaskApproval: true,
    hasVerificationPass: false,
    hasCommanderCompletionDecision: false,
    hasOwnerFinalApproval: false,
    idempotencyKey: "gateway"
  };
}

// 리더가 정리한 작업을 방장이 읽고 판단할 수 있는 형태로 보여준다.
// 내부 상태나 실행 로그는 넣지 않는다 (FR-005).
export function renderLeaderPlanMessage(plan: LeaderPlan): string {
  const assigneeLabel = plan.assignee === "both"
    ? "ClaudeBot + CodexBot"
    : plan.assignee === "claude_leader" ? "ClaudeBot" : "CodexBot";
  return [
    // 📥 접수 → 📋 제안 → ⚙️ 작업 중. 같은 자리에 같은 아이콘이 오면 방장이 흐름의
    // 어디쯤인지 문장을 읽지 않고도 안다.
    // Grok Bot 벤치마크 "승인 카테고리 분리" 반영 — 파일을 안 바꾸는 조회성 작업은
    // 승인 버튼을 기다리지 않고 바로 큐에 올라간다(emitLeaderProposal 참고). 방장이
    // "왜 안 눌렀는데 시작됐지" 하고 당황하지 않도록 그 사실을 여기서 먼저 알린다.
    // === false 로 엄격 비교한다 — undefined(예: 이 필드를 아직 안 채워 넘기는 옛 호출부)를
    // 자동허용으로 잘못 읽으면 안 되므로, 명시적으로 false 일 때만 자동허용 문구를 쓴다.
    plan.mutatesFiles === false
      ? "🟢 조회성 작업(파일 변경 없음)으로 판단해 승인 없이 자동 시작합니다. 막거나 고칠 게 있으면 아래 버튼을 쓰세요."
      : "📋 작업 제안입니다. 승인하시면 바로 시작합니다.",
    "",
    plan.title,
    "",
    "목적: " + plan.purpose,
    "범위: " + plan.scope,
    "완료 조건: " + plan.completionCriteria,
    "담당: " + assigneeLabel + (plan.reason ? " (" + plan.reason + ")" : "")
  ].join("\n");
}

// Telegram inline keyboard 의 callback_data 는 64바이트가 한계다.
// "proposal:<id>:approve" 로 실려 나가므로 id 는 40바이트 안쪽으로 유지한다.
export const MAX_TELEGRAM_CALLBACK_BYTES = 64;

export function shortProposalId(attemptId: string): string {
  const raw = attemptId.replace(LEADER_PLANNING_ATTEMPT_PREFIX, "").replace(/^planning_/, "");
  // uuid 의 앞 두 마디, 즉 64비트만 쓴다. 이 id 는 애초에 room 으로 스코프되지 않고
  // 시스템 전체에서 조회된다(entity_ref 조회에 room_id 필터가 없다). 20개 방을
  // 동시에 운영해도 생일 역설 기준 50% 충돌 확률에 도달하려면 대략 50억 건의
  // proposal 이 쌓여야 하므로, 방 개수가 늘어도 이 트렁케이션은 여전히 안전하다.
  const compact = raw.replace(/-/g, "").slice(0, 16);
  return "p_" + compact;
}

// 표시용 정리를 거치지 않은 원본 stdout. 리더 판단 JSON 을 잃지 않으려면 필요하다.
export function rawStdoutFromGatewayEvents(events: readonly GatewayEvent[]): string {
  return events
    .filter((event): event is GatewayEvent & { type: "stdout"; text: string } => event.type === "stdout" && typeof event.text === "string")
    .map((event) => event.text)
    .join("\n");
}

// claude --output-format json 은 session_id 를 돌려준다. codex --json 은 --json
// 필드 이름이 다르다 — `{"type":"thread.started","thread_id":"..."}` (실측 확인,
// codex exec --json 실제 호출 결과). 리더(leader)은 기본 어댑터가 codex 라서
// thread_id 를 못 잡으면 세션이 한 번도 저장되지 않는다 — 실제로 라이브 방들의
// cli_session_id 가 전부 null 이었다.
//
// claude_code 쪽은 이 저장소가 --output-format text(평문)로 부르고 있어 session_id 가
// 애초에 stdout 에 안 실린다 — 그건 이 함수가 아니라 호출 플래그를 바꿔야 하는
// 별도 문제라 여기서는 건드리지 않는다.
export function sessionIdFromGatewayEvents(events: readonly GatewayEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "stdout" || typeof event.text !== "string") continue;
    const match = event.text.match(/"(?:session_id|thread_id)"\s*:\s*"([0-9a-fA-F-]{16,})"/);
    if (match) return match[1];
  }
  return undefined;
}

export function renderRevisionRequestText(taskId: string, requiredFixes: string, reverifyScope: string): string {
  return [
    "검증 결과 보완이 필요합니다.",
    "작업: " + taskId,
    "",
    "필수 수정:",
    maskSensitiveText(requiredFixes).slice(0, 1500),
    "",
    "재검증 범위: " + reverifyScope,
    "보완 후 다시 검증을 요청해 주세요."
  ].join("\n");
}

export type MidApprovalRequest = {
  reportId: string;
  approvalRequestId: string;
  summary: string;
  significanceReason: string;
  affectedTaskIds: string[];
};

const MID_APPROVAL_BLOCK = /MID_APPROVAL_START\s*([\s\S]*?)\s*MID_APPROVAL_END/;

export function parseMidApprovalRequestFromEvents(events: readonly GatewayEvent[]): MidApprovalRequest | undefined {
  const text = rawStdoutFromGatewayEvents(events);
  const match = MID_APPROVAL_BLOCK.exec(text);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1] ?? "") as Record<string, unknown>;
    const affectedTaskIds = Array.isArray(value.affectedTaskIds)
      ? value.affectedTaskIds.filter((item): item is string => typeof item === "string" && isUuid(item))
      : [];
    if (
      typeof value.reportId !== "string" || !isUuid(value.reportId) ||
      typeof value.approvalRequestId !== "string" || !value.approvalRequestId.trim() ||
      typeof value.summary !== "string" || !value.summary.trim() ||
      typeof value.significanceReason !== "string" || !value.significanceReason.trim()
    ) return undefined;
    return {
      reportId: value.reportId,
      approvalRequestId: value.approvalRequestId.trim(),
      summary: value.summary.trim(),
      significanceReason: value.significanceReason.trim(),
      affectedTaskIds: Array.from(new Set(affectedTaskIds))
    };
  } catch {
    return undefined;
  }
}

export function classifyRevisionChangedScope(reason: string): "format_only" | "content" {
  const changedScopeValue = reason.trim().toLowerCase();
  return /(?:format(?:ting)?|cosmetic|typo|whitespace|형식|서식|오탈자|띄어쓰기)/i.test(changedScopeValue)
    ? "format_only"
    : "content";
}

export function collectedArtifactsFromEvents(events: readonly GatewayEvent[]): ArtifactManifest[] {
  const byKey = new Map<string, ArtifactManifest>();
  for (const event of events) {
    if (event.type !== "artifact_collected") continue;
    const artifact = event.artifact;
    if (!artifact || typeof artifact.path !== "string" || typeof artifact.version !== "string") continue;
    byKey.set(`${artifact.uri ?? artifact.path}::${artifact.version}`, artifact);
  }
  return [...byKey.values()];
}

// 텔레그램 봇이 올릴 수 있는 최대 크기. 넘으면 API 가 거절한다.
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

// 방에 그대로 보낼 최대 길이. 이보다 길면 앞부분만 보내고 전문은 현황판에서 읽는다.
//
// 텔레그램은 3900자마다 잘라 여러 통으로 보내주지만, 그러면 감사 보고 하나가 화면 여러
// 장을 채우고 방의 다른 대화가 통째로 밀려난다. 방장이 폰에서 읽는다는 것을 전제로 잡은 값.
// 감사 프롬프트에 실을 반복 지적의 범위. 며칠치를 보고, 몇 줄까지 넣나.
// 많이 넣으면 감사가 그 목록 확인만 하다 끝난다.
export const AUDIT_MEMORY_DAYS = 7;
export const AUDIT_MEMORY_MAX_ITEMS = 8;

export const DEFAULT_ROOM_MESSAGE_PREVIEW_CHARS = 300;

// "전문 보기" 버튼. 현황판을 그 보고 화면으로 바로 연다.
//
// 딥링크 파라미터는 [A-Za-z0-9_-] 1-64자만 허용된다. report_id 는 표준 UUID(36자)라
// 그대로 실어도 한도 안이고, 방 id 를 같이 실을 필요가 없다 — 현황판이 그 id 로 방을
// 되찾아 멤버인지 확인한다.
export function buildReportOpenKeyboard(reportId: string, directLinkBaseUrl?: string): unknown {
  if (!directLinkBaseUrl) return undefined;
  const separator = directLinkBaseUrl.includes("?") ? "&" : "?";
  // r_ 접두어로 방 id 와 구분한다. 둘 다 UUID 라 값만 보고는 어느 쪽인지 알 수 없다.
  return {
    inline_keyboard: [[{ text: "전문 보기", url: `${directLinkBaseUrl}${separator}startapp=r_${encodeURIComponent(reportId)}` }]]
  };
}

export function roomMessagePreviewLimit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.HUAI_ROOM_MESSAGE_PREVIEW_CHARS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_ROOM_MESSAGE_PREVIEW_CHARS;
}

// 문장·줄 단위로 자른다. 표나 코드블록 한가운데서 끊기면 방에 깨진 문서가 남는다.
export function previewRoomMessage(body: string, limit: number): { text: string; truncated: boolean } {
  const trimmed = body.trim();
  if (trimmed.length <= limit) return { text: trimmed, truncated: false };

  const slice = trimmed.slice(0, limit);
  const boundary = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(". "), slice.lastIndexOf("다. "));
  const cut = boundary > limit * 0.5 ? boundary : limit;
  return { text: trimmed.slice(0, cut).trimEnd(), truncated: true };
}

// 방에 나갈 문장. 잘렸으면 전문이 얼마나 되는지 밝힌다 — 얼마를 못 보고 있는지 모르면
// 버튼을 누를 이유도 모른다.
export function buildRoomMessageWithPreview(body: string, limit: number): { text: string; truncated: boolean } {
  const preview = previewRoomMessage(body, limit);
  if (!preview.truncated) return preview;
  return { text: `${preview.text}

…(전문 ${body.trim().length.toLocaleString("ko-KR")}자)`, truncated: true };
}

// 방에 파일로 전달할 산출물인가.
//
// 웹 산출물은 배포해서 링크로 연다(게이트웨이가 이미 올린다). 소스 코드·설정은 결과물이
// 아니라 작업 그 자체라 방에 뿌리면 잡음이 된다 — 방장이 받아볼 문서만 고른다.
const DELIVERABLE_DOCUMENT_PATTERN = /\.(hwpx?|docx?|xlsx?|pptx?|pdf|csv|zip|png|jpe?g|mp4)$/i;

// 작업자가 스스로 테스트하며 남긴 부산물. 방장에게 보낼 결과물이 아니다.
//
// 라이브에서 달걀 게임 작업이 끝나자 방에 올라온 파일이 egg-game-broken.png 였다 —
// 헤드리스 브라우저로 확인하며 찍은 디버그 스크린샷이다. 결과물이라고 내밀 것이 아니다.
const WORKING_ARTIFACT_PATTERN = /(^|[\/])(\.[^\/]+|node_modules|dist|coverage)([\/]|$)|-(broken|debug|before|after|temp|tmp)\.[a-z0-9]+$|\.(test|spec)\.[a-z0-9]+$/i;

export function isDeliverableDocument(filePath: string): boolean {
  const path = filePath.split(/[?#]/)[0] ?? filePath;
  if (WORKING_ARTIFACT_PATTERN.test(path)) return false;
  return DELIVERABLE_DOCUMENT_PATTERN.test(path);
}

// 이 PC 안의 실제 경로. file:// URI 로 기록된 것을 되돌린다.
export function localArtifactPath(artifact: ArtifactManifest, request: ExecutionRequest): string | undefined {
  const uri = artifact.uri;
  if (!uri) return `${request.projectPath}/${artifact.path}`;
  if (!uri.startsWith("file:///")) return undefined;
  try {
    return decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
  } catch {
    return undefined;
  }
}

export function artifactUri(artifact: ArtifactManifest, request: ExecutionRequest): string {
  return safeTelegramTraceUri(artifact.uri ?? `${request.projectPath}/${artifact.path}`);
}

export function summarizeSupabaseSendResult(result: TelegramSendResult): Record<string, unknown> {
  return { telegramMessageId: result.telegramMessageId };
}
