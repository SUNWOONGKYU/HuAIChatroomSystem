import { buildWebhookPlan, formatWebhookPlan } from "./apply-telegram-webhooks.mjs";
import { validateOperationEnv } from "./verify-operation-env.mjs";

const REQUIRED_ROOM_KEYS = [
  "BOT_SERVICE_TELEGRAM_CHAT_ID",
  "BOT_SERVICE_OWNER_TELEGRAM_USER_ID"
];

export function buildTelegramConnectionSequence(env) {
  const envErrors = validateOperationEnv(env, "all");
  const roomErrors = [];
  for (const key of REQUIRED_ROOM_KEYS) {
    if (!env[key]) roomErrors.push(`missing-env:${key}`);
  }

  const ready = envErrors.length === 0 && roomErrors.length === 0;
  const steps = [
    {
      id: "fill-env",
      status: ready ? "ready" : "blocked",
      command: "Load real values from .env.operation.example into the process environment.",
      note: "Bot tokens, webhook secrets, Supabase service role, chat id, owner id, and gateway roots are required."
    },
    {
      id: "discover-ids",
      status: env.BOT_SERVICE_TELEGRAM_CHAT_ID && env.BOT_SERVICE_OWNER_TELEGRAM_USER_ID ? "ready" : "blocked",
      command: "node scripts/discover-telegram-ids.mjs",
      note: "Use only before webhook activation after sending one human message in the target private group."
    },
    {
      id: "seed-room",
      status: ready ? "ready" : "blocked",
      command: "node scripts/generate-supabase-room-seed.mjs",
      note: "Apply generated SQL to Supabase after confirming role bot actor mapping."
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
    errors: [...envErrors, ...roomErrors],
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
