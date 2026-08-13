import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  handleTelegramWebhookFastAck,
  type BotServiceConfig,
  type TelegramWebhookPorts
} from "./index.js";
import { type TelegramWebhookAck } from "../../../packages/contracts/src/index.js";

export type TelegramWebhookHttpServerOptions = {
  config: BotServiceConfig;
  ports: TelegramWebhookPorts;
  maxBodyBytes?: number;
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
  if (req.method === "GET" && new URL(req.url ?? "", "http://localhost").pathname === "/healthz") {
    writeJson(res, 200, {
      ok: true,
      service: "bot-service",
      bots: options.config.botsByUsername.size,
      allowedChats: options.config.allowedChatIds.length
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

