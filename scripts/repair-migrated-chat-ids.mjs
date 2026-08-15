// huai_rooms.telegram_chat_id 가 Telegram 의 실제 chat_id 와 어긋난 방을 고친다.
//
// 왜 어긋나는가: Telegram 은 일반 그룹(group)을 슈퍼그룹(supergroup)으로 승격시킬 때
// chat_id 를 바꾼다(관리자 지정 등이 계기가 된다). 그 순간부터 옛 id 로 보내는 모든
// 요청이 400 "group chat was upgraded to a supergroup chat" 로 떨어진다 — 방은 멀쩡한데
// 봇만 말을 못 거는 상태가 되고, 화면에는 아무 에러도 안 뜬다.
//
// 라이브에서 실제 방 4개 중 3개가 이 상태였다. getChat 은 옛 id 로도 성공해서
// (type 도 여전히 'group' 으로 보인다) 조회만으로는 못 잡는다 — 보내보는 계열의
// 호출만 승격 사실을 알려준다. 그래서 sendChatAction 으로 확인한다(메시지를 남기지
// 않는 가장 가벼운 쓰기 계열 호출이다).
//
// Telegram 이 응답 parameters.migrate_to_chat_id 에 새 id 를 실어주므로 추측할 것이 없다.

const APPLY = process.argv.includes("--apply");

export function planChatIdRepairs(probeResults) {
  return probeResults
    .filter((result) => Number.isSafeInteger(result.migrateToChatId) && result.migrateToChatId !== result.currentChatId)
    .map((result) => ({
      roomId: result.roomId,
      purpose: result.purpose,
      from: result.currentChatId,
      to: result.migrateToChatId
    }));
}

export function migrateTargetFromResponse(response) {
  const target = response?.parameters?.migrate_to_chat_id;
  return Number.isSafeInteger(target) ? target : undefined;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const token = requireEnv("BOT_SERVICE_PLATOON_BOT_TOKEN");
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };

  const rooms = await (await fetch(`${base}/rest/v1/huai_rooms?select=room_id,telegram_chat_id,purpose&status=eq.active`, { headers })).json();

  const probes = [];
  for (const room of rooms) {
    const response = await telegramRaw(token, "sendChatAction", { chat_id: room.telegram_chat_id, action: "typing" });
    probes.push({
      roomId: room.room_id,
      purpose: room.purpose,
      currentChatId: Number(room.telegram_chat_id),
      migrateToChatId: migrateTargetFromResponse(response),
      reachable: response.ok === true,
      description: response.description
    });
  }

  const repairs = planChatIdRepairs(probes);
  const unreachable = probes.filter((p) => !p.reachable && p.migrateToChatId === undefined);

  console.log(`활성 방: ${rooms.length}`);
  console.log(`도달 가능: ${probes.filter((p) => p.reachable).length}`);
  console.log(`승격으로 id 가 바뀐 방: ${repairs.length}`);
  for (const repair of repairs) console.log(`  ${repair.purpose}  ${repair.from} → ${repair.to}`);
  console.log(`원인 불명으로 도달 불가: ${unreachable.length}`);

  if (!APPLY) {
    console.log("dry-run — 아무것도 쓰지 않았다. 실제로 고치려면 --apply 를 붙인다.");
    process.exit(0);
  }

  for (const repair of repairs) {
    const res = await fetch(`${base}/rest/v1/huai_rooms?room_id=eq.${repair.roomId}`, {
      method: "PATCH",
      headers: { ...headers, prefer: "return=minimal" },
      body: JSON.stringify({ telegram_chat_id: repair.to })
    });
    if (!res.ok) throw new Error(`update-failed:${repair.roomId}:${res.status}:${(await res.text()).slice(0, 200)}`);
    console.log(`  갱신 ${repair.purpose}`);
  }

  console.log(`갱신 완료: ${repairs.length}건`);
  if (repairs.length > 0) {
    console.log("bot-service 는 부팅 시 방 목록을 읽는다 — 재기동해야 새 chat_id 가 반영된다.");
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing-env:${name}`);
  return value;
}

async function telegramRaw(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}
