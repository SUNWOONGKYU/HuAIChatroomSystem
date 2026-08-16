import { type CommandPlan } from "../../../packages/ai-adapters/src/index.js";
import {
  type ArtifactManifest,
  type ExecutionRequest,
  type GatewayEvent
} from "../../../packages/contracts/src/index.js";
import {
  maskSensitiveOutput,
  planExecution,
  type GatewayPolicy
} from "./index.js";
import { type ArtifactCollector } from "./artifact-collector.js";
import { publishWebArtifacts } from "./artifact-publisher.js";

export type ProcessRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ProcessRunner = {
  run(plan: CommandPlan): Promise<ProcessRunResult>;
};

export type GatewayEventSink = {
  publish(event: GatewayEvent): Promise<void>;
};

export type ExecutionResult = {
  status: "completed" | "failed" | "rejected";
  retryable: boolean;
  events: GatewayEvent[];
};

// 올린 주소가 있으면 산출물에 실어 보낸다. 없으면 원래 모양 그대로 — 문서 산출물이나
// 배포가 꺼진 환경에서는 아무것도 달라지지 않는다.
function publishedUrlOrPlain(
  artifact: ArtifactManifest,
  publishedUrlByPath: Map<string, string>
): ArtifactManifest {
  const publicUrl = publishedUrlByPath.get(artifact.path);
  return publicUrl ? { ...artifact, publicUrl } : artifact;
}

export async function executeGatewayRequest(input: {
  request: ExecutionRequest;
  policy: GatewayPolicy;
  runner: ProcessRunner;
  sink: GatewayEventSink;
  artifacts?: ArtifactCollector;
  // 웹 산출물을 올릴 Vercel 프로젝트. 없으면 올리지 않는다(기능 스위치).
  artifactVercelProject?: string;
  now?: () => string;
}): Promise<ExecutionResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const decision = planExecution(input.request, input.policy);

  if (decision.kind === "rejected") {
    const event: GatewayEvent = {
      type: "failed",
      taskId: input.request.taskId,
      attemptId: input.request.attemptId,
      errorKind: decision.reason,
      retryable: false
    };
    await input.sink.publish(event);
    return { status: "rejected", retryable: false, events: [event] };
  }

  const plan = decision.plan;
  const events: GatewayEvent[] = [
    { type: "accepted", taskId: input.request.taskId, attemptId: input.request.attemptId },
    { type: "started", taskId: input.request.taskId, attemptId: input.request.attemptId, at: now() }
  ];

  for (const event of events) {
    await input.sink.publish(event);
  }

  const startedAtMs = startedAtMillis(events);

  try {
    const result = await input.runner.run(plan);
    if (result.stdout) {
      events.push({
        type: "stdout",
        taskId: input.request.taskId,
        attemptId: input.request.attemptId,
        text: maskSensitiveOutput(result.stdout)
      });
    }
    if (result.stderr) {
      events.push({
        type: "stderr",
        taskId: input.request.taskId,
        attemptId: input.request.attemptId,
        text: maskSensitiveOutput(result.stderr)
      });
    }

    const agentFailure = classifyAgentFailure(result, input.request.adapterType);
    if (result.exitCode === 0 && !agentFailure) {
      const collection = await collectArtifacts(input.artifacts, input.request, startedAtMs);
      // 웹 산출물은 올려서 주소를 붙인다. 실패해도 작업은 성공이다 — 결과물은 이미 만들어졌다.
      const published = await publishWebArtifacts(collection.artifacts, { vercelProject: input.artifactVercelProject });
      if (published.failureReason) {
        events.push({
          type: "artifact_collection_failed",
          taskId: input.request.taskId,
          attemptId: input.request.attemptId,
          reason: published.failureReason
        });
      }
      for (const artifact of collection.artifacts) {
        events.push({
          type: "artifact_collected",
          taskId: input.request.taskId,
          attemptId: input.request.attemptId,
          artifact: publishedUrlOrPlain(artifact, published.publishedUrlByPath)
        });
      }
      if (collection.failureReason) {
        events.push({
          type: "artifact_collection_failed",
          taskId: input.request.taskId,
          attemptId: input.request.attemptId,
          reason: collection.failureReason
        });
      }
      events.push({ type: "completed", taskId: input.request.taskId, attemptId: input.request.attemptId, at: now() });
      await publishNewEvents(events, input.sink, 2);
      return { status: "completed", retryable: false, events };
    }

    if (agentFailure) {
      events.push({
        type: "failed",
        taskId: input.request.taskId,
        attemptId: input.request.attemptId,
        errorKind: agentFailure,
        retryable: true
      });
      await publishNewEvents(events, input.sink, 2);
      return { status: "failed", retryable: true, events };
    }

    events.push({
      type: "failed",
      taskId: input.request.taskId,
      attemptId: input.request.attemptId,
      errorKind: `exit-code-${result.exitCode}`,
      retryable: true
    });
    await publishNewEvents(events, input.sink, 2);
    return { status: "failed", retryable: true, events };
  } catch (error) {
    const message = maskSensitiveOutput(error instanceof Error ? error.message : String(error));
    const event: GatewayEvent = {
      type: "failed",
      taskId: input.request.taskId,
      attemptId: input.request.attemptId,
      errorKind: message,
      retryable: true
    };
    events.push(event);
    await publishNewEvents(events, input.sink, 2);
    return { status: "failed", retryable: true, events };
  }
}

async function publishNewEvents(events: GatewayEvent[], sink: GatewayEventSink, startIndex: number): Promise<void> {
  for (const event of events.slice(startIndex)) {
    await sink.publish(event);
  }
}

function startedAtMillis(events: readonly GatewayEvent[]): number {
  const started = events.find((event): event is Extract<GatewayEvent, { type: "started" }> => event.type === "started");
  const parsed = started ? Date.parse(started.at) : Number.NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

// 수집 실패는 실행 자체를 실패시키지 않는다. 다만 조용히 삼키지도 않는다 —
// 산출물이 통째로 유실됐는데 "완료"만 보고되면 운영자가 알 방법이 없다.
async function collectArtifacts(
  collector: ArtifactCollector | undefined,
  request: ExecutionRequest,
  startedAtMs: number
): Promise<{ artifacts: ArtifactManifest[]; failureReason?: string }> {
  if (!collector) return { artifacts: [] };
  try {
    return { artifacts: await collector.collect({ request, startedAtMs }) };
  } catch (error) {
    const reason = maskSensitiveOutput(error instanceof Error ? error.message : String(error));
    console.error(JSON.stringify({
      type: "artifact_collection_failed",
      taskId: request.taskId,
      attemptId: request.attemptId,
      reason
    }));
    return { artifacts: [], failureReason: reason };
  }
}


export function classifyAgentFailure(result: ProcessRunResult, adapterType: string = "codex"): string | undefined {
  const allowUsageLimit = adapterType === "claude_code";
  if (result.exitCode !== 0 && isAgentToolError(result.stderr)) return "agent-tool-error";

  const stderrFailure = classifyFailureText(result.stderr, { allowUsageLimit });
  if (stderrFailure) return stderrFailure;

  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as AgentJsonEvent;
      const item = event.item;
      if (event.type === "item.completed" && item?.type === "error") return "agent-reported-error";
      const textFailure = classifyFailureText(typeof item?.text === "string" ? item.text : "", { allowUsageLimit });
      if (textFailure) return textFailure;
      const messageFailure = classifyFailureText(typeof item?.message === "string" ? item.message : "", { allowUsageLimit });
      if (messageFailure) return messageFailure;
    } catch {
      continue;
    }
  }

  return adapterType === "claude_code" ? classifyFailureText(result.stdout, { allowUsageLimit }) : undefined;
}

function classifyFailureText(text: string, options: { allowUsageLimit: boolean }): string | undefined {
  if (!text) return undefined;
  if (options.allowUsageLimit && /hit your (?:session |usage |weekly )?limit|usage limit|session limit|weekly limit|rate limit|limit reached|resets?\s+(?:at\s+)?\d/i.test(text)) return "agent-usage-limit";
  if (/read-only sandbox|workspace is read-only|writing is blocked|patch rejected/i.test(text)) return "agent-write-blocked";
  if (/rejected by user approval settings/i.test(text)) return "agent-approval-blocked";
  if (/Unable to write|could not be created|could not be modified/i.test(text)) return "agent-reported-write-failure";
  return undefined;
}

function isAgentToolError(text: string): boolean {
  return /codex_core::tools::router: error=|An empty pipe element is not allowed|timeout_ms must be at least 10000/i.test(text);
}

type AgentJsonEvent = {
  type?: string;
  item?: {
    type?: string;
    text?: string;
    message?: string;
  };
};
