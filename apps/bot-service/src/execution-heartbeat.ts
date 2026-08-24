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
  // 포럼 주제 번호. 진행 표시도 지시가 오간 주제에 떠야 한다.
  messageThreadId?: string;
  // 리더 판단(리더 planning) 단계인지, 승인된 실제 작업 실행 단계인지.
  // 파이프라인은 이 둘을 순서대로 거치는데, 각각 별도의 outbox 행이라 planning 행이
  // 끝나고 실행 행이 아직 안 만들어진 찰나에는 두 단계 사이 빈틈이 생긴다. 이 빈틈을
  // "전체가 끝났다"로 오판하지 않으려면 방금 사라진 게 어느 단계였는지 알아야 한다.
  isPlanning?: boolean;
};

export type ExecutionHeartbeatPorts = {
  listInFlightExecutions(): Promise<InFlightExecution[]>;
  sendTypingAction(telegramChatId: string): Promise<void>;
  // 경과 시간을 적은 메시지를 방에 하나 두고 계속 고쳐 쓴다. 숫자가 올라가는 것은
  // 방장 눈에 실제로 보인다 — 입력 표시와 달리 화면 흐름 안에 남는다.
  sendProgressMessage?(telegramChatId: string, text: string, messageThreadId?: string): Promise<string | undefined>;
  editProgressMessage?(telegramChatId: string, messageId: string, text: string): Promise<void>;
};

// 방마다 진행 표시 메시지 하나. 프로세스가 죽으면 잊히고, 다음 실행 때 새로 만든다.
// lastSeenAtMs/lastKind 는 "지금 막 사라졌다" 판정에 유예시간을 주고, 사라진 것이
// planning 이었는지 실제 실행이었는지 구분하는 데 쓴다.
export type ProgressMessages = Map<string, { messageId: string; lastText: string; lastSeenAtMs: number; lastKind: "planning" | "execution" }>;

export function renderProgressText(elapsedMs: number): string {
  return `⏳ 작업 중 · ${formatElapsed(elapsedMs)} 경과`;
}

export const PROGRESS_DONE_TEXT = "✅ 작업이 끝났습니다. 결과를 정리해 올리겠습니다.";

// 리더 판단(리더 planning) 단계만 끝났을 때 쓰는 문구. 아직 승인·실제 실행 단계가
// 남아 있으므로 "끝났다"고 말하면 안 된다 — 다음 단계가 이어질 것을 알려준다.
export const PROGRESS_PLANNING_DONE_TEXT = "🧭 판단을 마쳤습니다. 다음 단계(승인/실행)를 준비 중입니다.";

// outbox 행 사이 빈틈(다음 단계 행이 아직 안 만들어진 찰나)을 "전체 종료"로 오판하지
// 않기 위한 유예시간. 하트비트 주기(기본 4초)보다 넉넉히 크게 잡는다.
const GONE_GRACE_MS = 8000;

export type ExecutionHeartbeatHandle = { stop(): void };

// 같은 방에서 여러 건이 동시에 돌아도 표시는 하나면 된다. 가장 오래 걸린 것을 기준으로
// 삼는다 — 방장이 알고 싶은 것은 "제일 오래 기다린 게 얼마나 됐나"다.
//
// kind 는 "실제 실행이 하나라도 섞여 있으면 execution" 으로 판정한다. planning 행
// 하나만 도는 방은 아직 판단 단계라 kind: "planning" — 이 행이 사라지는 순간을
// "전체 종료"로 오인하면 안 되기 때문이다.
export function summarizeByChat(executions: readonly InFlightExecution[]): Map<string, { startedAtMs: number; kind: "planning" | "execution" }> {
  const byChat = new Map<string, { startedAtMs: number; kind: "planning" | "execution" }>();
  for (const execution of executions) {
    if (!execution.telegramChatId) continue;
    const kind: "planning" | "execution" = execution.isPlanning ? "planning" : "execution";
    const previous = byChat.get(execution.telegramChatId);
    if (!previous) {
      byChat.set(execution.telegramChatId, { startedAtMs: execution.startedAtMs, kind });
      continue;
    }
    byChat.set(execution.telegramChatId, {
      startedAtMs: Math.min(previous.startedAtMs, execution.startedAtMs),
      kind: previous.kind === "execution" || kind === "execution" ? "execution" : "planning"
    });
  }
  return byChat;
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

export async function runExecutionHeartbeatOnce(
  ports: ExecutionHeartbeatPorts,
  progress: ProgressMessages = new Map(),
  nowMs: number = Date.now()
): Promise<{ chats: number }> {
  const executions = await ports.listInFlightExecutions();
  const byChat = summarizeByChat(executions);
  const threadByChat = new Map(
    executions.filter((execution) => execution.messageThreadId).map((execution) => [execution.telegramChatId, execution.messageThreadId])
  );

  for (const [chatId, { startedAtMs, kind }] of byChat) {
    // 한 방이 실패해도 다른 방 표시는 계속돼야 한다.
    try {
      await ports.sendTypingAction(chatId);
    } catch {
      // 표시가 안 되는 것은 작업 자체를 막을 이유가 아니다. 조용히 넘긴다.
    }

    try {
      const text = renderProgressText(nowMs - startedAtMs);
      const existing = progress.get(chatId);
      if (!existing) {
        const messageId = await ports.sendProgressMessage?.(chatId, text, threadByChat.get(chatId));
        if (messageId) progress.set(chatId, { messageId, lastText: text, lastSeenAtMs: nowMs, lastKind: kind });
        continue;
      }
      existing.lastSeenAtMs = nowMs;
      existing.lastKind = kind;
      // 같은 글자로 고치면 Telegram 이 거절한다. 초가 바뀔 때만 보낸다.
      if (existing.lastText === text) continue;
      await ports.editProgressMessage?.(chatId, existing.messageId, text);
      existing.lastText = text;
    } catch {
      // 표시가 안 되는 것은 작업 자체를 막을 이유가 아니다.
    }
  }

  // 끝난 방의 표시는 끝났다고 못박는다. 숫자가 멈춘 채로 남으면 방장은 그게 멈춘 건지
  // 아직 도는 건지 알 수 없다 — 표시를 붙인 이유가 사라진다.
  //
  // 단, outbox 행 사이 빈틈(다음 단계 행이 아직 안 만들어진 찰나)일 수 있으므로 두 가지로
  // 방어한다. (1) 유예시간: 사라진 지 얼마 안 됐으면 아직 판단하지 않는다 — 곧 다음 단계
  // 행이 생기면 다시 나타난다. (2) 단계 구분: 유예시간이 지나 진짜 끊긴 것으로 봐도,
  // 방금까지 돌던 게 planning(리더 판단) 뿐이었다면 "전체가 끝났다"가 아니라 "다음 단계
  // 준비 중"이라고 말한다 — 승인·실제 실행이 아직 남아 있어서다.
  for (const [chatId, entry] of [...progress]) {
    if (byChat.has(chatId)) continue;
    if (nowMs - entry.lastSeenAtMs < GONE_GRACE_MS) continue;

    if (entry.lastKind === "planning") {
      if (entry.lastText === PROGRESS_PLANNING_DONE_TEXT) continue;
      try {
        await ports.editProgressMessage?.(chatId, entry.messageId, PROGRESS_PLANNING_DONE_TEXT);
        entry.lastText = PROGRESS_PLANNING_DONE_TEXT;
      } catch {
        // 이미 지워졌거나 편집이 막힌 메시지다. 다음 실행은 새 메시지로 시작한다.
      }
      continue;
    }

    progress.delete(chatId);
    try {
      await ports.editProgressMessage?.(chatId, entry.messageId, PROGRESS_DONE_TEXT);
    } catch {
      // 이미 지워졌거나 편집이 막힌 메시지다. 다음 실행은 새 메시지로 시작한다.
    }
  }

  return { chats: byChat.size };
}

export function startExecutionHeartbeatLoop(
  ports: ExecutionHeartbeatPorts & { intervalMs?: number; onError?: (error: unknown) => void }
): ExecutionHeartbeatHandle {
  // Telegram 의 입력 표시는 약 5초 뒤 사라진다. 그보다 짧게 보내야 끊기지 않는다.
  const intervalMs = ports.intervalMs ?? 4000;
  const progress: ProgressMessages = new Map();
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runExecutionHeartbeatOnce(ports, progress);
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
