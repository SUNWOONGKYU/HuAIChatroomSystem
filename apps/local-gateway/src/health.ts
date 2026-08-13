import { createServer, type Server } from "node:http";

export type LocalGatewayHealthState = {
  startedAt: string;
  configured: boolean;
  lastTickAt?: string;
  consecutiveErrors: number;
  lastError?: string;
};

export type LocalGatewayHealthOptions = {
  state: LocalGatewayHealthState;
  readinessCheck?: () => Promise<void>;
};

export function createLocalGatewayHealthServer(options: LocalGatewayHealthOptions): Server {
  return createServer((req, res) => {
    void route(req.url ?? "", options)
      .then(({ status, body }) => writeJson(res, status, body))
      .catch(() => writeJson(res, 503, { ok: false, service: "local-gateway", ready: false }));
  });
}

async function route(url: string, options: LocalGatewayHealthOptions): Promise<{ status: number; body: Record<string, unknown> }> {
  const pathname = new URL(url, "http://localhost").pathname;
  if (pathname === "/healthz") {
    return {
      status: options.state.configured ? 200 : 503,
      body: {
        ok: options.state.configured,
        service: "local-gateway",
        startedAt: options.state.startedAt,
        lastTickAt: options.state.lastTickAt,
        consecutiveErrors: options.state.consecutiveErrors,
        hasLastError: Boolean(options.state.lastError),
        lastError: options.state.lastError
      }
    };
  }

  if (pathname === "/readyz") {
    try {
      await options.readinessCheck?.();
      return { status: 200, body: { ok: true, service: "local-gateway", ready: true } };
    } catch {
      return { status: 503, body: { ok: false, service: "local-gateway", ready: false } };
    }
  }

  return { status: 404, body: { ok: false } };
}

function writeJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function maskHealthError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/(apikey|authorization|service_role)(["':\s]+)([A-Za-z0-9._-]+)/gi, "$1$2<redacted>");
}
