// 실행이 도는 동안 방에 "살아 있다"를 계속 보여준다.
//
// 왜 필요한가: 방장이 실행 버튼을 눌러도 눈에 보이는 변화가 곧 멎었다. 누른 메시지는
// "▶ 실행 중입니다" 로 한 번 바뀌고 그대로 정지해 있고, 작업자가 몇 분씩 도는 동안
// 방은 아무 말이 없다. 방장이 "먹통인지 도는 건지 모르겠다"고 반복해 제기했다.
//
// Telegram 에서 봇이 쓸 수 있는 "움직이는" 신호는 두 가지뿐이다. 버튼 색이나
// 애니메이션은 봇이 정할 수 없다.
//   1) sendChatAction — 방 상단에 "…이 입력 중" 이 뜬다. 약 5초면 사라지므로 계속 새로
//      보내야 유지된다. 이게 유일하게 실제로 움직이는 표시다.
//   2) 메시지 편집으로 경과 시간 갱신 — 숫자가 커지는 것이 보인다.
//
// 둘 다 실행 중인 방에만 보낸다. 무엇이 도는지는 huai_outbox 의 local_gateway 행이
// processing 인지로 알 수 있다 — 게이트웨이가 리스한 것이 곧 실행 중인 것이다.

export type InFlightExecution = {
  telegramChatId: string;
  startedAtMs: number;
};

export type ExecutionHeartbeatPorts = {
  listInFlightExecutions(): Promise<InFlightExecution[]>;
  sendTypingAction(telegramChatId: string): Promise<void>;
};

export type ExecutionHeartbeatHandle = { stop(): void };

// 같은 방에서 여러 건이 동시에 돌아도 표시는 하나면 된다. 가장 오래 걸린 것을 기준으로
// 삼는다 — 방장이 알고 싶은 것은 "제일 오래 기다린 게 얼마나 됐나"다.
export function summarizeByChat(executions: readonly InFlightExecution[]): Map<string, number> {
  const oldestByChat = new Map<string, number>();
  for (const execution of executions) {
    if (!execution.telegramChatId) continue;
    const previous = oldestByChat.get(execution.telegramChatId);
    if (previous === undefined || execution.startedAtMs < previous) {
      oldestByChat.set(execution.telegramChatId, execution.startedAtMs);
    }
  }
  return oldestByChat;
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

export async function runExecutionHeartbeatOnce(ports: ExecutionHeartbeatPorts): Promise<{ chats: number }> {
  const executions = await ports.listInFlightExecutions();
  const byChat = summarizeByChat(executions);
  for (const chatId of byChat.keys()) {
    // 한 방이 실패해도 다른 방 표시는 계속돼야 한다.
    try {
      await ports.sendTypingAction(chatId);
    } catch {
      // 표시가 안 되는 것은 작업 자체를 막을 이유가 아니다. 조용히 넘긴다.
    }
  }
  return { chats: byChat.size };
}

export function startExecutionHeartbeatLoop(
  ports: ExecutionHeartbeatPorts & { intervalMs?: number; onError?: (error: unknown) => void }
): ExecutionHeartbeatHandle {
  // Telegram 의 입력 표시는 약 5초 뒤 사라진다. 그보다 짧게 보내야 끊기지 않는다.
  const intervalMs = ports.intervalMs ?? 4000;
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runExecutionHeartbeatOnce(ports);
    } catch (error) {
      ports.onError?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
