export type InlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export function buildCommandHelp(): string {
  return [
    "사용 가능한 명령:",
    "/newtask 작업 제안 생성",
    "/tasks 전체 작업 요약",
    "/task <id> 작업 상세",
    "/search <단어> 작업 검색",
    "/trace <id> 작업 이력",
    "/approve <id> 승인",
    "/reject <id> 반려",
    "/verify <id> 검증 요청",
    "/done <id> 최종 승인 요청/처리",
    "/cancel <id> 취소 요청",
    "/help 사용법"
  ].join("\n");
}

export function buildProposalKeyboard(proposalId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "실행", callback_data: `proposal:${proposalId}:approve` },
        { text: "수정", callback_data: `proposal:${proposalId}:revise` },
        { text: "반려", callback_data: `proposal:${proposalId}:reject` }
      ]
    ]
  };
}

export function buildTaskDecisionKeyboard(taskId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "승인", callback_data: `task:${taskId}:approve` },
        { text: "반려", callback_data: `task:${taskId}:reject` },
        { text: "취소", callback_data: `task:${taskId}:cancel` }
      ]
    ]
  };
}

export function buildCompletionKeyboard(taskId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "검증", callback_data: `task:${taskId}:rv` },
        { text: "보완", callback_data: `task:${taskId}:rr` },
        { text: "완료", callback_data: `task:${taskId}:fa` }
      ]
    ]
  };
}

export function buildProjectStatusMessage(input: {
  title: string;
  activeTasks: number;
  pendingApprovals: number;
  gatewayOnline: boolean;
}): string {
  return [
    `프로젝트: ${input.title}`,
    `진행 작업: ${input.activeTasks}`,
    `승인 대기: ${input.pendingApprovals}`,
    `로컬 게이트웨이: ${input.gatewayOnline ? "온라인" : "오프라인"}`
  ].join("\n");
}

export type WorkProposalMessageInput = {
  kind: "new_task" | "task_followup" | "multi_ai_review";
  title: string;
};

export function buildWorkProposalMessage(input: WorkProposalMessageInput): string {
  const heading = input.kind === "multi_ai_review" ? "\u0041\u0049 \uD611\uC758 \uC791\uC5C5 \uC81C\uC548" : input.kind === "task_followup" ? "\uD6C4\uC18D \uC791\uC5C5 \uC81C\uC548" : "\uC791\uC5C5 \uC81C\uC548";
  return [
    heading,
    "\uC791\uC5C5: " + input.title,
    "\uCC98\uB9AC: " + (input.kind === "multi_ai_review" ? "ClaudeBot\uACFC CodexBot\uC774 \uAC01\uAC01 \uC758\uACAC\uC744 \uB0B4\uACE0 AuditBot\uC774 \uAC80\uC99D\uD569\uB2C8\uB2E4." : proposalPlanForTitle(input.title)),
    "\uC644\uB8CC: " + (input.kind === "multi_ai_review" ? "\uC758\uACAC \uCC28\uC774\uC640 \uCD5C\uC885 \uAD8C\uACE0\uAC00 \uC0AC\uB78C\uC5D0\uAC8C \uC77D\uAE30 \uC27D\uAC8C \uBCF4\uACE0\uB429\uB2C8\uB2E4." : proposalDoneForTitle(input.title))
  ].join("\n");
}

function proposalPlanForTitle(title: string): string {
  if (title.includes("\uC7A5\uC560") || title.includes("\uC218\uC815")) return "\uC6D0\uC778\uC744 \uD655\uC778\uD558\uACE0 \uD544\uC694\uD55C \uCF54\uB4DC\uC640 \uC124\uC815\uC744 \uBC14\uB85C \uBCF4\uC815\uD569\uB2C8\uB2E4.";
  if (title.includes("\uAC10\uC0AC")) return "\uAC10\uC0AC \uD638\uCD9C \uC870\uAC74\uACFC \uBC84\uD2BC \uD750\uB984\uC744 \uC810\uAC80\uD569\uB2C8\uB2E4.";
  if (title.includes("\uAD8C\uD55C")) return "\uC2E4\uD589 \uC8FC\uCCB4\uBCC4 \uC77D\uAE30/\uC4F0\uAE30 \uAD8C\uD55C\uC744 \uBD84\uB9AC\uD574 \uC801\uC6A9\uD569\uB2C8\uB2E4.";
  if (title.includes("\uBB38\uC11C") || title.includes("\uB2E4\uC774\uC5B4\uADF8\uB7A8")) return "\uD604\uC7AC \uAD6C\uD604 \uC0C1\uD0DC\uC5D0 \uB9DE\uAC8C \uC124\uBA85 \uC790\uB8CC\uB97C \uAC31\uC2E0\uD569\uB2C8\uB2E4.";
  if (title.includes("\uC9C4\uD589") || title.includes("\uC644\uC131\uB3C4")) return "\uC800\uC7A5\uC18C\uC640 \uC6B4\uC601 \uC0C1\uD0DC\uB97C \uD655\uC778\uD574 \uADFC\uAC70 \uC788\uB294 \uC0C1\uD0DC\uB9CC \uBCF4\uACE0\uD569\uB2C8\uB2E4.";
  if (title.includes("\uD14C\uC2A4\uD2B8")) return "\uC2E4\uC81C \uC2E4\uD589 \uACBD\uB85C\uB97C \uD655\uC778\uD558\uACE0 \uACB0\uACFC\uB97C \uC9E7\uAC8C \uBCF4\uACE0\uD569\uB2C8\uB2E4.";
  return "\uC694\uCCAD\uC744 \uC2E4\uD589 \uAC00\uB2A5\uD55C \uC791\uC5C5\uC73C\uB85C \uC815\uB9AC\uD574 \uD544\uC694\uD55C \uC870\uCE58\uB97C \uC218\uD589\uD569\uB2C8\uB2E4.";
}

function proposalDoneForTitle(title: string): string {
  if (title.includes("\uC7A5\uC560") || title.includes("\uC218\uC815")) return "\uC99D\uC0C1\uC774 \uC7AC\uD604\uB418\uC9C0 \uC54A\uACE0 \uAD00\uB828 \uAC80\uC99D\uC774 \uD1B5\uACFC\uD569\uB2C8\uB2E4.";
  if (title.includes("\uAC10\uC0AC")) return "\uBD88\uD544\uC694\uD55C \uAC10\uC0AC\uAC00 \uB728\uC9C0 \uC54A\uACE0 \uC9C1\uC811 \uC694\uCCAD\uB9CC \uCC98\uB9AC\uB429\uB2C8\uB2E4.";
  if (title.includes("\uAD8C\uD55C")) return "\uC791\uC5C5\uC790\uB294 \uC2B9\uC778\uB41C \uD3F4\uB354\uC5D0 \uC4F8 \uC218 \uC788\uACE0 \uAC10\uC0AC\uC790\uB294 \uC77D\uAE30 \uC804\uC6A9\uC785\uB2C8\uB2E4.";
  if (title.includes("\uBB38\uC11C") || title.includes("\uB2E4\uC774\uC5B4\uADF8\uB7A8")) return "\uC124\uBA85\uBB38, \uAD00\uACC4\uB3C4, \uD750\uB984\uB3C4\uAC00 \uCD5C\uC2E0 \uB3D9\uC791\uACFC \uC77C\uCE58\uD569\uB2C8\uB2E4.";
  if (title.includes("\uC9C4\uD589") || title.includes("\uC644\uC131\uB3C4")) return "\uD655\uC778 \uAC00\uB2A5\uD55C \uC0AC\uC2E4\uACFC \uB0A8\uC740 \uC791\uC5C5\uC774 \uAD6C\uBD84\uB418\uC5B4 \uBCF4\uACE0\uB429\uB2C8\uB2E4.";
  if (title.includes("\uD14C\uC2A4\uD2B8")) return "Telegram \uB610\uB294 \uB85C\uCEEC \uAC80\uC99D \uACB0\uACFC\uAC00 \uD655\uC778\uB429\uB2C8\uB2E4.";
  return "\uC2E4\uD589 \uACB0\uACFC\uC640 \uD544\uC694\uD55C \uD6C4\uC18D \uC870\uCE58\uB97C \uC0AC\uB78C\uC774 \uC77D\uAE30 \uC27D\uAC8C \uBCF4\uACE0\uD569\uB2C8\uB2E4.";
}
export { maskTelegramSensitiveText, safeTelegramTraceUri, sanitizeTelegramVisibleText } from "./sanitize.js";
