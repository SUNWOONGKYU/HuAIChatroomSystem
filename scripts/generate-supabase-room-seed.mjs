import {
  deriveActors,
  deriveBots,
  deriveGateway,
  resolveRoomSeedConfig
} from "./room-seed-derivation.mjs";

// 이 스크립트는 순수 SQL 생성기다 — DB/네트워크에 접속하지 않는다(fetch/http 없음).
// uuid 파생·CLI 인자 해석은 room-seed-derivation.mjs 가 유일한 출처다. 온보딩 CLI
// (scripts/onboard-telegram-room.mjs) 도 같은 모듈을 써서 같은 입력에 같은 uuid 를 낸다.
export function generateSupabaseRoomSeed(env, argv = []) {
  const config = resolveRoomSeedConfig(env, argv);
  const actors = deriveActors(config.roomId);
  const bots = deriveBots(actors, config.env);
  const gateway = deriveGateway(config);

  return [
    "begin;",
    `insert into huai_rooms (room_id, telegram_chat_id, owner_telegram_user_id, purpose, status) values (${sql(config.roomId)}::uuid, ${sql(config.telegramChatId)}, ${sql(config.ownerTelegramUserId)}, ${sql(config.purpose)}, 'active') on conflict (room_id) do update set telegram_chat_id = excluded.telegram_chat_id, owner_telegram_user_id = excluded.owner_telegram_user_id, purpose = excluded.purpose, status = excluded.status;`,
    `insert into huai_room_members (room_id, telegram_user_id, role, permissions, status) values (${sql(config.roomId)}::uuid, ${sql(config.ownerTelegramUserId)}, 'owner', '{"approve":true,"final_approve":true,"manage_ai_actors":true}'::jsonb, 'active') on conflict (room_id, telegram_user_id) do update set role = excluded.role, permissions = excluded.permissions, status = excluded.status;`,
    // huai_ai_actors 에는 config 컬럼이 없다(schema.sql/라이브 DB 둘 다 없음 — 예전에
    // 여기서 그 컬럼에 값을 실었다가 라이브 온보딩이 PGRST204 로 전부 실패했다).
    ...actors.map((actor) => `insert into huai_ai_actors (actor_id, room_id, role, adapter_type, status) values (${sql(actor.actorId)}::uuid, ${sql(config.roomId)}::uuid, ${sql(actor.role)}, ${sql(actor.adapterType)}, 'active') on conflict (actor_id) do update set role = excluded.role, adapter_type = excluded.adapter_type, status = excluded.status;`),
    // conflict 타깃은 bot_username(unique) 으로 잡는다. 봇은 room 과 무관하므로
    // 여러 방을 시딩해도 같은 봇 행 하나로 수렴해야 한다. actor_id 는 이제
    // 정보성 참조일 뿐이라 다른 방의 시딩이 앞서 시딩된 방의 actor_id 를
    // 덮어쓰면 안 되므로 update 대상에서 제외한다. telegram_bot_id 도 PK 라 제외.
    ...bots.map((bot) => `insert into huai_telegram_bots (telegram_bot_id, bot_username, role, actor_id, token_secret_ref, webhook_secret_ref, status) values (${sql(bot.botId)}::uuid, ${sql(bot.username)}, ${sql(bot.role)}, ${sql(bot.actorId)}::uuid, ${sql(bot.tokenSecretRef)}, ${sql(bot.webhookSecretRef)}, 'active') on conflict (bot_username) do update set role = excluded.role, token_secret_ref = excluded.token_secret_ref, webhook_secret_ref = excluded.webhook_secret_ref, status = excluded.status;`),
    // status 는 do update set 에서 제외한다. 재시딩(예: allowed roots 확장)이 이미
    // 'online'으로 떠 있는 실 게이트웨이의 상태를 'offline'으로 되돌려버리면 안 된다 —
    // status 는 최초 등록 시에만 채우고, 이후 실제 운영 상태(heartbeat 등)가 소유한다.
    `insert into huai_gateway_instances (gateway_id, room_id, machine_label, allowed_project_roots, allowed_adapters, status) values (${sql(gateway.gatewayInstanceId)}::uuid, ${sql(config.roomId)}::uuid, ${sql(gateway.machineLabel)}, ${sql(JSON.stringify(gateway.allowedProjectRoots))}::jsonb, ${sql(JSON.stringify(gateway.allowedAdapters))}::jsonb, 'offline') on conflict (gateway_id) do update set machine_label = excluded.machine_label, allowed_project_roots = excluded.allowed_project_roots, allowed_adapters = excluded.allowed_adapters;`,
    "commit;"
  ].join("\n");
}

function sql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  console.log(generateSupabaseRoomSeed(process.env, process.argv.slice(2)));
}
