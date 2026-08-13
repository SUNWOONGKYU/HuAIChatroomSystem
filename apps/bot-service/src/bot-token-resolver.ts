import { type TelegramBotRole } from "../../../packages/contracts/src/index.js";
import { type TelegramBotTokenResolver } from "./outbox.js";

const TELEGRAM_BOT_ROLES: readonly TelegramBotRole[] = [
  "platoon_leader",
  "claude_leader",
  "codex_leader",
  "auditor"
] as const;

export const DEFAULT_TELEGRAM_BOT_TOKEN_SECRET_REFS: Record<TelegramBotRole, string> = {
  platoon_leader: "env:BOT_SERVICE_PLATOON_BOT_TOKEN",
  claude_leader: "env:BOT_SERVICE_CLAUDE_BOT_TOKEN",
  codex_leader: "env:BOT_SERVICE_CODEX_BOT_TOKEN",
  auditor: "env:BOT_SERVICE_AUDITOR_BOT_TOKEN"
};

export type TelegramBotTokenSecretRefs = Record<TelegramBotRole, string>;

export function buildTelegramBotTokenResolverFromEnv(env: NodeJS.ProcessEnv = process.env): TelegramBotTokenResolver {
  const secretRefs = parseTelegramBotTokenSecretRefs(env);
  const tokens = new Map<TelegramBotRole, string>();
  const seenRefs = new Set<string>();
  const seenTokens = new Set<string>();

  for (const role of TELEGRAM_BOT_ROLES) {
    const secretRef = secretRefs[role];
    if (seenRefs.has(secretRef)) {
      throw new Error(`duplicate-telegram-bot-token-secret-ref:${role}`);
    }
    seenRefs.add(secretRef);

    const token = resolveTokenSecretRef(env, secretRef);
    if (seenTokens.has(token)) {
      throw new Error(`duplicate-telegram-bot-token:${role}`);
    }
    seenTokens.add(token);
    tokens.set(role, token);
  }

  return {
    async resolveBotToken(botRole) {
      const token = tokens.get(botRole);
      if (!token) {
        throw new Error(`missing-telegram-bot-token-role:${botRole}`);
      }
      return token;
    }
  };
}

export function parseTelegramBotTokenSecretRefs(env: NodeJS.ProcessEnv = process.env): TelegramBotTokenSecretRefs {
  const raw = env.BOT_SERVICE_BOT_TOKEN_SECRET_REFS_JSON;
  if (!raw) {
    return { ...DEFAULT_TELEGRAM_BOT_TOKEN_SECRET_REFS };
  }

  const parsed = JSON.parse(raw) as Partial<Record<TelegramBotRole, unknown>>;
  const refs = {} as TelegramBotTokenSecretRefs;
  for (const role of TELEGRAM_BOT_ROLES) {
    const ref = parsed[role];
    if (typeof ref !== "string" || !ref.trim()) {
      throw new Error(`missing-telegram-bot-token-secret-ref:${role}`);
    }
    refs[role] = ref.trim();
  }
  return refs;
}

function resolveTokenSecretRef(env: NodeJS.ProcessEnv, secretRef: string): string {
  if (!secretRef.startsWith("env:")) {
    throw new Error(`unsupported-telegram-bot-token-secret-ref:${secretRefKind(secretRef)}`);
  }

  const envKey = secretRef.slice("env:".length);
  if (!envKey) {
    throw new Error("invalid-telegram-bot-token-secret-ref:env");
  }

  const token = env[envKey];
  if (!token) {
    throw new Error(`missing-env:${envKey}`);
  }
  return token;
}

function secretRefKind(secretRef: string): string {
  const separatorIndex = secretRef.indexOf(":");
  return separatorIndex === -1 ? "unknown" : secretRef.slice(0, separatorIndex);
}
