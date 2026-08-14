import { type ExecutionRequest } from "../../contracts/src/index.js";

export type CommandPlan = {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  // 프롬프트는 명령줄이 아니라 stdin 으로 넘긴다.
  // 대화 맥락 뭉치를 통째로 실으면 Windows 명령줄 길이 한계에 걸리고,
  // 멀티라인이 잘려 나가는 문제도 생긴다.
  stdinInput?: string;
};

export type AiAdapter = {
  type: ExecutionRequest["adapterType"];
  buildCommand(request: ExecutionRequest): CommandPlan;
  supportsCancel: boolean;
};

export function resolveAdapterCommand(request: ExecutionRequest): readonly string[] {
  const plan = resolveAdapterPlan(request);
  return [plan.executable, ...plan.args];
}

export function resolveAdapterPlan(request: ExecutionRequest): CommandPlan {
  const isAudit = request.reportBotRole === "auditor";
  if (request.adapterType === "claude_code") {
    return platformPlan(
      "claude",
      [
        "--print",
        "--permission-mode",
        isAudit ? "dontAsk" : "acceptEdits",
        "--model",
        request.model ?? "sonnet",
        "--output-format",
        "text",
        `--add-dir=${request.projectPath}`,
        // 이전 세션을 이어받으면 소대장이 방의 맥락을 기억한다.
        ...(request.resumeSessionId ? ["--resume", request.resumeSessionId] : [])
      ],
      request.projectPath,
      request.timeoutMs,
      // 프롬프트는 argv 가 아니라 stdin 으로. 대화 맥락 뭉치를 실으면 명령줄 길이 한계에 걸린다.
      request.prompt
    );
  }

  return platformPlan(
    "codex",
    [
      "exec",
      "--ignore-user-config",
      "--skip-git-repo-check",
      ...(isAudit ? ["--sandbox", "read-only"] : ["--approve-for-me"]),
      "--add-dir",
      request.projectPath,
      "--json",
      "--",
      request.prompt
    ],
    request.projectPath,
    request.timeoutMs
  );
}

function platformPlan(command: string, args: readonly string[], cwd: string, timeoutMs: number, stdinInput?: string): CommandPlan {
  if (process.platform !== "win32") return { executable: command, args, cwd, timeoutMs, stdinInput };
  if (command === "codex") {
    return {
      executable: process.execPath,
      args: [codexEntrypoint(), ...args],
      cwd,
      timeoutMs,
      stdinInput
    };
  }
  if (command === "claude") {
    return {
      executable: claudeExecutable(),
      args,
      cwd,
      timeoutMs,
      stdinInput
    };
  }
  return { executable: command, args, cwd, timeoutMs, stdinInput };
}

function codexEntrypoint(): string {
  return process.env.CODEX_JS_ENTRYPOINT ?? "C:\\Users\\home\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
}

function claudeExecutable(): string {
  return process.env.CLAUDE_CODE_EXECUTABLE ?? "C:\\Users\\home\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
}