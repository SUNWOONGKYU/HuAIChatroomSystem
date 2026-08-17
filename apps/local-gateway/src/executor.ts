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

// CLI 가 낸 한도 통보인가, 아니면 결과물 안에 그 단어가 들어간 것뿐인가.
//
// 라이브 사고: 방장이 "코덱스 한도 초과면 클로드에게 시켜야 하지 않나"라고 물은 것이 작업이
// 됐고, ClaudeBot 이 한도 처리 코드를 점검한 보고서를 냈다. 그 보고서 본문에 usage limit /
// limit reached 가 들어 있었고, 우리는 그걸 "Claude 가 한도에 걸렸다"로 읽었다. 성공한 실행이
// 실패로 뒤집혀 Codex 로 넘어갔고, Codex 는 진짜 한도라 거기서 작업이 끝났다.
//
// 진짜 통보는 짧고, 초기화 시각을 함께 말한다. 긴 산출물 한가운데의 같은 단어와는 그 점이
// 다르다. 판정을 놓치는 쪽(폴백 안 됨)이 성공을 실패로 뒤집는 쪽보다 낫다 — 전자는 방장이
// 다시 시키면 되고, 후자는 이미 한 일을 버린다.
export function looksLikeUsageLimitNotice(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const mentionsLimit = /hit your (?:session |usage |weekly )?limit|usage limit|session limit|weekly limit|limit reached/i.test(trimmed);
  if (!mentionsLimit) return false;
  // 초기화 시각을 말하면 통보로 본다. 길이와 무관하다.
  if (/resets?\s+(?:at\s+)?|try again (?:at|after)|다시 시도/i.test(trimmed)) return true;
  // 그 외에는 짧을 때만. 보고서 본문은 이 길이를 넘는다.
  return trimmed.length <= 400;
}

function classifyFailureText(text: string, options: { allowUsageLimit: boolean }): string | undefined {
  if (!text) return undefined;
  if (options.allowUsageLimit && looksLikeUsageLimitNotice(text)) return "agent-usage-limit";
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
