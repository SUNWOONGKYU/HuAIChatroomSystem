import { spawn } from "node:child_process";
import { type CommandPlan } from "../../../packages/ai-adapters/src/index.js";

export function createNodeProcessRunner() {
  return {
    run(plan: CommandPlan) {
      return runCommand(plan);
    }
  };
}

function runCommand(plan: CommandPlan): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.args], {
      cwd: plan.cwd,
      shell: false,
      // stdinInput 이 없으면 ignore — CLI 가 입력을 기다리며 멈추지 않게 한다.
      stdio: [plan.stdinInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildProcessEnv(process.env)
    });
    if (plan.stdinInput !== undefined && child.stdin) {
      child.stdin.end(plan.stdinInput, "utf8");
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const settleResolve = (value: { exitCode: number; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(value);
    };
    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      forceKillTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000);
      settleReject(new Error("process-timeout"));
    }, plan.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settleReject(error);
    });
    child.on("close", (code) => {
      settleResolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
export function buildChildProcessEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "NVM_HOME",
    "NVM_SYMLINK",
    "CODEX_HOME"
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}