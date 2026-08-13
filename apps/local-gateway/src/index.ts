import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { type AiAdapterType, type ExecutionRequest } from "../../../packages/contracts/src/index.js";
import { resolveAdapterPlan, type CommandPlan } from "../../../packages/ai-adapters/src/index.js";

export type GatewayPolicy = {
  allowedProjectRoots: readonly string[];
  allowedAdapters: readonly AiAdapterType[];
  maxRuntimeMs: number;
  allowNetwork: boolean;
};

export type GatewayDecision =
  | { kind: "accepted"; plan: CommandPlan }
  | { kind: "rejected"; reason: string };

export function planExecution(request: ExecutionRequest, policy: GatewayPolicy): GatewayDecision {
  if (!isPathInsideAllowedRoots(request.projectPath, policy.allowedProjectRoots)) {
    return { kind: "rejected", reason: "project-path-not-allowed" };
  }

  if (!policy.allowedAdapters.includes(request.adapterType)) {
    return { kind: "rejected", reason: "adapter-not-allowed" };
  }

  if (request.timeoutMs > policy.maxRuntimeMs) {
    return { kind: "rejected", reason: "timeout-exceeds-policy" };
  }

  return {
    kind: "accepted",
    plan: resolveAdapterPlan(request)
  };
}

export function makeExecutionAttemptKey(taskId: string, attemptId: string): string {
  return `execution-attempt:${taskId}:${attemptId}`;
}

export function isPathInsideAllowedRoots(projectPath: string, allowedRoots: readonly string[]): boolean {
  const resolvedProject = safeRealpath(projectPath);
  if (!resolvedProject) return false;
  return allowedRoots.some((root) => {
    const resolvedRoot = safeRealpath(root);
    if (!resolvedRoot) return false;
    return resolvedProject === resolvedRoot || resolvedProject.startsWith(`${resolvedRoot}${sep}`);
  });
}

export function maskSensitiveOutput(text: string): string {
  return text
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TELEGRAM_TOKEN]")
    .replace(/\b(?:sk|pk|rk|service_role)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_SECRET]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

function normalizeForCompare(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function safeRealpath(path: string): string | undefined {
  try {
    return normalizeForCompare(realpathSync(resolve(path)));
  } catch {
    return undefined;
  }
}


