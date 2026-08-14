import { existsSync } from "node:fs";
import { join } from "node:path";

const required = [
  "apps/bot-service/src/index.ts",
  "apps/bot-service/src/http.ts",
  "apps/bot-service/src/cli.ts",
  "apps/bot-service/src/consumer.ts",
  "apps/bot-service/src/bot-token-resolver.ts",
  "apps/bot-service/src/fake-store.ts",
  "apps/bot-service/src/local-runtime.ts",
  "apps/bot-service/src/outbox.ts",
  "apps/bot-service/src/persistence.ts",
  "apps/bot-service/src/server.ts",
  "apps/bot-service/src/supabase-store.ts",
  "apps/bot-service/src/supabase-runtime-loader.ts",
  "apps/bot-service/test/outbox-consumer.test.ts",
  "apps/bot-service/test/bot-token-resolver.test.ts",
  "apps/bot-service/test/telegram-fetch-sender.test.ts",
  "apps/bot-service/test/callback-answer-sender.test.ts",
  "apps/bot-service/test/supabase-store.test.ts",
  "apps/bot-service/test/task-state-transition.test.ts",
  "apps/local-gateway/src/index.ts",
  "apps/local-gateway/src/consumer.ts",
  "apps/local-gateway/src/executor.ts",
  "apps/local-gateway/src/process-runner.ts",
  "apps/local-gateway/src/artifact-collector.ts",
  "apps/local-gateway/test/local-gateway-consumer.test.ts",
  "apps/local-gateway/test/process-runner.test.ts",
  "apps/local-gateway/test/artifact-collector.test.ts",
  "packages/supabase-runtime/test/artifact-persistence.test.ts",
  "scripts/verify-spec-coverage.mjs",
  "scripts/dry-run-spec.mjs",
  "scripts/build-if-needed.mjs",
  "scripts/start-services.mjs",
  "scripts/install-autostart.ps1",
  "apps/bot-service/src/polling.ts",
  "apps/bot-service/test/approval-ledger.test.ts",
  "packages/orchestrator/test/proposal-structure.test.ts",
  "packages/supabase-runtime/test/revision-loop.test.ts",
  "apps/bot-service/test/conversation-observation.test.ts",
  "packages/orchestrator/src/leader-planning.ts",
  "packages/orchestrator/test/leader-planning.test.ts",
  "packages/supabase-runtime/test/leader-planning-result.test.ts",
  "supabase/migrations/20260815100000_huai_leader_session.sql",
  "supabase/migrations/20260814220000_huai_approvals_entity_ref_and_append_only.sql",
  "supabase/migrations/20260814210000_huai_artifacts_unique_and_guards.sql",
  "packages/contracts/src/index.ts",
  "packages/workflow/src/index.ts",
  "packages/ai-adapters/src/index.ts",
  "packages/telegram-ui/src/index.ts",
  "packages/orchestrator/src/index.ts",
  "packages/orchestrator/test/owner-flow-outbox.test.ts",
  "packages/orchestrator/test/callback-answer-outbox.test.ts",
  "packages/supabase-runtime/src/index.ts",
  "2026_08_04__20.05_GATE2_제품_아키텍처.md",
  "2026_08_10__GATE6_LOCAL_GATEWAY_EXECUTION.md",
  "2026_08_10__GATE7_SUPABASE_RUNTIME_PERSISTENCE.md",
  "2026_08_10__GATE11_TELEGRAM_OUTBOX_OPERATION.md",
  "supabase/migrations/20260810112000_huai_outbox_processing_guards.sql",
  "2026_08_10__GATE12_OUTBOX_DUPLICATE_REPROCESSING.md",
  "supabase/schema.sql",
  "2026_08_04__17.25_TELEGRAM_전환_요구사항.md",
  "scripts/verify-operation-env.mjs",
  "scripts/verify-operation-env.test.mjs",
  "scripts/verify-operation-env-template.test.mjs",
  "2026_08_10__GATE13_OPERATION_ENV_PREFLIGHT.md",
  "scripts/generate-telegram-webhook-commands.mjs",
  "scripts/generate-telegram-webhook-commands.test.mjs",
  "scripts/apply-telegram-webhooks.mjs",
  "scripts/apply-telegram-webhooks.test.mjs",
  "scripts/verify-operation-ready.mjs",
  "scripts/verify-operation-ready.test.mjs",
  "scripts/discover-telegram-ids.mjs",
  "scripts/discover-telegram-ids.test.mjs",
  "scripts/check-telegram-bots.mjs",
  "scripts/check-telegram-bots.test.mjs",
  "scripts/check-telegram-webhooks.mjs",
  "scripts/check-telegram-webhooks.test.mjs",
  "scripts/inspect-outbox.mjs",
  "scripts/inspect-outbox.test.mjs",
  "scripts/generate-supabase-room-seed.mjs",
  "scripts/generate-supabase-room-seed.test.mjs",
  "2026_08_10__GATE16_SUPABASE_ROOM_SEED.md",
  "2026_08_10__GATE14_TELEGRAM_WEBHOOK_SETUP.md",
  "apps/bot-service/test/http-health.test.ts",
  "2026_08_10__GATE15_BOT_SERVICE_HEALTHZ.md",
  "apps/bot-service/test/runtime-selection.test.ts",
  "apps/bot-service/test/supabase-runtime-loader.test.ts",
  "apps/local-gateway/src/runtime.ts",
  "apps/local-gateway/src/cli.ts",
  "apps/local-gateway/src/supabase-store.ts",
  "apps/local-gateway/test/runtime.test.ts",
  "apps/local-gateway/test/supabase-outbox-store.test.ts",
  "apps/local-gateway/test/gateway-result-ingestion.test.ts",
  "apps/bot-service/test/http-webhook-e2e.test.ts",
  "2026_08_10__GATE17_WEBHOOK_HTTP_E2E.md",
  "apps/local-gateway/src/health.ts",
  "apps/local-gateway/test/health.test.ts",
  "2026_08_10__GATE18_LOCAL_GATEWAY_HEALTH_READINESS.md",
  "2026_08_10__GATE19_OPERATION_RUNBOOK.md",
  "2026_08_10__GATE20_GATEWAY_RESULT_INGESTION.md",
  "2026_08_10__GATE21_OWNER_VERIFICATION_COMPLETION_OUTBOX.md",
  "2026_08_10__GATE22_WORKFLOW_TASK_STATE_PERSISTENCE.md",
  "2026_08_10__GATE23_TELEGRAM_CALLBACK_ANSWER.md",
  "2026_08_10__GATE24_OPERATION_CHECK_SCRIPTS.md",
  "2026_08_10__GATE25_TELEGRAM_WEBHOOK_APPLY.md",
  "2026_08_10__GATE26_TELEGRAM_ID_DISCOVERY.md",
  "2026_08_10__GATE27_OPERATION_ENV_TEMPLATE.md",
  ".env.operation.example",
  "scripts/verify-operation-runbook.test.mjs",
  "tsconfig.build.json"
];

const missing = required.filter((path) => !existsSync(join(process.cwd(), path)));

if (missing.length > 0) {
  console.error("Missing required files:");
  for (const path of missing) console.error(`- ${path}`);
  process.exit(1);
}

console.log("Structure verification passed.");













