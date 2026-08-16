// 방 존재(active) + 요청자의 active 멤버십을 확인하는 공통 게이트.
// miniapp-tasks 와 miniapp-proposals 둘 다 "이 telegram_user_id 가 이 방을 볼 수 있는가"를
// 똑같이 물어야 한다 — 각자 다시 구현하면 두 곳에서 규칙이 갈릴 수 있다(팀장님이 지적한
// huai_can_act_in_room vs orchestrator 권한 불일치와 같은 종류의 문제를 여기서는 처음부터
// 만들지 않는다).
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { MembershipCheckResult } from "./types.ts";

export type { MembershipCheckResult };

export async function assertRoomReadAccess(
  supabase: SupabaseClient,
  roomId: string,
  telegramUserId: string
): Promise<MembershipCheckResult> {
  const { data: room, error: roomError } = await supabase
    .from("huai_rooms")
    .select("room_id, purpose, status")
    .eq("room_id", roomId)
    .maybeSingle();
  if (roomError) {
    console.error(`miniapp-auth: room lookup failed: ${roomError.message}`);
    return { ok: false, status: 500, message: "lookup-failed" };
  }
  if (!room || room.status !== "active") return { ok: false, status: 404, message: "not-found" };

  const { data: membership, error: membershipError } = await supabase
    .from("huai_room_members")
    .select("role")
    .eq("room_id", roomId)
    .eq("telegram_user_id", telegramUserId)
    .eq("status", "active")
    .maybeSingle();
  if (membershipError) {
    console.error(`miniapp-auth: membership lookup failed: ${membershipError.message}`);
    return { ok: false, status: 500, message: "lookup-failed" };
  }
  if (membership) {
    return { ok: true, room: { roomId: room.room_id, purpose: room.purpose }, viewerRole: membership.role };
  }

  // huai_room_members 에 없어도, 그 방의 Telegram 참가자면 현황판을 볼 수 있다.
  //
  // 등록 절차를 따로 두면 방에 초대된 사람마다 방장이 손으로 넣어줘야 하고, 그전까지는
  // "이 방의 작업 현황판을 볼 권한이 없습니다"만 본다 — 라이브에서 실제로 그렇게 막혔다.
  // 방에 초대하는 것 자체가 "이 방 일을 봐도 된다"는 뜻이므로 그 사실을 그대로 쓴다.
  //
  // 링크만 알면 되는 구조로 열지는 않는다. 요청은 이미 Telegram initData 서명 검증을
  // 통과해야 하고(_shared/miniapp-auth.ts), 거기서 나온 사용자 ID 가 이 방 참가자인지를
  // Telegram 에 다시 확인한다. 링크가 새도 방 밖 사람은 데이터를 못 본다.
  //
  // 보는 것과 정하는 것은 가른다. 승인·보완·거부는 여기가 아니라 miniapp-approve 가
  // owner 만 허용한다 — 이 완화는 열람에만 적용된다.
  const chatMembership = await checkTelegramChatMembership(supabase, roomId, telegramUserId);
  if (chatMembership === "member") {
    return { ok: true, room: { roomId: room.room_id, purpose: room.purpose }, viewerRole: "human_member" };
  }
  if (chatMembership === "unavailable") {
    // Telegram 에 못 물어보면 등록된 멤버만 보던 예전 동작으로 돌아간다. 확인이 안 되는
    // 상태에서 열어주면 그게 곧 구멍이다.
    return { ok: false, status: 403, message: "forbidden" };
  }
  return { ok: false, status: 403, message: "forbidden" };
}

type TelegramChatMembership = "member" | "outsider" | "unavailable";

async function checkTelegramChatMembership(
  supabase: SupabaseClient,
  roomId: string,
  telegramUserId: string
): Promise<TelegramChatMembership> {
  const botToken = Deno.env.get("TELEGRAM_PLATOON_BOT_TOKEN");
  if (!botToken) return "unavailable";

  const { data: room, error } = await supabase
    .from("huai_rooms")
    .select("telegram_chat_id")
    .eq("room_id", roomId)
    .maybeSingle();
  if (error || !room?.telegram_chat_id) return "unavailable";

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(String(room.telegram_chat_id))}&user_id=${encodeURIComponent(telegramUserId)}`
    );
    const body = await response.json() as { ok?: boolean; result?: { status?: string } };
    if (!body.ok) return "outsider";
    // 나갔거나 쫓겨난 사람은 방 참가자가 아니다.
    const status = String(body.result?.status ?? "");
    return status === "left" || status === "kicked" ? "outsider" : "member";
  } catch (cause) {
    console.error(`miniapp-auth: telegram membership lookup failed: ${String(cause).slice(0, 200)}`);
    return "unavailable";
  }
}
