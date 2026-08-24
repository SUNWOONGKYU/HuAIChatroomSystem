import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TelegramPollingOffsets,
  releaseTelegramWebhooks,
  runTelegramPollingCycle,
  type TelegramPollingBot
} from "../src/polling.js";
import { type BotServiceConfig } from "../src/index.js";

// long polling 은 공개 URL 없이 Telegram 에서 직접 가져오는 방식이다.
// 임시 터널이 끊기면 방 전체가 멎던 문제를 없앤다.

const CHAT = "-1001234567890";
const BOT = "leader_chatroom_bot";

test("사람 메시지를 받아 큐에 넣는다", async () => {
  const ports = makePorts();
  const result = await runTelegramPollingCycle({
    bots: bots(),
    config: config(),
    ports: ports.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: fetchReturning([message(101, "@leader_chatroom_bot 로그인 버그 고쳐줘")]) }
  });

  assert.equal(result.fetched, 1);
  assert.equal(result.queued, 1);
  assert.equal(ports.queued.length, 1);
  assert.equal(ports.queued[0]?.input.kind, "message");
});

test("사람끼리의 대화도 받아서 맥락으로 보관한다", async () => {
  const ports = makePorts();
  const result = await runTelegramPollingCycle({
    bots: bots(),
    config: config(),
    ports: ports.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: fetchReturning([message(102, "결제 실패율이 올라간 것 같아")]) }
  });

  assert.equal(result.queued, 1);
  assert.equal(ports.queued[0]?.input.kind, "observation", "폴링에서도 관찰 분리가 유지되어야 한다");
});

test("허용되지 않은 방은 무시한다", async () => {
  const ports = makePorts();
  const update = message(103, "@leader_chatroom_bot 해줘");
  (update.message as { chat: { id: string } }).chat.id = "-100999";

  const result = await runTelegramPollingCycle({
    bots: bots(),
    config: config(),
    ports: ports.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: fetchReturning([update]) }
  });

  assert.equal(result.ignored, 1);
  assert.equal(result.queued, 0);
});

test("같은 update 가 다시 와도 한 번만 큐에 들어간다", async () => {
  const ports = makePorts();
  const offsets = new TelegramPollingOffsets();
  const update = message(104, "@leader_chatroom_bot 해줘");

  await runTelegramPollingCycle({ bots: bots(), config: config(), ports: ports.ports, offsets, deps: { fetchImpl: fetchReturning([update]) } });
  const second = await runTelegramPollingCycle({ bots: bots(), config: config(), ports: ports.ports, offsets, deps: { fetchImpl: fetchReturning([update]) } });

  assert.equal(second.duplicated, 1);
  assert.equal(ports.queued.length, 1, "재시작으로 offset 을 잃어도 중복 처리되지 않아야 한다");
});

test("offset 이 다음 요청에 실린다", async () => {
  const offsets = new TelegramPollingOffsets();
  const seen: Array<number | undefined> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)).offset);
    return jsonResponse({ ok: true, result: [message(200, "@leader_chatroom_bot 해줘")] });
  };

  const ports = makePorts();
  await runTelegramPollingCycle({ bots: bots(), config: config(), ports: ports.ports, offsets, deps: { fetchImpl } });
  await runTelegramPollingCycle({ bots: bots(), config: config(), ports: ports.ports, offsets, deps: { fetchImpl } });

  assert.equal(seen[0], undefined, "첫 요청에는 offset 이 없다");
  assert.equal(seen[1], 201, "확인한 update 다음부터 받아야 같은 것을 또 받지 않는다");
});

test("깨진 update 하나가 주기 전체를 멈추지 않는다", async () => {
  const ports = makePorts();
  const result = await runTelegramPollingCycle({
    bots: bots(),
    config: config(),
    ports: ports.ports,
    offsets: new TelegramPollingOffsets(),
    deps: { fetchImpl: fetchReturning([{ update_id: 300 }, message(301, "@leader_chatroom_bot 해줘")]) }
  });

  assert.equal(result.ignored, 1);
  assert.equal(result.queued, 1, "앞의 것이 깨져도 뒤의 정상 메시지는 처리되어야 한다");
});

test("주소된 메시지의 사진 첨부는 다운로드해서 raw_update 에 로컬 경로를 남긴다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "huai-attach-test-"));
  try {
    const ports = makePorts();
    const seenFileIds: string[] = [];
    const update = photoMessage(501, "@leader_chatroom_bot 이 화면 참고해서 고쳐줘");

    const result = await runTelegramPollingCycle({
      bots: bots(),
      config: config(),
      ports: ports.ports,
      offsets: new TelegramPollingOffsets(),
      deps: { fetchImpl: fetchWithFileDownload([update], seenFileIds), attachmentsDir: dir }
    });

    assert.equal(result.queued, 1);
    assert.deepEqual(seenFileIds, ["large-file-id"], "여러 해상도 중 가장 큰 것을 받아야 한다");

    const received = ports.recorded.find((r) => r.status === "received");
    const storedMessage = (received?.rawUpdate as { message?: Record<string, unknown> })?.message;
    const attachments = storedMessage?._huaiLocalAttachments as Array<{ path: string; kind: string }> | undefined;
    assert.equal(attachments?.length, 1);
    assert.equal(attachments?.[0]?.kind, "photo");
    assert.ok(existsSync(attachments![0].path), "다운로드한 파일이 실제로 디스크에 있어야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("주소된 메시지의 문서(이미지 아닌 파일) 첨부도 다운로드해서 경로를 남긴다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "huai-attach-test-"));
  try {
    const ports = makePorts();
    const seenFileIds: string[] = [];
    const update = documentMessage(503, "@leader_chatroom_bot 이 문서 참고해서 사업계획서 고쳐줘");

    const result = await runTelegramPollingCycle({
      bots: bots(),
      config: config(),
      ports: ports.ports,
      offsets: new TelegramPollingOffsets(),
      deps: { fetchImpl: fetchWithFileDownload([update], seenFileIds), attachmentsDir: dir }
    });

    assert.equal(result.queued, 1);
    assert.deepEqual(seenFileIds, ["doc-file-id"]);

    const received = ports.recorded.find((r) => r.status === "received");
    const storedMessage = (received?.rawUpdate as { message?: Record<string, unknown> })?.message;
    const attachments = storedMessage?._huaiLocalAttachments as Array<{ path: string; kind: string }> | undefined;
    assert.equal(attachments?.length, 1);
    assert.equal(attachments?.[0]?.kind, "document", "사진이 아니라 문서로 분류돼야 한다");
    assert.ok(existsSync(attachments![0].path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("주소되지 않은(무시된) 메시지의 사진은 내려받지 않는다", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "huai-attach-test-"));
  try {
    const ports = makePorts();
    const update = photoMessage(502, "이 화면 참고해서 고쳐줘"); // 봇 멘션 없음
    (update.message as { chat: { id: string } }).chat.id = "-100999"; // 미허용 방으로 확실히 무시시킨다

    const seenFileIds: string[] = [];
    const result = await runTelegramPollingCycle({
      bots: bots(),
      config: config(),
      ports: ports.ports,
      offsets: new TelegramPollingOffsets(),
      deps: { fetchImpl: fetchWithFileDownload([update], seenFileIds), attachmentsDir: dir }
    });

    assert.equal(result.ignored, 1);
    assert.deepEqual(seenFileIds, [], "무시된 메시지는 다운로드를 시도하면 안 된다");
    assert.deepEqual(readdirSync(dir), [], "무시된 메시지는 파일을 남기면 안 된다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("폴링 시작 전 webhook 을 해제한다", async () => {
  const called: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    called.push(String(url).split("/").pop() ?? "");
    return jsonResponse({ ok: true });
  };

  const results = await releaseTelegramWebhooks(bots(), fetchImpl);
  assert.deepEqual(called, ["deleteWebhook"], "webhook 이 남아 있으면 getUpdates 가 409 로 거절된다");
  assert.equal(results[0]?.ok, true);
});

function bots(): TelegramPollingBot[] {
  return [{ botUsername: BOT, token: "test-token" }];
}

function config(): BotServiceConfig {
  return {
    allowedChatIds: [CHAT],
    botsByUsername: new Map([[BOT, { telegramBotId: "b1", botUsername: BOT, botRole: "leader", webhookSecret: "s" }]])
  };
}

function message(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: CHAT },
      from: { id: "5001", is_bot: false, first_name: "방장" },
      text
    }
  };
}

function makePorts() {
  const seen = new Set<string>();
  const queued: Array<{ input: { kind: string } }> = [];
  const recorded: Array<{ envelope: { telegramBotId: string; updateId: string }; rawUpdate: unknown; status: string }> = [];
  return {
    queued,
    recorded,
    ports: {
      updates: {
        async recordUpdateOnce(envelope: { telegramBotId: string; updateId: string }, rawUpdate: unknown, status: string) {
          recorded.push({ envelope, rawUpdate, status });
          const key = `${envelope.telegramBotId}:${envelope.updateId}`;
          if (seen.has(key)) return { inserted: false as const, status: "processed" as const, idempotencyKey: key };
          seen.add(key);
          return { inserted: true as const, status: "received" as const, idempotencyKey: key };
        },
        async markUpdateFailed() {}
      },
      inboundQueue: {
        async enqueue(message: { input: { kind: string } }) {
          queued.push(message);
        }
      }
    } as never
  };
}

function fetchReturning(updates: unknown[]): typeof fetch {
  return async () => jsonResponse({ ok: true, result: updates });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function photoMessage(updateId: number, caption: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: CHAT },
      from: { id: "5001", is_bot: false, first_name: "방장" },
      caption,
      photo: [
        { file_id: "small-file-id", width: 90, height: 90 },
        { file_id: "large-file-id", width: 800, height: 800 }
      ]
    }
  };
}

function documentMessage(updateId: number, caption: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      chat: { id: CHAT },
      from: { id: "5001", is_bot: false, first_name: "방장" },
      caption,
      document: { file_id: "doc-file-id", file_name: "사업계획서.txt" }
    }
  };
}

// getUpdates 는 배열로 주어진 update 를 그대로 돌려주고, getFile/파일 다운로드는
// 고정된 바이트를 돌려주는 가짜 텔레그램. 실제로 무엇을 받았는지(file_id) 검사용으로 기록한다.
function fetchWithFileDownload(updates: unknown[], seenFileIds: string[]): typeof fetch {
  return async (url) => {
    const s = String(url);
    if (s.includes("/getUpdates")) return jsonResponse({ ok: true, result: updates });
    if (s.includes("/getFile")) {
      const fileId = new URL(s).searchParams.get("file_id") ?? "";
      seenFileIds.push(fileId);
      return jsonResponse({ ok: true, result: { file_id: fileId, file_path: "photos/fake.jpg" } });
    }
    if (s.includes("/file/bot")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    return jsonResponse({ ok: false });
  };
}
