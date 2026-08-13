import { type CommandPlan } from "../../../packages/ai-adapters/src/index.js";
import {
  type ExecutionRequest,
  type GatewayEvent
} from "../../../packages/contracts/src/index.js";
import {
  maskSensitiveOutput,
  planExecution,
  type GatewayPolicy
} from "./index.js";

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

export async function executeGatewayRequest(input: {
  request: ExecutionRequest;
  policy: GatewayPolicy;
  runner: ProcessRunner;
  sink: GatewayEventSink;
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

    const agentFailure = classifyAgentFailure(result);
    if (result.exitCode === 0 && !agentFailure) {
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


export function classifyAgentFailure(result: ProcessRunResult): string | undefined {
  const stderrFailure = classifyFailureText(result.stderr);
  if (stderrFailure) return stderrFailure;

  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as AgentJsonEvent;
      const item = event.item;
      if (event.type === "item.completed" && item?.type === "error") return "agent-reported-error";
      const textFailure = classifyFailureText(typeof item?.text === "string" ? item.text : "");
      if (textFailure) return textFailure;
      const messageFailure = classifyFailureText(typeof item?.message === "string" ? item.message : "");
      if (messageFailure) return messageFailure;
    } catch {
      continue;
    }
  }

  return classifyFailureText(result.stdout);
}

function classifyFailureText(text: string): string | undefined {
  if (!text) return undefined;
  if (/read-only sandbox|workspace is read-only|writing is blocked|patch rejected/i.test(text)) return "agent-write-blocked";
  if (/rejected by user approval settings/i.test(text)) return "agent-approval-blocked";
  if (/Unable to write|could not be created|could not be modified/i.test(text)) return "agent-reported-write-failure";
  return undefined;
}

type AgentJsonEvent = {
  type?: string;
  item?: {
    type?: string;
    text?: string;
    message?: string;
  };
};