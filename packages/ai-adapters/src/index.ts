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
  // 읽기만 허용해야 하는 실행.
  //   감사   — 검증자는 의견서만 낸다. 직접 고치면 자기검증이 된다 (AC-07).
  //   소대장 판단 — 아직 방장 승인 전이다. 판단하면서 파일을 고치면
  //                "승인된 작업만 실행된다"(FR-008)가 통째로 뚫린다.
  const isAudit = request.reportBotRole === "auditor";
  const isPlanning = request.attemptId.startsWith("leader-planning-");
  const readOnly = isAudit || isPlanning;
  if (request.adapterType === "claude_code") {
    return platformPlan(
      "claude",
      [
        "--print",
        "--permission-mode",
        // 읽기 전용(dontAsk)은 그대로 둔다 — 검증자·소대장 판단이 파일을 고치면
        // AC-07/FR-008 이 뚫린다(위 readOnly 주석 참고).
        //
        // 비-읽기전용(승인된 실행)은 이전엔 acceptEdits 였는데, 이건 파일 편집과
        // mkdir/touch/rm/rmdir/mv/cp/sed 같은 극히 일부 파일시스템 Bash 명령만
        // 자동 승인하고 그 외 Bash(빌드, curl, 브라우저 자동화 스크립트 등)는 여전히
        // 승인을 묻는다 — --print 비대화형 세션엔 응답자가 없어 그 자리에서 막힌다
        // (실제로 ClaudeBot 이 실행 승인 대기로 멈춰 정적 분석만 하고 끝난 라이브 사고).
        // codex 는 같은 "승인된 작업" 분류에서 --approve-for-me 로 전부 자동 승인받는데
        // claude_code 만 손발이 묶여 있었다 — bypassPermissions 로 맞춰 대등하게 만든다.
        // 근거는 codex 와 동일하다: 방장이 이미 명시 승인했고, 게이트웨이가 projectPath 를
        // allowedProjectRoots 안으로 이미 제한한다.
        readOnly ? "dontAsk" : "bypassPermissions",
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
      ...(readOnly ? ["--sandbox", "read-only"] : ["--approve-for-me"]),
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