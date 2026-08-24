// 목표서 KPI 를 실측하고 그 근거를 파일로 남긴다.
//
// 왜 필요한가: 독립 검증(Codex)이 KPI 주장 7건을 반증했는데, 대부분 "코드가 틀렸다"가
// 아니라 "증거가 세션 안에만 있었다"였다. 사람이 화면에서 본 것은 세션이 끝나면
// 사라진다. 방 ID·시각·수치가 파일로 남아야 누구든 다시 확인할 수 있다.
//
// 이 스크립트는 실제 방에 실행을 걸어 잰다. 파일을 바꾸지 않는 프롬프트만 쓴다 —
// 측정하려고 저장소를 흔들면 안 된다.
import { writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const OUT = argValue("--out") ?? "docs/kpi-measurement.json";

export function summarizeConcurrency(events) {
  const started = events.filter((event) => event.type === "started" && event.at);
  const byInstant = new Map();
  for (const event of started) {
    // 같은 순간에 몇 건이 떠 있었는지 센다. 1초 창으로 묶는다 — 밀리초가 정확히
    // 같아야만 동시로 치면 실제 동시 실행을 놓친다.
    const second = String(event.at).slice(0, 19);
    byInstant.set(second, (byInstant.get(second) ?? 0) + 1);
  }
  return { maxConcurrentStarts: Math.max(0, ...byInstant.values()), startCount: started.length };
}

export function summarizeFairness(submittedAtMs, startedEvents) {
  // 동시성이 꽉 찬 상태에서 마지막으로 시작한 건이 얼마 만에 들어갔는가.
  // 목표서 기준은 "다른 방 응답이 5분 이내 시작" 이다.
  const startTimes = startedEvents.map((event) => Date.parse(event.at)).filter(Number.isFinite).sort((a, b) => a - b);
  if (startTimes.length === 0) return undefined;
  const lastStart = startTimes[startTimes.length - 1];
  return { lastStartDelaySeconds: Math.round(((lastStart - submittedAtMs) / 1000) * 10) / 10 };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const token = requireEnv("BOT_SERVICE_LEADER_BOT_TOKEN");
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };

  const rooms = await supabase("/huai_rooms?select=room_id,purpose,telegram_chat_id,status&status=eq.active");

  // 실제 Telegram 그룹만 센다. DB 에만 있는 시딩 방은 라우팅 시험용이라 실행 대상이 아니다.
  const reachable = [];
  for (const room of rooms) {
    const probe = await telegramRaw(token, "getChat", { chat_id: room.telegram_chat_id });
    if (probe.ok) reachable.push({ ...room, title: probe.result?.title });
  }

  const report = {
    measuredAt: new Date().toISOString(),
    rooms: { activeInDb: rooms.length, reachableOnTelegram: reachable.length, reachable: reachable.map((r) => ({ roomId: r.room_id, title: r.title, chatId: String(r.telegram_chat_id) })) }
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    console.log("dry-run — 실행을 걸지 않았다. 실제로 재려면 --apply 를 붙인다.");
    process.exit(0);
  }

  const stamp = Date.now();
  const submissions = [];
  for (const [index, room] of reachable.entries()) {
    const gateways = await supabase(`/huai_gateway_instances?select=gateway_id&room_id=eq.${room.room_id}`);
    const actors = await supabase(`/huai_ai_actors?select=actor_id&room_id=eq.${room.room_id}&role=eq.claude_leader`);
    if (!gateways[0] || !actors[0]) continue;
    const attemptId = `kpi-${stamp}-${index}`;
    submissions.push({ attemptId, roomId: room.room_id, title: room.title, gatewayId: gateways[0].gateway_id, actorId: actors[0].actor_id, chatId: String(room.telegram_chat_id) });
  }

  // 한 번에 넣어야 동시성이 측정된다. 하나씩 넣으면 큐가 비어 순차 실행처럼 보인다.
  const submittedAtMs = Date.now();
  const insert = await fetch(`${base}/rest/v1/huai_outbox`, {
    method: "POST",
    headers: { ...headers, prefer: "return=minimal" },
    body: JSON.stringify(submissions.map((s) => ({
      idempotency_key: `gateway:kpi-measure:${s.attemptId}`,
      target_kind: "local_gateway",
      target: JSON.stringify({ kind: "local_gateway", gatewayId: s.gatewayId }),
      room_id: s.roomId,
      payload: {
        telegramChatId: s.chatId,
        executionRequest: {
          roomId: s.roomId, taskId: s.attemptId, attemptId: s.attemptId, actorId: s.actorId,
          requestedBy: "kpi-measure", adapterType: "claude_code",
          projectPath: "C:\\Dev\\HuAIChatroomSystem",
          prompt: "파일을 절대 수정하지 마라. `node --version` 만 실행하고 그 출력 한 줄만 답하라.",
          timeoutMs: 180000, idempotencyKey: `kpi-measure:${s.attemptId}`, createdAt: new Date().toISOString()
        }
      }
    })))
  });
  if (!insert.ok) throw new Error(`submit-failed:${insert.status}:${(await insert.text()).slice(0, 200)}`);

  report.submission = { submittedAt: new Date(submittedAtMs).toISOString(), rooms: submissions.map((s) => ({ attemptId: s.attemptId, roomId: s.roomId, title: s.title })) };
  console.log(`투입 ${submissions.length}건 @ ${report.submission.submittedAt}`);
  console.log("게이트웨이 로그에서 started/completed 를 확인한 뒤 --collect 로 결과를 합친다.");
  writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`기록: ${OUT}`);

  async function supabase(path) {
    const response = await fetch(base + "/rest/v1" + path, { headers });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }
  async function telegramRaw(botToken, method, body) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    return response.json();
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing-env:${name}`);
  return value;
}
