import assert from "node:assert/strict";
import test from "node:test";
import {
  formatElapsed,
  PROGRESS_DONE_TEXT,
  runExecutionHeartbeatOnce,
  summarizeByChat,
  type InFlightExecution
} from "../src/execution-heartbeat.js";

// 방장이 실행 버튼을 눌러도 눈에 보이는 변화가 곧 멎었다. "▶ 실행 중입니다" 는 한 번
// 바뀌고 정지해 있고, 작업자가 몇 분 도는 동안 방은 조용했다. Telegram 에서 봇이 쓸 수
// 있는 움직이는 신호는 입력 표시뿐이라 그것을 계속 보낸다.

test("실행 중인 방에만 표시를 보낸다", async () => {
  const sent: string[] = [];
  const result = await runExecutionHeartbeatOnce({
    async listInFlightExecutions() {
      return [execution("-1001", 1000), execution("-1002", 2000)];
    },
    async sendTypingAction(chatId) { sent.push(chatId); }
  });

  assert.deepEqual(sent.sort(), ["-1001", "-1002"]);
  assert.equal(result.chats, 2);
});

test("도는 것이 없으면 아무 데도 안 보낸다", async () => {
  const sent: string[] = [];
  const result = await runExecutionHeartbeatOnce({
    async listInFlightExecutions() { return []; },
    async sendTypingAction(chatId) { sent.push(chatId); }
  });

  assert.deepEqual(sent, []);
  assert.equal(result.chats, 0);
});

test("한 방에서 여러 건이 돌아도 표시는 한 번만 보낸다", async () => {
  const sent: string[] = [];
  await runExecutionHeartbeatOnce({
    async listInFlightExecutions() {
      return [execution("-1001", 5000), execution("-1001", 9000), execution("-1001", 7000)];
    },
    async sendTypingAction(chatId) { sent.push(chatId); }
  });

  assert.deepEqual(sent, ["-1001"]);
});

test("한 방이 실패해도 다른 방 표시는 계속된다", async () => {
  // 한 방의 전송 실패가 나머지를 막으면, 방 하나가 고장 났을 때 전체가 조용해진다.
  const sent: string[] = [];
  await runExecutionHeartbeatOnce({
    async listInFlightExecutions() {
      return [execution("-1001", 1000), execution("-1002", 1000)];
    },
    async sendTypingAction(chatId) {
      if (chatId === "-1001") throw new Error("telegram-down");
      sent.push(chatId);
    }
  });

  assert.deepEqual(sent, ["-1002"]);
});

test("방마다 가장 오래 걸린 실행을 기준으로 삼는다", () => {
  // 방장이 알고 싶은 것은 "제일 오래 기다린 게 얼마나 됐나"다.
  const byChat = summarizeByChat([execution("-1001", 9000), execution("-1001", 3000), execution("-1002", 5000)]);

  assert.equal(byChat.get("-1001"), 3000);
  assert.equal(byChat.get("-1002"), 5000);
});

test("방 번호가 없는 실행은 건너뛴다", () => {
  const byChat = summarizeByChat([execution("", 1000), execution("-1001", 1000)]);

  assert.deepEqual([...byChat.keys()], ["-1001"]);
});

test("경과 시간을 사람이 읽는 말로 쓴다", () => {
  assert.equal(formatElapsed(0), "0초");
  assert.equal(formatElapsed(45_000), "45초");
  assert.equal(formatElapsed(60_000), "1분 0초");
  assert.equal(formatElapsed(132_000), "2분 12초");
  // 음수는 시계 어긋남으로 생길 수 있다. "-3초"를 방에 보여주지 않는다.
  assert.equal(formatElapsed(-5_000), "0초");
});

function execution(telegramChatId: string, startedAtMs: number): InFlightExecution {
  return { telegramChatId, startedAtMs };
}

// 방장이 반복해 제기한 문제 — "실행 버튼 움직임이 결과 나오기 전에 끝나버린다".
//
// 입력 표시는 화면 맨 위 작은 글씨라 눈에 안 띄고, 5초면 사라진다. 방 흐름 안에 남아
// 숫자가 올라가는 표시가 있어야 방장이 "돌고 있다"를 안다.
test("실행이 도는 동안 경과 시간을 적은 메시지를 방에 두고 고쳐 쓴다", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const edited: Array<{ chatId: string; messageId: string; text: string }> = [];
  const progress = new Map();
  const ports = {
    async listInFlightExecutions() {
      return [{ telegramChatId: "1001", startedAtMs: 1_000 }];
    },
    async sendTypingAction() {},
    async sendProgressMessage(chatId: string, text: string) {
      sent.push({ chatId, text });
      return "msg-1";
    },
    async editProgressMessage(chatId: string, messageId: string, text: string) {
      edited.push({ chatId, messageId, text });
    }
  };

  await runExecutionHeartbeatOnce(ports, progress, 6_000);
  assert.deepEqual(sent, [{ chatId: "1001", text: "⏳ 작업 중 · 5초 경과" }]);
  assert.deepEqual(edited, []);

  await runExecutionHeartbeatOnce(ports, progress, 71_000);
  assert.equal(sent.length, 1, "방마다 메시지는 하나여야 한다 — 매 바퀴 새로 보내면 방이 도배된다");
  assert.deepEqual(edited, [{ chatId: "1001", messageId: "msg-1", text: "⏳ 작업 중 · 1분 10초 경과" }]);
});

test("같은 초에 두 번 돌아도 편집을 보내지 않는다", async () => {
  // 같은 글자로 고치면 Telegram 이 거절한다. 오류를 스스로 만들 이유가 없다.
  const edited: string[] = [];
  const progress = new Map();
  const ports = {
    async listInFlightExecutions() {
      return [{ telegramChatId: "1001", startedAtMs: 0 }];
    },
    async sendTypingAction() {},
    async sendProgressMessage() { return "msg-1"; },
    async editProgressMessage(_chatId: string, _messageId: string, text: string) { edited.push(text); }
  };

  await runExecutionHeartbeatOnce(ports, progress, 3_000);
  await runExecutionHeartbeatOnce(ports, progress, 3_400);
  assert.deepEqual(edited, []);
});

test("실행이 끝나면 표시를 끝났다고 못박는다", async () => {
  // 숫자가 멈춘 채 남으면 멈춘 건지 도는 건지 알 수 없다.
  const edited: string[] = [];
  const progress = new Map();
  let inFlight = [{ telegramChatId: "1001", startedAtMs: 0 }];
  const ports = {
    async listInFlightExecutions() { return inFlight; },
    async sendTypingAction() {},
    async sendProgressMessage() { return "msg-1"; },
    async editProgressMessage(_chatId: string, _messageId: string, text: string) { edited.push(text); }
  };

  await runExecutionHeartbeatOnce(ports, progress, 1_000);
  inFlight = [];
  await runExecutionHeartbeatOnce(ports, progress, 9_000);

  assert.deepEqual(edited, [PROGRESS_DONE_TEXT]);
  assert.equal(progress.size, 0, "끝난 방을 들고 있으면 다음 실행이 옛 메시지를 고친다");
});
