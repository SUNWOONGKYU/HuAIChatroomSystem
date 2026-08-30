// index.ts 에서 뽑아낸 작업 완료 퀴즈(QUIZ_START/QUIZ_END 블록) 파싱. 순수 함수.
import { type GatewayEvent } from "../../contracts/src/index.js";
import { extractAgentResultText } from "./gateway-report-rendering.js";

export type TaskQuizQuestion = { q: string; choices: [string, string, string, string]; correct: 0 | 1 | 2 | 3 };
export type TaskQuiz = { summary: string; questions: [TaskQuizQuestion, TaskQuizQuestion, TaskQuizQuestion] };

const QUIZ_BLOCK_PATTERN = /QUIZ_START([\s\S]*?)QUIZ_END/;

export function stripTaskQuizBlock(text: string): string {
  return text.replace(QUIZ_BLOCK_PATTERN, "").trim();
}

// 완료 이벤트의 원본(겉포장 벗긴, 정제 전) 텍스트에서 QUIZ_START/QUIZ_END 블록을 찾아
// 파싱한다. cleanHumanVisibleOutput 이 쓰는 것과 별개의 원본 경로를 쓴다 — 정제된
// 텍스트는 줄 필터·길이 절단을 거쳐 블록이 훼손됐을 수 있어서다(appendQuizInstruction,
// apps/bot-service/src/supabase-store.ts 가 이 형식으로 출력하라고 요청한다).
export function extractTaskQuizFromEvents(events: readonly GatewayEvent[]): TaskQuiz | undefined {
  const stdout = [...events].reverse().find((event): event is GatewayEvent & { type: "stdout"; text: string } =>
    event.type === "stdout" && typeof event.text === "string" && event.text.trim().length > 0
  );
  const stderr = [...events].reverse().find((event): event is GatewayEvent & { type: "stderr"; text: string } =>
    event.type === "stderr" && typeof event.text === "string" && event.text.trim().length > 0
  );
  const text = stdout?.text ?? stderr?.text;
  if (!text) return undefined;
  return parseTaskQuizBlock(extractAgentResultText(text));
}

export function parseTaskQuizBlock(text: string): TaskQuiz | undefined {
  const match = QUIZ_BLOCK_PATTERN.exec(text);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return undefined;
  }
  return isValidTaskQuiz(parsed) ? parsed : undefined;
}

export function isValidTaskQuiz(value: unknown): value is TaskQuiz {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.summary !== "string" || !candidate.summary.trim()) return false;
  if (!Array.isArray(candidate.questions) || candidate.questions.length !== 3) return false;
  return candidate.questions.every((question) => {
    if (!question || typeof question !== "object") return false;
    const q = question as Record<string, unknown>;
    if (typeof q.q !== "string" || !q.q.trim()) return false;
    if (!Array.isArray(q.choices) || q.choices.length !== 4) return false;
    if (!q.choices.every((choice) => typeof choice === "string" && choice.trim())) return false;
    return typeof q.correct === "number" && Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 3;
  });
}
