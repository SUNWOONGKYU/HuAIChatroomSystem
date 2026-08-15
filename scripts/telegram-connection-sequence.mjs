import { buildWebhookPlan, formatWebhookPlan } from "./apply-telegram-webhooks.mjs";
import { validateOperationEnv } from "./verify-operation-env.mjs";

export function buildTelegramConnectionSequence(env) {
  const envErrors = validateOperationEnv(env, "all");

  // 다방화 이후 BOT_SERVICE_TELEGRAM_CHAT_ID/BOT_SERVICE_OWNER_TELEGRAM_USER_ID 는 이 전체
  // 시퀀스의 readiness 를 막을 이유가 없다 — 운영 env 파일 하나가 여러 방을 동시에 섬기고,
  // 새로 붙일 특정 방의 chat id/owner id 는 onboard-telegram-room.mjs 호출 시
  // --chat-id/--owner-id 인자로(또는 그 호출 한정 env 로) 넘긴다. 그래서 더 이상
  // roomErrors 를 ready 판정에 섞지 않는다. discover-ids 단계가 이미 "지금 알고
  // 있는지" 를 비차단 정보로 보여주므로 중복 차단할 이유도 없다.
  const ready = envErrors.length === 0;
  const steps = [
    {
      id: "fill-env",
      status: ready ? "ready" : "blocked",
      command: "Load real values from .env.operation.example into the process environment.",
      note: "Bot tokens, webhook secrets, Supabase service role, and gateway roots are required. Per-room chat id/owner id are supplied per onboarding call (see seed-room below), not globally."
    },
    {
      id: "discover-ids",
      status: env.BOT_SERVICE_TELEGRAM_CHAT_ID && env.BOT_SERVICE_OWNER_TELEGRAM_USER_ID ? "ready" : "blocked",
      command: "node scripts/discover-telegram-ids.mjs",
      note: "Optional shortcut before onboarding a specific room, after sending one human message in the target private group. Not required globally: onboard-telegram-room.mjs also accepts --chat-id/--owner-id directly."
    },
    {
      id: "seed-room",
      status: ready ? "ready" : "blocked",
      command: "node scripts/onboard-telegram-room.mjs --room-id <uuid> --chat-id <id> --owner-id <id> --project-path <path>",
      note: "Onboards one Telegram group as an operational room by upserting Supabase rows (idempotent, safe to re-run per room). Use scripts/generate-supabase-room-seed.mjs instead only when you want to eyeball the SQL before applying it by hand."
    },
    {
      id: "dry-run-webhooks",
      status: canBuildWebhookPlan(env) ? "ready" : "blocked",
      command: "node scripts/apply-telegram-webhooks.mjs --dry-run",
      note: "Confirms each role bot username maps to the public webhook URL without printing token values."
    },
    {
      id: "apply-webhooks",
      status: canBuildWebhookPlan(env) ? "ready" : "blocked",
      command: "node scripts/apply-telegram-webhooks.mjs --apply",
      note: "Performs the real Telegram setWebhook call for four distinct role bot accounts."
    },
    {
      id: "check-live",
      status: ready ? "ready" : "blocked",
      command: "node scripts/check-telegram-bots.mjs && node scripts/check-telegram-webhooks.mjs && node scripts/inspect-outbox.mjs",
      note: "Checks bot identities, webhook URLs, and Supabase outbox state without exposing secrets."
    },
    {
      id: "start-services",
      status: ready ? "ready" : "blocked",
      command: "Start apps/bot-service and apps/local-gateway with the same operation environment.",
      note: "Then run /newtask in the Telegram project group and verify the approval to local gateway path."
    }
  ];

  return {
    ready,
    errors: envErrors,
    webhookPlan: canBuildWebhookPlan(env) ? buildWebhookPlan(env) : [],
    steps
  };
}

export function formatTelegramConnectionSequence(sequence) {
  const lines = [
    `Telegram connection sequence: ${sequence.ready ? "READY" : "BLOCKED"}`
  ];
  if (sequence.errors.length > 0) {
    lines.push("Blocking checks:");
    for (const error of sequence.errors) lines.push(`- ${error}`);
  }
  if (sequence.webhookPlan.length > 0) {
    lines.push("Webhook plan:");
    lines.push(formatWebhookPlan(sequence.webhookPlan));
  }
  lines.push("Execution order:");
  for (const step of sequence.steps) {
    lines.push(`- [${step.status}] ${step.id}: ${step.command}`);
    lines.push(`  ${step.note}`);
  }
  return lines.join("\n");
}

function canBuildWebhookPlan(env) {
  try {
    buildWebhookPlan(env);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const sequence = buildTelegramConnectionSequence(process.env);
  console.log(formatTelegramConnectionSequence(sequence));
  if (!sequence.ready) process.exit(1);
}
