// 방마다 "작업판 열기" 메시지를 하나 보내 고정한다.
//
// 왜 필요한가: 작업판 버튼은 /tasks 응답에 붙는데, 그 메시지는 대화가 쌓이면 위로
// 밀려 올라가 찾을 수 없다. 방장이 작업판을 열 때마다 /tasks 를 다시 쳐야 한다.
// Telegram 의 메뉴 버튼은 그룹에서 안 된다(getChatMenuButton 이 그룹 chat_id 를
// 400 invalid chat_id 로 거부한다 — 라이브 확인). 그룹에서 항상 같은 자리에 두는
// 수단은 고정 메시지뿐이다.
//
// 왜 /tasks 응답을 고정하지 않는가: 그 메시지는 만들어진 시점의 작업 목록을 본문에
// 담고 있어서 고정해두면 낡은 목록이 방 맨 위에 박제된다. 그래서 목록이 없는
// 작업판 전용 메시지를 따로 만든다 — 본문은 안 낡고, 최신 상태는 버튼을 눌러서 본다.
// 링크 형식(?startapp=<roomId>)을 여기 베껴 쓰지 않는다. 봇이 /tasks 에 붙이는 버튼과
// 고정 메시지의 버튼이 조금이라도 달라지면 고정된 쪽만 조용히 엉뚱한 방을 연다.
// 그래서 봇이 실제로 쓰는 그 함수를 빌드 산출물에서 그대로 가져온다(pnpm run build 필요).
import { buildMiniAppDirectLink } from "../dist/packages/telegram-ui/src/index.js";

const APPLY = process.argv.includes("--apply");

export const BOARD_MESSAGE_TEXT = "📋 작업판 — 이 방의 작업과 승인 대기를 한 화면에서 봅니다.";

// 이미 우리가 고정해 둔 메시지인지 판정한다. 방장이 직접 고정한 다른 메시지를
// 덮어쓰면 안 되고, 실행할 때마다 새 메시지를 만들어 방을 어지럽혀도 안 된다.
export function needsBoardPin(pinnedMessage, botId) {
  if (!pinnedMessage) return true;
  const fromBot = Number(pinnedMessage.from?.id) === Number(botId);
  const isBoardMessage = String(pinnedMessage.text ?? "").startsWith(BOARD_MESSAGE_TEXT.slice(0, 12));
  return !(fromBot && isBoardMessage);
}

export function buildBoardMessagePayload(chatId, roomId, directLinkBaseUrl) {
  return {
    chat_id: chatId,
    text: BOARD_MESSAGE_TEXT,
    // 고정 메시지에 링크 미리보기가 붙으면 고정 바가 불필요하게 커진다.
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "작업판 열기", url: buildMiniAppDirectLink(directLinkBaseUrl, roomId) }]]
    }
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const token = requireEnv("BOT_SERVICE_PLATOON_BOT_TOKEN");
  const directLinkBaseUrl = requireEnv("BOT_SERVICE_MINIAPP_DIRECT_LINK");
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const botId = Number(token.split(":")[0]);

  const rooms = await supabase(`${base}/rest/v1/huai_rooms?select=room_id,telegram_chat_id,purpose&status=eq.active`, key);
  console.log(`활성 방: ${rooms.length}`);

  let pinned = 0;
  let skipped = 0;
  let failed = 0;

  for (const room of rooms) {
    const chatId = room.telegram_chat_id;
    const label = `${room.purpose ?? room.room_id}`.slice(0, 30);

    let chat;
    try {
      chat = await telegram(token, "getChat", { chat_id: chatId });
    } catch (error) {
      // 봇이 아직 안 들어간 방, 삭제된 방이 섞여 있을 수 있다. 한 방의 실패가
      // 나머지 20방을 막으면 안 된다.
      console.log(`  건너뜀  ${label} — 방 조회 실패: ${String(error.message).slice(0, 80)}`);
      failed += 1;
      continue;
    }

    if (!needsBoardPin(chat.pinned_message, botId)) {
      console.log(`  유지    ${label} — 이미 작업판이 고정돼 있다`);
      skipped += 1;
      continue;
    }

    if (chat.pinned_message) {
      console.log(`  주의    ${label} — 다른 메시지가 고정돼 있다. 덮어쓰지 않는다`);
      skipped += 1;
      continue;
    }

    if (!APPLY) {
      console.log(`  고정예정 ${label}`);
      pinned += 1;
      continue;
    }

    try {
      const sent = await telegram(token, "sendMessage", buildBoardMessagePayload(chatId, room.room_id, directLinkBaseUrl));
      await telegram(token, "pinChatMessage", {
        chat_id: chatId,
        message_id: sent.message_id,
        // 21개 방에 한꺼번에 알림이 가면 그 자체가 소음이다.
        disable_notification: true
      });
      console.log(`  고정    ${label}`);
      pinned += 1;
    } catch (error) {
      console.log(`  실패    ${label} — ${String(error.message).slice(0, 120)}`);
      failed += 1;
    }
  }

  console.log(`고정 ${pinned} / 유지·보류 ${skipped} / 실패 ${failed}`);
  if (!APPLY) console.log("dry-run — 아무것도 보내지 않았다. 실제로 고정하려면 --apply 를 붙인다.");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing-env:${name}`);
  return value;
}

async function supabase(url, key) {
  const res = await fetch(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`query-failed:${res.status}`);
  return res.json();
}

async function telegram(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const parsed = await res.json();
  if (!parsed.ok) throw new Error(`${method}:${parsed.error_code}:${parsed.description}`);
  return parsed.result;
}
