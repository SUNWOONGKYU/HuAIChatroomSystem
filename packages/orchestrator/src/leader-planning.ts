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

export type LeaderDecision =
  | { kind: "plan"; plan: LeaderPlan }
  // 질문이면 작업으로 만들지 않고 소대장이 직접 답한다.
  // 이 갈래가 없으면 "질문인가 작업인가"를 다시 키워드 표가 정하게 된다.
  | { kind: "answer"; text: string }
  // 사람끼리 상의 중이라 나설 자리가 아닌 경우.
  | { kind: "no_action"; reason: string };

const ASSIGNEES = ["claude_leader", "codex_leader", "both"] as const;

// 소대장이 방에 대해 이미 알고 있어야 하는 것.
//
// 이것이 없으면 소대장은 백지 세션이라 "이 방에 봇이 몇 개야?" 같은 질문에도
// "확인해서 보고하겠습니다" 하고 조사 작업을 만든다 — 방장은 답을 원했는데 작업이 하나 생긴다.
export type RoomFacts = {
  bots: readonly string[];
  memberCount: number;
  openTasks: readonly { title: string; status: string }[];
};

export function buildLeaderPlanningPrompt(input: {
  turns: readonly RoomTurn[];
  triggeringText: string;
  facts?: RoomFacts;
}): string {
  const transcript = input.turns.length === 0
    ? "(직전 논의 없음 — 아래 요청만 보고 판단하라)"
    : input.turns.map((turn) => `[${turn.isOwner ? "방장" : turn.speaker}] ${turn.text}`).join("\n");

  const facts = input.facts;
  const factLines = facts
    ? [
        "--- 네가 이미 아는 이 방의 정보 ---",
        `이 방의 AI 봇 ${facts.bots.length}개: ${facts.bots.join(", ")}`,
        `사람 참여자 ${facts.memberCount}명 (승인 권한은 방장에게만 있다)`,
        facts.openTasks.length === 0
          ? "진행 중인 작업 없음"
          : `진행 중인 작업 ${facts.openTasks.length}건: ${facts.openTasks.map((task) => `${task.title}(${task.status})`).join(" / ")}`,
        "이 정보로 답할 수 있는 질문에는 조사 작업을 만들지 말고 그냥 답하라.",
        "--- 정보 끝 ---",
        ""
      ]
    : [];

  return [
    "너는 Telegram 프로젝트방의 소대장이다. 방에는 사람 여럿과 역할별 AI 봇이 함께 있다.",
    "",
    ...factLines,
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
    "판단 순서:",
    "1) 위 방 정보나 대화 내용만으로 답할 수 있으면 작업을 만들지 말고 그냥 답하라.",
    "   방장이 답을 원한 질문에 조사 작업을 만들면, 원하지도 않은 일이 하나 생기는 것이다.",
    "2) 코드·파일·실행 결과를 실제로 열어봐야만 알 수 있는 것만 작업으로 만들어라.",
    "",
    "아래 형식으로만 답하라. 앞뒤 설명·코드펜스 금지. 값은 한 줄로 쓴다.",
    "",
    "작업으로 만들 때:",
    "DECISION: plan",
    "TITLE: <작업명>",
    "PURPOSE: <목적>",
    "SCOPE: <범위 — 논의에서 나온 항목을 빠짐없이>",
    "DONE: <완료 조건 — 검증자가 합격/불합격을 판정할 기준>",
    "ASSIGNEE: claude_leader 또는 codex_leader 또는 both",
    "REASON: <그 담당을 고른 이유>",
    "",
    "질문이거나 설명을 구하는 것이면:",
    "DECISION: answer",
    "ANSWER: <답변>",
    "",
    "사람끼리 상의 중이라 네가 나설 자리가 아니면:",
    "DECISION: none",
    "REASON: <사유>"
  ].join("\n");
}

// LLM 출력은 신뢰할 수 없다.
//
// 처음에는 JSON 으로 받았는데 실전에서 모델이 여는 따옴표를 빠뜨려
// (`"scope":"...",completionCriteria":"..."`) 판단이 통째로 유실됐다.
// 한글 산문을 JSON 문자열에 담으면 따옴표·이스케이프가 깨지기 쉽다.
// 그래서 줄 단위 `KEY: 값` 을 1차 형식으로 쓰고, JSON 은 하위호환으로만 남긴다.
export function parseLeaderDecision(raw: string): LeaderDecision | undefined {
  return parseLineFormat(raw) ?? parseJsonFormat(raw);
}

function parseLineFormat(raw: string): LeaderDecision | undefined {
  const fields = new Map<string, string>();
  let currentKey: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(DECISION|TITLE|PURPOSE|SCOPE|DONE|ASSIGNEE|REASON|ANSWER)\s*:\s*(.*)$/i.exec(line);
    if (match) {
      currentKey = match[1].toUpperCase();
      fields.set(currentKey, match[2].trim());
      continue;
    }
    // 값이 여러 줄에 걸친 경우 이어 붙인다.
    if (currentKey && line.trim()) fields.set(currentKey, `${fields.get(currentKey) ?? ""} ${line.trim()}`.trim());
  }

  const decision = (fields.get("DECISION") ?? "").toLowerCase();
  if (!decision) return undefined;

  if (decision.startsWith("answer")) {
    const answer = fields.get("ANSWER");
    return answer ? { kind: "answer", text: answer } : undefined;
  }
  if (decision.startsWith("none") || decision.startsWith("no")) {
    return { kind: "no_action", reason: fields.get("REASON") || "소대장이 나설 단계가 아니라고 판단했습니다." };
  }
  if (!decision.startsWith("plan")) return undefined;

  const title = fields.get("TITLE");
  const scope = fields.get("SCOPE");
  const completionCriteria = fields.get("DONE");
  if (!title || !scope || !completionCriteria) return undefined;

  const assigneeRaw = (fields.get("ASSIGNEE") ?? "").toLowerCase();
  const assignee = ASSIGNEES.find((candidate) => assigneeRaw.includes(candidate)) ?? (assigneeRaw.includes("both") ? "both" : "codex_leader");
  return {
    kind: "plan",
    plan: {
      title,
      purpose: fields.get("PURPOSE") || title,
      scope,
      completionCriteria,
      assignee,
      reason: fields.get("REASON") ?? ""
    }
  };
}

function parseJsonFormat(raw: string): LeaderDecision | undefined {
  const json = extractJsonObject(raw);
  if (!json) return undefined;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const answer = text(parsed.answer);
  if (answer) return { kind: "answer", text: answer };

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
