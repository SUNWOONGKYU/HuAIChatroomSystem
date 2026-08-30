import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  handleTelegramWebhookFastAck,
  type BotServiceConfig,
  type TelegramWebhookPorts
} from "./index.js";
import { type TelegramWebhookAck } from "../../../packages/contracts/src/index.js";
import { type BotServiceReadinessResult } from "./readiness.js";

export type TelegramWebhookHttpServerOptions = {
  config: BotServiceConfig;
  ports: TelegramWebhookPorts;
  maxBodyBytes?: number;
  // /readyz 판정. 안 넘기면(테스트 등에서 저수준 API 를 직접 쓸 때) 확인할 의존성이
  // 없다고 보고 항상 200 을 준다 — 실제 운영 기동 경로(server.ts)는 항상 채워 넘긴다.
  readiness?: () => Promise<BotServiceReadinessResult>;
};

export function createTelegramWebhookHttpServer(options: TelegramWebhookHttpServerOptions): Server {
  return createServer((req, res) => {
    void routeHttpRequest(req, res, options);
  });
}

async function routeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: TelegramWebhookHttpServerOptions
): Promise<void> {
  const pathname = new URL(req.url ?? "", "http://localhost").pathname;

  if (req.method === "GET" && pathname === "/healthz") {
    writeJson(res, 200, {
      ok: true,
      service: "bot-service",
      bots: options.config.botsByUsername.size,
      allowedChats: options.config.allowedChatIds.length
    });
    return;
  }

  // /healthz 는 설정값만 보는 liveness 다. Telegram 수신이 멎었거나 Supabase 가 끊겨도
  // 200 이라 "curl 200 ≠ 동작함" 을 어긴다 — /readyz 는 실제 의존성을 확인한다.
  if (req.method === "GET" && pathname === "/readyz") {
    if (!options.readiness) {
      writeJson(res, 200, { ok: true, service: "bot-service", ready: true });
      return;
    }
    const result = await options.readiness();
    writeJson(res, result.ready ? 200 : 503, {
      ok: result.ready,
      service: "bot-service",
      ready: result.ready,
      checks: result.checks
    });
    return;
  }

  if (req.method !== "POST") {
    writeJson(res, 404, { ok: false });
    return;
  }

  const botUsername = extractBotUsername(req.url ?? "");
  if (!botUsername) {
    writeJson(res, 404, { ok: false });
    return;
  }

  const payload = await readJsonBody(req, options.maxBodyBytes ?? 1024 * 1024);
  if (!payload.ok) {
    writeJson(res, 200, { httpStatus: 200, queued: false, reason: "malformed-update" } satisfies TelegramWebhookAck);
    return;
  }

  const secretToken = headerValue(req, "x-telegram-bot-api-secret-token");
  const ack = await handleTelegramWebhookFastAck(
    { botUsername, secretToken, receivedAt: new Date().toISOString() },
    payload.value,
    options.config,
    options.ports
  );

  writeJson(res, 200, ack);
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "body-too-large" | "invalid-json" }> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      return { ok: false, reason: "body-too-large" };
    }
    chunks.push(buffer);
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}

function extractBotUsername(url: string): string | undefined {
  const parsed = new URL(url, "http://localhost");
  const match = /^\/telegram\/webhook\/([^/]+)$/.exec(parsed.pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

