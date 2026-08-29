import assert from "node:assert/strict";
import test from "node:test";
import { assertExecutionRequestPayload, isAiAdapterType } from "../src/index.js";

const legacyRequest = {
  roomId: "room-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  actorId: "actor-1",
  requestedBy: "user-1",
  adapterType: "antigravity",
  workerAdapterType: "antigravity",
  triedAdapterTypes: ["antigravity"],
  projectPath: "C:\\repo",
  prompt: "기존 작업",
  timeoutMs: 60_000,
  idempotencyKey: "idem-1",
  createdAt: "2026-08-27T00:00:00.000Z"
};

test("legacy antigravity execution payload is accepted and normalized to gemini_web", () => {
  assert.equal(isAiAdapterType("antigravity"), true);
  const request = assertExecutionRequestPayload(legacyRequest);
  assert.equal(request.adapterType, "gemini_web");
  assert.equal(request.workerAdapterType, "gemini_web");
  assert.deepEqual(request.triedAdapterTypes, ["gemini_web"]);
});
