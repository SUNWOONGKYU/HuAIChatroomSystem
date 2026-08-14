// 소대장의 판단 계층.
//
// 지금까지 소대장 자리에는 정규식이 앉아 있었다 — 키워드 표로 제목을 고르고
// 사용자 문장을 그대로 scope 에 복사했다. 그래서 "복붙 제안"이 나왔고,
// 사람들이 나눈 논의는 애초에 읽히지도 않았다.
//
// 여기서 하는 일은 대화 맥락을 LLM 에게 넘겨 "작업 계획"으로 재구성하게 하는 것이다.
// 실행은 local-gateway 의 Claude/Codex CLI 구독을 그대로 쓴다 (추가 과금 없음).

export type RoomTurn = {
  speaker: string;
  text: string;
  isOwner: boolean;
};

export type LeaderPlan = {
  title: string;
  purpose: string;
  scope: string;
  completionCriteria: string;
  assignee: "claude_leader" | "codex_leader" | "both";
  reason: string;
};

// 소대장이 나설 자리가 아니라고 판단한 경우.
export type LeaderDecision =
  | { kind: "plan"; plan: LeaderPlan }
  | { kind: "no_action"; reason: string };

const ASSIGNEES = ["claude_leader", "codex_leader", "both"] as const;

export function buildLeaderPlanningPrompt(input: {
  turns: readonly RoomTurn[];
  triggeringText: string;
}): string {
  const transcript = input.turns.length === 0
    ? "(직전 논의 없음 — 아래 요청만 보고 판단하라)"
    : input.turns.map((turn) => `[${turn.isOwner ? "방장" : turn.speaker}] ${turn.text}`).join("\n");

  return [
    "너는 Telegram 프로젝트방의 소대장이다. 방에는 사람 여럿과 역할별 AI 봇이 함께 있다.",
    "아래는 방에서 사람들이 나눈 최근 논의다. 마지막에 너를 부른 요청이 있다.",
    "",
    "--- 대화 ---",
    transcript,
    `[요청] ${input.triggeringText}`,
    "--- 대화 끝 ---",
    "",
    "이 논의를 하나의 작업으로 재구성하라. 사람이 한 말을 복사하지 말고 실제 작업 계획으로 다시 써라.",
    "논의 중에 나온 항목을 빠뜨리지 마라 — 여러 사람이 각각 지적한 것을 모두 범위에 담아라.",
    "",
    "담당 후보:",
    "- claude_leader (Claude Code): 코드 읽기·분석·리팩터링·문서",
    "- codex_leader (Codex): 구현·수정·테스트·디버깅",
    "- 둘 다 필요하면 both",
    "",
    "작업으로 만들 것이 아니라고 판단되면(사람끼리 상의 중이거나 단순 질문이면)",
    'noAction 에 사유를 넣고 나머지는 비워라.',
    "",
    "반드시 아래 JSON 하나만 출력하라. 설명 금지, 코드펜스 금지.",
    '{"noAction":"","title":"","purpose":"","scope":"","completionCriteria":"","assignee":"claude_leader|codex_leader|both","reason":""}'
  ].join("\n");
}

// LLM 출력은 신뢰할 수 없다. 코드펜스·앞뒤 설명이 붙어도 살려내고,
// 형태가 어긋나면 조용히 통과시키지 말고 실패로 돌려준다.
export function parseLeaderDecision(raw: string): LeaderDecision | undefined {
  const json = extractJsonObject(raw);
  if (!json) return undefined;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const noAction = text(parsed.noAction);
  if (noAction) return { kind: "no_action", reason: noAction };

  const title = text(parsed.title);
  const purpose = text(parsed.purpose);
  const scope = text(parsed.scope);
  const completionCriteria = text(parsed.completionCriteria);
  if (!title || !scope || !completionCriteria) return undefined;

  const assignee = ASSIGNEES.find((candidate) => candidate === parsed.assignee) ?? "codex_leader";
  return {
    kind: "plan",
    plan: {
      title,
      purpose: purpose || title,
      scope,
      completionCriteria,
      assignee,
      reason: text(parsed.reason) ?? ""
    }
  };
}

function extractJsonObject(raw: string): string | undefined {
  const withoutFence = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return withoutFence.slice(start, end + 1);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// 소대장이 배분한 담당에 따라 실제로 몇 개의 실행을 띄울지 정한다.
export function executionRolesForAssignee(assignee: LeaderPlan["assignee"]): Array<"claude_leader" | "codex_leader"> {
  if (assignee === "both") return ["claude_leader", "codex_leader"];
  return [assignee];
}
