// 봇이 만든 협업 운영센터 고정 메시지만 안전하게 삭제한다.
// --apply 없이는 Telegram API를 호출하지 않는다.
import { isKnownBoardMessageText } from "./pin-room-board-message.mjs";

const APPLY = process.argv.includes("--apply");

// 최신 문구와의 완전일치로 판정하면 안 된다 — 운영 방에 실제로 고정되어 있는 것은
// 대부분 옛 문구("📋 작업 현황판 — …")라, 정작 지워야 할 메시지를 전부 남의 것으로
// 오인해 이 스크립트가 아무것도 지우지 못한다.
export function isRemovableBoardMessage(pinnedMessage, botId) {
  return Boolean(
    pinnedMessage &&
    Number(pinnedMessage.from?.id) === Number(botId) &&
    isKnownBoardMessageText(pinnedMessage.text)
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const token = requireEnv("BOT_SERVICE_LEADER_BOT_TOKEN");
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const botId = Number(token.split(":")[0]);
  const rooms = await supabase(`${base}/rest/v1/huai_rooms?select=room_id,telegram_chat_id,purpose&status=eq.active`, key);
  let removed = 0;
  let skipped = 0;
  let failed = 0;

  for (const room of rooms) {
    const label = `${room.purpose ?? room.room_id}`.slice(0, 30);
    try {
      const chat = await telegram(token, "getChat", { chat_id: room.telegram_chat_id });
      if (!isRemovableBoardMessage(chat.pinned_message, botId)) {
        console.log(`  유지 ${label}`);
        skipped += 1;
        continue;
      }
      const messageId = chat.pinned_message.message_id;
      if (!APPLY) {
        console.log(`  삭제 예정 ${label} message_id=${messageId}`);
        removed += 1;
        continue;
      }
      await telegram(token, "deleteMessage", { chat_id: room.telegram_chat_id, message_id: messageId });
      console.log(`  삭제 ${label}`);
      removed += 1;
    } catch (error) {
      console.log(`  실패 ${label} ${String(error.message).slice(0, 120)}`);
      failed += 1;
    }
  }
  console.log(`삭제 ${removed} / 유지 ${skipped} / 실패 ${failed}`);
  if (!APPLY) console.log("dry-run: 실제 삭제에는 --apply가 필요합니다.");
  if (failed > 0) process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing-env:${name}`);
  return value;
}

async function supabase(url, key) {
  const response = await fetch(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!response.ok) throw new Error(`query-failed:${response.status}`);
  return response.json();
}

async function telegram(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const parsed = await response.json();
  if (!parsed.ok) throw new Error(`${method}:${parsed.error_code}:${parsed.description}`);
  return parsed.result;
}
