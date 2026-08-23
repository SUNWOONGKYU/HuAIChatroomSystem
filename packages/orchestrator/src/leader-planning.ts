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
  // "버전 3개 만들어줘" 처럼 명시적으로 여러 변형을 요청했을 때만 2 이상. 기본 1(=변형 없음).
  // 2~4 로 강제 제한한다 — 그 이상은 비용·리소스가 과해서 방장이 정말 원하는지 다시 확인해야 한다.
  variantCount: number;
  // Grok Bot 벤치마크의 "승인 카테고리 분리(필수승인/자동허용)" 반영 — 2026-08-23.
  // 파일을 만들거나 바꾸는 작업(true)만 방장의 시작 승인을 기다린다. 조회·분석·설명처럼
  // 읽기만 하는 작업(false)은 emitLeaderProposal 이 승인 절차 없이 바로 큐에 올린다.
  // LLM 출력이 없거나 해석 불가면 항상 true(승인 필요 쪽)로 떨어뜨린다 — 안전한 기본값은
  // "승인을 놓치는 쪽"이 아니라 "덜 자동화되는 쪽"이다.
  mutatesFiles: boolean;
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
  // 지난 며칠치 방 기억. 최근 40턴 밖의 일을 아는 유일한 통로다.
  //
  // 이게 없으면 소대장은 40턴 창 밖을 아예 모른다 — 3주 전 결정을 되물으면 답을 못 하고,
  // 이미 끝난 작업을 새 작업으로 제안한다(라이브에서 달걀 게임이 그랬다: 진행 중 8건만
  // 보고 판단했고 끝난 작업은 시야에 없었다).
  memory?: readonly { date: string; summary: string }[];
};

// 방에서 부를 수 있는 이름 붙은 페르소나. huai_agent_personas 에 저장돼 있다.
export type AgentPersona = {
  name: string;
  baseRole: "claude_leader" | "codex_leader";
  instructions: string;
};

// "!페르소나이름 지시문" 형태로 시작하는 요청에서 페르소나 이름을 뽑아낸다.
// 실제 페르소나 존재 여부(DB 조회)는 이 함수가 모른다 — store 계층이 이 이름으로
// huai_agent_personas 를 찾아본다. 못 찾으면 그냥 평범한 요청으로 처리된다.
export function extractPersonaTag(text: string): { personaName: string; remainingText: string } | undefined {
  const match = /^!([A-Za-z0-9가-힣_-]{1,32})\s+([\s\S]+)$/.exec(text.trim());
  if (!match) return undefined;
  return { personaName: match[1], remainingText: match[2].trim() };
}

export function buildLeaderPlanningPrompt(input: {
  turns: readonly RoomTurn[];
  triggeringText: string;
  facts?: RoomFacts;
  persona?: AgentPersona;
}): string {
  const transcript = input.turns.length === 0
    ? "(직전 논의 없음 — 아래 요청만 보고 판단하라)"
    : input.turns.map((turn) => `[${turn.isOwner ? "방장" : turn.speaker}] ${turn.text}`).join("\n");

  const persona = input.persona;
  const personaLines = persona
    ? [
        `--- 이 요청은 등록된 페르소나 "${persona.name}"를 지목했다 ---`,
        `이 페르소나가 하는 일: ${persona.instructions}`,
        `이 페르소나의 담당은 ${persona.baseRole}다 — ASSIGNEE 는 반드시 ${persona.baseRole}로 정하라.`,
        "--- 페르소나 지시 끝 ---",
        ""
      ]
    : [];

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

  // 방 기억은 사실 정보와 따로 둔다. 최근 대화(아래)와 섞이면 어느 것이 지금 일어난
  // 일인지 흐려진다 — 오래된 결정을 최근 지시로 착각하면 엉뚱한 작업을 만든다.
  const memoryLines = (input.facts?.memory ?? []).length > 0
    ? [
        "--- 지난 기록 (며칠 전까지의 방 요약) ---",
        ...(input.facts?.memory ?? []).map((entry) => `[${entry.date}]
${entry.summary}`),
        "이미 끝난 일을 새 작업으로 제안하지 마라. 지난 기록에 답이 있으면 그것으로 답하라.",
        // 아래 SCOPE 지시가 "논의에서 나온 항목을 빠짐없이"라고 요구하는데, 지난 기록까지
        // 그 논의로 읽혀 옛 작업이 이번 범위에 딸려 들어갔다(DCF 방에서 지시에 없던
        // README 줄 수 조사가 범위에 붙었다). 기록은 참고이지 할 일 목록이 아니다.
        "지난 기록은 맥락일 뿐이다. 이번 작업의 범위에는 지금 요청에서 나온 것만 담아라.",
        "--- 지난 기록 끝 ---",
        ""
      ]
    : [];

  return [
    "너는 Telegram 프로젝트방의 소대장이다. 방에는 사람 여럿과 역할별 AI 봇이 함께 있다.",
    "",
    ...personaLines,
    ...factLines,
    ...memoryLines,
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
    "변형 개수 판단: 요청이 \"버전 3개\", \"N개 만들어줘\", \"여러 안을 동시에\"처럼 여러 결과물을",
    "명시적으로 원할 때만 VARIANTS 를 2 이상으로 써라. 그 외(보통의 단일 작업)에는 반드시 1이다.",
    "짐작으로 늘리지 마라 — 안 쓴 변형은 그대로 비용과 방 혼선이 된다. 최대 4까지만 허용된다.",
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
    "VARIANTS: <병렬로 만들 변형 개수, 기본 1, 최대 4>",
    "MUTATES: <이 작업이 파일을 새로 만들거나 고치거나 지우면 yes, 코드·문서를 읽고 조회·분석·설명만",
    "  하면(아무것도 안 바꾸면) no. 조금이라도 애매하면 반드시 yes 로 써라 — no 라고 쓰면",
    "  방장 승인 없이 바로 실행된다.>",
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
    const match = /^\s*(DECISION|TITLE|PURPOSE|SCOPE|DONE|ASSIGNEE|REASON|ANSWER|VARIANTS|MUTATES)\s*:\s*(.*)$/i.exec(line);
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
      reason: fields.get("REASON") ?? "",
      variantCount: clampVariantCount(fields.get("VARIANTS")),
      mutatesFiles: parseMutatesFiles(fields.get("MUTATES"))
    }
  };
}

// "no" 라고 명시적으로 쓴 경우만 false — 그 외(비어있음, "yes", 오타, 다른 언어 응답 등)는
// 전부 true. 승인 스킵은 모델이 확신을 갖고 명시했을 때만 일어나야 한다.
function parseMutatesFiles(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() !== "no";
}

// LLM 이 안 쓰거나(기본 1), 숫자가 아니거나, 범위를 벗어나면 안전한 쪽(1=변형 없음)으로
// 떨어뜨린다. 위쪽 한도(4)는 프롬프트로도 못박았지만, 모델이 그걸 무시해도 여기서 막는다 —
// 비용·워크트리 개수 폭주를 코드가 최종 방어선으로 자른다.
function clampVariantCount(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 1) return 1;
  return Math.min(parsed, 4);
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
  const variantCountRaw = typeof parsed.variantCount === "number" ? String(parsed.variantCount) : undefined;
  const mutatesRaw = typeof parsed.mutatesFiles === "boolean" ? (parsed.mutatesFiles ? "yes" : "no") : text(parsed.mutates);
  return {
    kind: "plan",
    plan: {
      title,
      purpose: purpose || title,
      scope,
      completionCriteria,
      assignee,
      reason: text(parsed.reason) ?? "",
      variantCount: clampVariantCount(variantCountRaw),
      mutatesFiles: parseMutatesFiles(mutatesRaw)
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
