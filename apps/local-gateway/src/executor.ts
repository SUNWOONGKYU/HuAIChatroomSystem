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
import { readFile } from "node:fs/promises";
import { type ArtifactCollector, sha256Hex, toArtifactUri } from "./artifact-collector.js";
import { publishWebArtifacts } from "./artifact-publisher.js";
import { type ScreenshotCapturer } from "./screenshot.js";

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
  // 배포된 .html 산출물의 미리보기 스크린샷을 찍는다. 없으면(스킵) 링크만 나간다 —
  // 예전과 완전히 동일한 동작이다.
  screenshot?: ScreenshotCapturer;
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
      if (input.screenshot) {
        const screenshotArtifacts = await captureScreenshots(
          input.screenshot,
          collection.artifacts,
          published.publishedUrlByPath,
          input.request.projectPath
        );
        for (const artifact of screenshotArtifacts) {
          events.push({
            type: "artifact_collected",
            taskId: input.request.taskId,
            attemptId: input.request.attemptId,
            artifact
          });
        }
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


// 배포 주소가 붙은 .html 산출물마다 미리보기 스크린샷을 찍어 별도 산출물로 만든다.
// 이름은 "-preview.png" 로 끝낸다 — WORKING_ARTIFACT_PATTERN(-broken/-debug/-temp 등)에
// 안 걸려야 방으로 실제 전달된다(packages/supabase-runtime 의 isDeliverableDocument 참고).
// 실패해도(예: chromium 미설치) 실행 자체는 성공으로 남는다 — 링크는 이미 나갔다.
export async function captureScreenshots(
  capturer: ScreenshotCapturer,
  artifacts: readonly ArtifactManifest[],
  publishedUrlByPath: Map<string, string>,
  projectPath: string
): Promise<ArtifactManifest[]> {
  const results: ArtifactManifest[] = [];
  for (const artifact of artifacts) {
    if (!/\.html?$/i.test(artifact.path)) continue;
    const publicUrl = publishedUrlByPath.get(artifact.path);
    if (!publicUrl) continue;

    const screenshotRelPath = artifact.path.replace(/\.html?$/i, "-preview.png");
    const screenshotAbsPath = `${projectPath}/${screenshotRelPath}`;
    try {
      await capturer.capture({ url: publicUrl, outPath: screenshotAbsPath });
      const bytes = await readFile(screenshotAbsPath);
      results.push({
        path: screenshotRelPath,
        sizeBytes: bytes.length,
        checksum: sha256Hex(bytes),
        version: artifact.version,
        uri: toArtifactUri(projectPath, screenshotRelPath)
      });
    } catch (error) {
      console.error(JSON.stringify({
        type: "screenshot_capture_failed",
        artifactPath: artifact.path,
        reason: maskSensitiveOutput(error instanceof Error ? error.message : String(error))
      }));
    }
  }
  return results;
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

      // Codex CLI 자체 프로토콜 신호(모델이 만든 item.text 가 아니라 CLI가 직접 내는 최상위
      // 에러 이벤트) — looksLikeUsageLimitNotice 주석이 경계하는 사고(작업 산출물 안에 "한도"
      // 단어가 우연히 들어간 것을 오탐)는 item.text/item.message 처럼 모델이 자유롭게 쓰는
      // 필드에서만 일어난다. 여기는 CLI가 직접 보내는 통제 이벤트라 성격이 다르므로
      // adapterType 제한(allowUsageLimit) 없이 항상 본다.
      // 실측 사고(2026-08-23): codex 가 이 형태로 한도를 통보했는데 adapterType 제한에 걸려
      // 못 잡고 "exit-code-1"로만 남았다 — 폴백 자체는 (다른 층인 shouldFallbackToOtherEngine
      // 이 원문 텍스트를 직접 정규식으로 봐서) 정상 작동했지만, huai_outbox.last_error 가
      // 원인을 못 담아 운영 상태판에 "조사 필요"로 잘못 떴다.
      if (event.type === "error" && typeof event.message === "string") {
        const protocolFailure = classifyFailureText(event.message, { allowUsageLimit: true });
        if (protocolFailure) return protocolFailure;
      }
      if (event.type === "turn.failed" && typeof event.error?.message === "string") {
        const protocolFailure = classifyFailureText(event.error.message, { allowUsageLimit: true });
        if (protocolFailure) return protocolFailure;
      }

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
  if (/gemini-web-cdp-unavailable/i.test(text)) return "gemini-web-cdp-unavailable";
  if (/gemini-web-login-required/i.test(text)) return "gemini-web-login-required";
  if (/gemini-web-submit-failed/i.test(text)) return "gemini-web-submit-failed";
  if (/gemini-web-response-timeout/i.test(text)) return "gemini-web-response-timeout";
  if (/gemini-web-new-response-missing/i.test(text)) return "gemini-web-new-response-missing";
  if (/gemini-web-session-failed/i.test(text)) return "gemini-web-session-failed";
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
  message?: string;
  error?: { message?: string };
  item?: {
    type?: string;
    text?: string;
    message?: string;
  };
};
