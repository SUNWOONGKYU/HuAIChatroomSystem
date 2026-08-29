// 방마다 "협업 운영센터 열기" 메시지를 하나 보내 고정한다.
//
// 왜 필요한가: 작업 현황판 버튼은 /tasks 응답에 붙는데, 그 메시지는 대화가 쌓이면 위로
// 밀려 올라가 찾을 수 없다. 방장이 작업 현황판을 열 때마다 /tasks 를 다시 쳐야 한다.
// Telegram 의 메뉴 버튼은 그룹에서 안 된다(getChatMenuButton 이 그룹 chat_id 를
// 400 invalid chat_id 로 거부한다 — 라이브 확인). 그룹에서 항상 같은 자리에 두는
// 수단은 고정 메시지뿐이다.
//
// 왜 /tasks 응답을 고정하지 않는가: 그 메시지는 만들어진 시점의 작업 목록을 본문에
// 담고 있어서 고정해두면 낡은 목록이 방 맨 위에 박제된다. 그래서 목록이 없는
// 작업 현황판 전용 메시지를 따로 만든다 — 본문은 안 낡고, 최신 상태는 버튼을 눌러서 본다.
// 링크 형식(?startapp=<roomId>)을 여기 베껴 쓰지 않는다. 봇이 /tasks 에 붙이는 버튼과
// 고정 메시지의 버튼이 조금이라도 달라지면 고정된 쪽만 조용히 엉뚱한 방을 연다.
// 그래서 봇이 실제로 쓰는 그 함수를 빌드 산출물에서 그대로 가져온다(pnpm run build 필요).
import { buildMiniAppDirectLink } from "../dist/packages/telegram-ui/src/index.js";

const APPLY = process.argv.includes("--apply");

// 고정 메시지 생성 경로는 폐기했다. 기존 메시지 정리는 별도 안전 스크립트로 한다.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  console.log("협업 운영센터 고정 메시지 생성은 비활성화되었습니다. 기존 메시지 삭제는 scripts/remove-room-board-message.mjs 를 사용하세요.");
  process.exit(0);
}

export const BOARD_MESSAGE_TEXT = "📋 협업 운영센터 — 이 방의 작업과 승인 대기를 한 화면에서 봅니다.";

// 우리 봇이 올린 현황판 메시지는 앞머리 기호로 알아본다.
export const BOARD_MESSAGE_MARKER = "📋";

// 이미 방에 고정되어 있는 우리 메시지의 옛 문구들. 문구는 여러 번 바뀌었고("작업 현황판"
// → "협업 운영센터", 방 단위 → 주제 단위), 운영 방에 남아 있는 것은 대부분 옛 문구다.
// 최신 문구 하나만 알고 있으면 정작 지워야 할 것을 남의 메시지로 오인해 손도 못 댄다.
// 실제로 방에 나간 문구만 넣는다. 나가지 않은 문구를 넣으면 삭제 대상을 넓히기만 하고
// 대조 목록의 근거를 흐린다 — "협업 운영센터 — 이 주제" 판은 그 문구를 보내던 코드
// (ensureTopicBoardRows)가 같은 변경에서 삭제돼 한 번도 전송된 적이 없어 제외한다.
export const LEGACY_BOARD_MESSAGE_TEXTS = [
  // 방 단위 고정 — scripts/pin-room-board-message.mjs (50e75b1)
  "📋 작업 현황판 — 이 방의 작업과 승인 대기를 한 화면에서 봅니다.",
  // 주제 단위 고정 — apps/bot-service/src/supabase-store.ts TOPIC_BOARD_MESSAGE_TEXT (d35293b)
  "📋 작업 현황판 — 이 주제의 작업과 승인 대기를 한 화면에서 봅니다."
];

export const KNOWN_BOARD_MESSAGE_TEXTS = [BOARD_MESSAGE_TEXT, ...LEGACY_BOARD_MESSAGE_TEXTS];

// 우리가 올린 현황판 메시지인지 판정한다. 마커만 보면 방장이 올린 다른 📋 공지까지
// 삼키므로, 우리가 실제로 써 온 문구 목록과 대조한다.
export function isKnownBoardMessageText(text) {
  return KNOWN_BOARD_MESSAGE_TEXTS.includes(String(text ?? "").trim());
}

// 이미 우리가 고정해 둔 메시지인지 판정한다. 방장이 직접 고정한 다른 메시지를
// 덮어쓰면 안 되고, 실행할 때마다 새 메시지를 만들어 방을 어지럽혀도 안 된다.
//
// 본문 앞부분을 그대로 비교하지 않는다. 문구를 한 번 다듬으면(예: "작업 현황판" →
// "작업 현황판") 이미 고정해 둔 우리 메시지를 남의 것으로 오인해서, 갱신도 못 하고
// 새로 올리지도 못한 채 옛 문구가 방 맨 위에 계속 남는다.
export function needsBoardPin(pinnedMessage, botId) {
  if (!pinnedMessage) return true;
  const fromBot = Number(pinnedMessage.from?.id) === Number(botId);
  const isBoardMessage = String(pinnedMessage.text ?? "").trimStart().startsWith(BOARD_MESSAGE_MARKER);
  return !(fromBot && isBoardMessage);
}

// 고정된 것이 우리 현황판인데 문구가 낡았으면 본문만 고친다. 새로 올려 고정하면
// 방에 같은 메시지가 하나씩 쌓인다.
export function boardPinNeedsRewording(pinnedMessage, botId) {
  if (needsBoardPin(pinnedMessage, botId)) return false;
  return String(pinnedMessage.text ?? "").trim() !== BOARD_MESSAGE_TEXT;
}

export function buildBoardMessagePayload(chatId, roomId, directLinkBaseUrl) {
  return {
    chat_id: chatId,
    text: BOARD_MESSAGE_TEXT,
    // 고정 메시지에 링크 미리보기가 붙으면 고정 바가 불필요하게 커진다.
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: "협업 운영센터 열기", url: buildMiniAppDirectLink(directLinkBaseUrl, roomId) }]]
    }
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const token = requireEnv("BOT_SERVICE_LEADER_BOT_TOKEN");
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
      if (!boardPinNeedsRewording(chat.pinned_message, botId)) {
        console.log(`  유지    ${label} — 이미 현황판이 고정돼 있다`);
        skipped += 1;
        continue;
      }
      if (!APPLY) {
        console.log(`  문구갱신예정 ${label}`);
        pinned += 1;
        continue;
      }
      try {
        await telegram(token, "editMessageText", {
          chat_id: chatId,
          message_id: chat.pinned_message.message_id,
          text: BOARD_MESSAGE_TEXT,
          disable_web_page_preview: true,
          reply_markup: buildBoardMessagePayload(chatId, room.room_id, directLinkBaseUrl).reply_markup
        });
        console.log(`  문구갱신 ${label}`);
        pinned += 1;
      } catch (error) {
        console.log(`  실패    ${label} — ${String(error.message).slice(0, 120)}`);
        failed += 1;
      }
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
