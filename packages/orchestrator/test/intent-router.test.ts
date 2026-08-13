import assert from "node:assert/strict";
import test from "node:test";
import { classifyFreeformIntent, buildInformationalAnswerText } from "../src/intent-router.js";

test("classifies informational questions without creating work requests", () => {
  assert.equal(classifyFreeformIntent("설명문 관계도 흐름도 여기 채팅장에 띄워 줄 수 있나?"), "informational_answer");
  assert.equal(classifyFreeformIntent("현재 진행 상황 알려줘"), "informational_answer");
});

test("classifies explicit work requests as work", () => {
  assert.equal(classifyFreeformIntent("현재 진행 상황 정리해서 보고서 만들어줘"), "work_request");
  assert.equal(classifyFreeformIntent("오류 수정해"), "work_request");
});

test("classifies acknowledgements without creating work", () => {
  assert.equal(classifyFreeformIntent("고마워"), "acknowledgement");
  assert.equal(classifyFreeformIntent("ok"), "acknowledgement");
});

test("informational answer points users to trace for artifacts", () => {
  const text = buildInformationalAnswerText("설명문 관계도 흐름도 여기 채팅장에 띄워 줄 수 있나?");
  assert.match(text, /가능합니다/);
  assert.equal(text.includes("/trace <task_id>"), true);
});

