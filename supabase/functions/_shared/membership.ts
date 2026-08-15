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
  if (!membership) return { ok: false, status: 403, message: "forbidden" };

  return { ok: true, room: { roomId: room.room_id, purpose: room.purpose }, viewerRole: membership.role };
}
