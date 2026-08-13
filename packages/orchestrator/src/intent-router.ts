export type FreeformIntent = "acknowledgement" | "informational_answer" | "work_request";

export function classifyFreeformIntent(text: string): FreeformIntent {
  if (isAcknowledgementText(text)) return "acknowledgement";
  return isInformationalQuestionText(text) ? "informational_answer" : "work_request";
}

export function isAcknowledgementText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return /^(고마워|고맙다|감사|감사합니다|오케이|ok|okay|확인|알겠어|알겠습니다)[.!?。！？]*$/i.test(normalized);
}

export function isInformationalQuestionText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (isExplicitWorkRequestText(normalized)) return false;
  return /[?？]$/.test(normalized)
    || /(뭐야|무엇|어떻게|어떡|왜|언제|누구|어디|가능|되나|되냐|되나요|할 수 있나|할 수 있어|알려줘|설명해|정리해줘)/.test(normalized);
}

export function isExplicitWorkRequestText(text: string): boolean {
  return /(수정해|고쳐|적용해|구현해|만들어|업데이트해|현행화|실행해|배포해|검증해|테스트해|찾아봐|조사해|진행해|처리해|연결해|등록해)/.test(text);
}

export function buildInformationalAnswerText(text: string): string {
  if (/(설명문|관계도|흐름도|다이어그램|문서).*(띄워|올려|보여|표시|채팅)/.test(text)) {
    return [
      "가능합니다.",
      "설명문은 Telegram 메시지로 바로 올리고, 관계도·흐름도는 SVG 파일 또는 이미지 링크로 올릴 수 있습니다.",
      "긴 자료는 요약을 먼저 보내고, 원본은 산출물 URI로 연결하는 방식이 적합합니다.",
      "작업 기록과 산출물 위치는 /trace <task_id>로 확인할 수 있습니다."
    ].join("\n");
  }
  return [
    "질문으로 이해했습니다.",
    "설명이나 확인이 필요한 내용이면 바로 답하고, 실제 코드·문서·설정 변경이 필요할 때만 작업 제안을 만들겠습니다.",
    "작업으로 진행하려면 작업으로 진행해 또는 구체적인 실행 지시를 붙여 주세요."
  ].join("\n");
}

export function buildAcknowledgementAnswerText(): string {
  return "확인했습니다.";
}
