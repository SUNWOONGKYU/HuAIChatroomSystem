import assert from "node:assert/strict";
import test from "node:test";
import { FakeBotServiceStore } from "../../bot-service/src/fake-store.js";
import {
  createArtifactCollector,
  globToRegExp,
  matchesAnyGlob,
  normalizeArtifactPolicy,
  sha256Hex,
  type ArtifactFileEntry,
  type ArtifactFileSystem
} from "../src/artifact-collector.js";
import { runLocalGatewayConsumerOnce } from "../src/consumer.js";
import { executeGatewayRequest } from "../src/executor.js";
import { type ExecutionRequest } from "../../../packages/contracts/src/index.js";

const RUN_STARTED_AT = "2026-08-14T00:00:00.000Z";
const RUN_STARTED_MS = Date.parse(RUN_STARTED_AT);

test("collects only files changed during the attempt and stamps checksum, version, uri", async () => {
  const collector = createArtifactCollector(fakeFileSystem([
    entry("docs/report.md", "결과 보고", RUN_STARTED_MS + 1_000),
    entry("src/changed.ts", "export const a = 1;", RUN_STARTED_MS + 500),
    entry("src/untouched.ts", "old", RUN_STARTED_MS - 60_000)
  ]));

  const artifacts = await collector.collect({ request: makeExecutionRequest(), startedAtMs: RUN_STARTED_MS });

  assert.deepEqual(artifacts.map((artifact) => artifact.path), ["docs/report.md", "src/changed.ts"]);
  assert.equal(artifacts[0].version, "attempt-1");
  assert.equal(artifacts[0].checksum, sha256Hex(new TextEncoder().encode("결과 보고")));
  assert.match(artifacts[0].uri ?? "", /^file:\/\/\//);
  assert.match(artifacts[0].uri ?? "", /docs\/report\.md$/);
});

test("collect globs and max artifact size filter the collected set", async () => {
  const collector = createArtifactCollector(fakeFileSystem([
    entry("docs/report.md", "keep", RUN_STARTED_MS + 10),
    entry("src/skipped.ts", "wrong extension", RUN_STARTED_MS + 10),
    entry("docs/huge.md", "x".repeat(500), RUN_STARTED_MS + 10)
  ]));

  const artifacts = await collector.collect({
    request: makeExecutionRequest({ artifactPolicy: { collectGlobs: ["**/*.md"], maxArtifactBytes: 100 } }),
    startedAtMs: RUN_STARTED_MS
  });

  assert.deepEqual(artifacts.map((artifact) => artifact.path), ["docs/report.md"]);
});

test("glob translation keeps directory boundaries", () => {
  assert.equal(globToRegExp("**/*.md").test("a/b/c.md"), true);
  assert.equal(globToRegExp("**/*.md").test("c.md"), true);
  assert.equal(globToRegExp("*.md").test("a/b.md"), false);
  assert.equal(matchesAnyGlob("src/deep/file.ts", ["**/*.ts"]), true);
  assert.equal(matchesAnyGlob("src/deep/file.ts", ["**/*.md"]), false);
});

test("missing artifact policy falls back to default collect-all policy", () => {
  const policy = normalizeArtifactPolicy(undefined);
  assert.deepEqual(policy.collectGlobs, ["**/*"]);
  assert.equal(policy.maxArtifactBytes > 0, true);
});

test("successful execution emits artifact_collected events before completion", async () => {
  const collector = createArtifactCollector(fakeFileSystem([entry("docs/report.md", "본문", RUN_STARTED_MS + 10)]));
  const published: string[] = [];

  const result = await executeGatewayRequest({
    request: makeExecutionRequest({ projectPath: process.cwd() }),
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 0, stdout: "ok", stderr: "" }; } },
    sink: { async publish(event) { published.push(event.type); } },
    artifacts: collector,
    now: () => RUN_STARTED_AT
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.events.map((event) => event.type), ["accepted", "started", "stdout", "artifact_collected", "completed"]);
  assert.deepEqual(published, ["accepted", "started", "stdout", "artifact_collected", "completed"]);
});

test("failed execution does not collect artifacts", async () => {
  let collectCalls = 0;
  const result = await executeGatewayRequest({
    request: makeExecutionRequest({ projectPath: process.cwd() }),
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 1, stdout: "", stderr: "boom" }; } },
    sink: { async publish() {} },
    artifacts: { async collect() { collectCalls += 1; return []; } },
    now: () => RUN_STARTED_AT
  });

  assert.equal(result.status, "failed");
  assert.equal(collectCalls, 0);
  assert.equal(result.events.some((event) => event.type === "artifact_collected"), false);
});

test("artifact collector failure does not fail the execution", async () => {
  const result = await executeGatewayRequest({
    request: makeExecutionRequest({ projectPath: process.cwd() }),
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 0, stdout: "ok", stderr: "" }; } },
    sink: { async publish() {} },
    artifacts: { async collect() { throw new Error("disk-unavailable"); } },
    now: () => RUN_STARTED_AT
  });

  assert.equal(result.status, "completed");
  assert.equal(result.events.some((event) => event.type === "artifact_collected"), false);
});

test("collected artifacts are persisted once and emit artifact_saved", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd() });
  await seedLocalGatewayOutbox(store, request);
  const collector = createArtifactCollector(fakeFileSystem([
    entry("docs/report.md", "본문", RUN_STARTED_MS + 10),
    entry("src/changed.ts", "export const a = 1;", RUN_STARTED_MS + 20)
  ]));

  await runLocalGatewayConsumerOnce({
    store,
    policy: makePolicy(),
    runner: { async run() { return { exitCode: 0, stdout: "ok", stderr: "" }; } },
    sink: { async publish() {} },
    artifacts: collector,
    limit: 10,
    leaseUntil: "2026-08-14T00:01:00.000Z",
    maxAttempts: 3,
    now: () => RUN_STARTED_AT
  });

  const snapshot = store.snapshot();
  assert.equal(snapshot.artifacts.length, 2);
  assert.equal(snapshot.artifacts[0].taskId, "task-1");
  assert.equal(snapshot.artifacts[0].version, "attempt-1");
  assert.equal(snapshot.artifacts[0].isFinal, false);
  assert.equal(snapshot.artifacts[0].checksum.length, 64);

  const saved = snapshot.events.find((event) => event.eventType === "artifact_saved");
  assert.equal(saved?.idempotencyKey, "artifact-saved:attempt-1");
  assert.equal(saved?.payload.artifactCount, 2);
});

test("re-running the same attempt does not duplicate artifact rows", async () => {
  const store = new FakeBotServiceStore();
  const request = makeExecutionRequest({ projectPath: process.cwd() });
  const collector = createArtifactCollector(fakeFileSystem([entry("docs/report.md", "본문", RUN_STARTED_MS + 10)]));

  for (const round of [1, 2]) {
    await seedLocalGatewayOutbox(store, request, `gateway:${request.attemptId}:${round}`);
    await runLocalGatewayConsumerOnce({
      store,
      policy: makePolicy(),
      runner: { async run() { return { exitCode: 0, stdout: "ok", stderr: "" }; } },
      sink: { async publish() {} },
      artifacts: collector,
      limit: 10,
      leaseUntil: "2026-08-14T00:01:00.000Z",
      maxAttempts: 3,
      now: () => RUN_STARTED_AT
    });
  }

  const snapshot = store.snapshot();
  assert.equal(snapshot.artifacts.length, 1);
  assert.equal(snapshot.events.filter((event) => event.eventType === "artifact_saved").length, 1);
});

function entry(relativePath: string, text: string, modifiedAtMs: number): ArtifactFileEntry {
  const content = new TextEncoder().encode(text);
  return { relativePath, sizeBytes: content.byteLength, modifiedAtMs, content };
}

function fakeFileSystem(entries: readonly ArtifactFileEntry[]): ArtifactFileSystem {
  return {
    async listChangedFiles(_root, sinceMs) {
      return entries.filter((item) => item.modifiedAtMs >= sinceMs);
    }
  };
}

function makeExecutionRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    roomId: "room-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    actorId: "actor-1",
    requestedBy: "2001",
    adapterType: "codex",
    projectPath: process.cwd(),
    prompt: "do work",
    timeoutMs: 30_000,
    idempotencyKey: "exec-1",
    createdAt: RUN_STARTED_AT,
    ...overrides
  };
}

function makePolicy() {
  return {
    allowedProjectRoots: [process.cwd()],
    allowedAdapters: ["codex", "claude_code"] as const,
    maxRuntimeMs: 30_000,
    allowNetwork: false
  };
}

async function seedLocalGatewayOutbox(
  store: FakeBotServiceStore,
  request: ExecutionRequest,
  idempotencyKey = `gateway:${request.attemptId}`
): Promise<void> {
  await store.commitTelegramInputResult({
    message: {
      input: { kind: "message", envelope: undefined as never },
      idempotencyKey: request.idempotencyKey,
      receivedAt: request.createdAt
    },
    result: {
      accepted: true,
      authorization: { allowed: true },
      events: [],
      outbox: [
        {
          target: { kind: "local_gateway", gatewayId: "primary" },
          idempotencyKey,
          payload: { executionRequest: request }
        }
      ]
    }
  });
}
