import assert from "node:assert/strict";
import test from "node:test";
import { extractTaskQuizFromEvents, parseTaskQuizBlock } from "../src/index.js";
import { type GatewayEvent } from "../../contracts/src/index.js";

const VALID_QUIZ = {
  summary: "index.ts에 로그인 체크를 추가했습니다.",
  questions: [
    { q: "무엇을 추가했나요?", choices: ["로그인 체크", "삭제 로직", "캐시", "알림"], correct: 0 },
    { q: "왜 필요했나요?", choices: ["보안", "속도", "디자인", "비용"], correct: 1 },
    { q: "영향받는 파일은?", choices: ["index.ts", "README.md", "없음", "전체"], correct: 0 }
  ]
};

test("parseTaskQuizBlock 은 QUIZ_START/QUIZ_END 사이의 유효한 JSON을 파싱한다", () => {
  const text = ["안녕하세요.", "QUIZ_START", JSON.stringify(VALID_QUIZ), "QUIZ_END", "끝."].join("\n");
  const quiz = parseTaskQuizBlock(text);
  assert.deepEqual(quiz, VALID_QUIZ);
});

test("parseTaskQuizBlock 은 마커가 없으면 undefined", () => {
  assert.equal(parseTaskQuizBlock("그냥 평범한 보고문입니다."), undefined);
});

test("parseTaskQuizBlock 은 깨진 JSON이면 undefined (전체 실행을 실패시키지 않는다)", () => {
  const text = ["QUIZ_START", "{ not valid json", "QUIZ_END"].join("\n");
  assert.equal(parseTaskQuizBlock(text), undefined);
});

test("parseTaskQuizBlock 은 문항이 3개가 아니면 undefined", () => {
  const broken = { ...VALID_QUIZ, questions: VALID_QUIZ.questions.slice(0, 2) };
  const text = ["QUIZ_START", JSON.stringify(broken), "QUIZ_END"].join("\n");
  assert.equal(parseTaskQuizBlock(text), undefined);
});

test("parseTaskQuizBlock 은 선택지가 4개가 아니면 undefined", () => {
  const broken = {
    ...VALID_QUIZ,
    questions: [
      { q: "q1", choices: ["a", "b", "c"], correct: 0 },
      VALID_QUIZ.questions[1],
      VALID_QUIZ.questions[2]
    ]
  };
  const text = ["QUIZ_START", JSON.stringify(broken), "QUIZ_END"].join("\n");
  assert.equal(parseTaskQuizBlock(text), undefined);
});

test("parseTaskQuizBlock 은 correct 가 0~3 범위를 벗어나면 undefined", () => {
  const broken = {
    ...VALID_QUIZ,
    questions: [{ ...VALID_QUIZ.questions[0], correct: 4 }, VALID_QUIZ.questions[1], VALID_QUIZ.questions[2]]
  };
  const text = ["QUIZ_START", JSON.stringify(broken), "QUIZ_END"].join("\n");
  assert.equal(parseTaskQuizBlock(text), undefined);
});

test("extractTaskQuizFromEvents 는 codex JSONL agent_message 안의 QUIZ 블록도 찾는다", () => {
  const quizText = ["완료했습니다.", "QUIZ_START", JSON.stringify(VALID_QUIZ), "QUIZ_END"].join("\n");
  const events: GatewayEvent[] = [
    { type: "accepted", taskId: "t1", attemptId: "a1" },
    { type: "stdout", taskId: "t1", attemptId: "a1", text: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: quizText } }) }
  ];
  assert.deepEqual(extractTaskQuizFromEvents(events), VALID_QUIZ);
});

test("extractTaskQuizFromEvents 는 claude --output-format json 통짜 객체 안의 QUIZ 블록도 찾는다", () => {
  const quizText = ["완료했습니다.", "QUIZ_START", JSON.stringify(VALID_QUIZ), "QUIZ_END"].join("\n");
  const events: GatewayEvent[] = [
    { type: "stdout", taskId: "t1", attemptId: "a1", text: JSON.stringify({ type: "result", result: quizText }) }
  ];
  assert.deepEqual(extractTaskQuizFromEvents(events), VALID_QUIZ);
});

test("extractTaskQuizFromEvents 는 QUIZ 블록이 없으면 undefined", () => {
  const events: GatewayEvent[] = [{ type: "stdout", taskId: "t1", attemptId: "a1", text: "그냥 완료했습니다." }];
  assert.equal(extractTaskQuizFromEvents(events), undefined);
});

test("extractTaskQuizFromEvents 는 stdout이 없으면 undefined", () => {
  assert.equal(extractTaskQuizFromEvents([]), undefined);
});
