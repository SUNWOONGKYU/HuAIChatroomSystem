import { type ExecutionRequest } from "../../contracts/src/index.js";

export type CommandPlan = {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
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
        "sonnet",
        "--output-format",
        "text",
        `--add-dir=${request.projectPath}`,
        request.prompt
      ],
      request.projectPath,
      request.timeoutMs
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

function platformPlan(command: string, args: readonly string[], cwd: string, timeoutMs: number): CommandPlan {
  if (process.platform !== "win32") return { executable: command, args, cwd, timeoutMs };
  if (command === "codex") {
    return {
      executable: process.execPath,
      args: [codexEntrypoint(), ...args],
      cwd,
      timeoutMs
    };
  }
  if (command === "claude") {
    return {
      executable: claudeExecutable(),
      args,
      cwd,
      timeoutMs
    };
  }
  return { executable: command, args, cwd, timeoutMs };
}

function codexEntrypoint(): string {
  return process.env.CODEX_JS_ENTRYPOINT ?? "C:\\Users\\home\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
}

function claudeExecutable(): string {
  return process.env.CLAUDE_CODE_EXECUTABLE ?? "C:\\Users\\home\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
}