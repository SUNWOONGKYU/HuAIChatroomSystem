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
        // text 였을 때는 session_id 가 stdout 어디에도 안 실려서 --resume 이 한 번도
        // 못 걸렸다(실측 확인 — codex 의 thread_id 미스매치와 같은 종류의 결함).
        // json 은 단일 JSON 객체를 돌려주고 그 안에 session_id·result(사람이 읽을 답)가
        // 둘 다 있다(claude --print --output-format json 실제 호출로 확인:
        // {"type":"result","result":"...","session_id":"...",...}). 사람이 볼 텍스트는
        // supabase-runtime 의 extractClaudeAgentMessage 가 이 JSON 에서 result 필드를
        // 꺼내 쓴다 — 그 짝을 안 맞추면 방에 JSON 원문이 그대로 뜬다.
        "json",
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

  // Antigravity 터미널판(agy). IDE 실행기(antigravity)와 다른 별도 CLI이고, 이쪽에만
  // --print 비대화형 모드가 있다.
  //
  // 세 번째 엔진이 있으면 한 엔진이 사용 한도에 걸려도 감사를 작업자와 다른 엔진에
  // 맡길 수 있다 — 둘뿐일 때는 Codex 가 막히면 Claude 가 자기 일을 검사하게 된다.
  if (request.adapterType === "antigravity") {
    return platformPlan(
      "agy",
      [
        // 프롬프트는 --print 의 값이다. agy 는 Go 플래그를 쓰므로 --print 다음에 다른
        // 플래그를 두면 그게 프롬프트로 먹히고, 첫 비플래그 인자에서 파싱이 멈춰 뒤의
        // 플래그가 통째로 무시된다. 라이브에서 그 탓에 권한 플래그가 사라져 감사가
        // "no output produced — 권한이 자동 거부됨" 으로 빈손으로 끝났다.
        "--print",
        request.prompt,
        "--output-format",
        "text",
        // agy 에는 읽기 전용 모드가 없다. --mode plan 은 계획서만 쓰고 승인을 기다려
        // 비대화형에서 아무것도 하지 않고, --sandbox 는 5분 자체 타임아웃까지 응답이
        // 없었다(둘 다 실측). 그래서 감사도 같은 권한으로 돌린다 — Claude 의 dontAsk,
        // Codex 의 --sandbox read-only 에 해당하는 자리가 이 CLI 에는 비어 있다.
        // 감사가 파일을 고치지 않아야 한다는 요구(AC-07)는 여기서는 프롬프트로만
        // 지켜지므로, 읽기 전용이 강제되는 Claude·Codex 보다 약하다.
        "--dangerously-skip-permissions",
        `--add-dir=${request.projectPath}`,
        // agy 의 기본 대기는 5분이다. 게이트웨이가 더 길게 기다려도 CLI 가 먼저 끊는다.
        "--print-timeout",
        `${Math.ceil(request.timeoutMs / 1000)}s`,
        ...(request.model ? ["--model", request.model] : [])
      ],
      request.projectPath,
      request.timeoutMs
    );
  }

  // 이전 세션을 이어받으면 방 맥락을 다시 안 쌓아도 된다(claude_code 의 --resume 과 동급).
  // `codex exec resume <id> [prompt]` 서브커맨드가 실제로 있다(codex exec resume --help
  // 로 실측 확인) — 문제는 이 서브커맨드 옵션 목록에 --sandbox·--approve-for-me·--add-dir
  // 가 없다는 것이다. 세션을 처음 만들 때(resumeSessionId 가 없는 첫 호출) 이 코드가
  // 항상 readOnly 여부에 맞는 승인 모드로 세션을 열므로, 이어받는 세션도 그 모드를 그대로
  // 물려받는다는 가정으로 짰다 — 다만 이 가정은 Codex 사용량 한도(2026-08-20 리셋 예정)에
  // 걸려 라이브로 끝까지 확인은 못 했다. 최악의 경우도 무한 정지가 아니라 게이트웨이
  // 타임아웃으로 실패·재시도되는 선에서 그친다(기존 timeoutMs 킬 로직이 그대로 적용됨).
  if (request.resumeSessionId) {
    return platformPlan(
      "codex",
      ["exec", "resume", request.resumeSessionId, "--ignore-user-config", "--skip-git-repo-check", "--json", "--", request.prompt],
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