import { existsSync } from "node:fs";
import path from "node:path";
import { normalizeAiAdapterType, type ExecutionRequest } from "../../contracts/src/index.js";

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
  //   리더 판단 — 아직 방장 승인 전이다. 판단하면서 파일을 고치면
  //                "승인된 작업만 실행된다"(FR-008)가 통째로 뚫린다.
  const isAudit = request.reportBotRole === "auditor";
  const isPlanning = request.attemptId.startsWith("leader-planning-");
  const readOnly = isAudit || isPlanning;
  const adapterType = normalizeAiAdapterType(request.adapterType);
  if (adapterType === "claude_code") {
    return platformPlan(
      "claude",
      [
        "--print",
        "--permission-mode",
        // 읽기 전용(dontAsk)은 그대로 둔다 — 검증자·리더 판단이 파일을 고치면
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
        // 이전 세션을 이어받으면 리더가 방의 맥락을 기억한다.
        ...(request.resumeSessionId ? ["--resume", request.resumeSessionId] : [])
      ],
      request.projectPath,
      request.timeoutMs,
      // 프롬프트는 argv 가 아니라 stdin 으로. 대화 맥락 뭉치를 실으면 명령줄 길이 한계에 걸린다.
      request.prompt
    );
  }

  // Gemini 웹 실행기. antigravity 는 기존 DB/메시지의 레거시 값이므로 같은 경로로
  // 해석한다. Gemini 웹은 로컬 파일을 수정하지 않고 답변만 반환한다.
  if (adapterType === "gemini_web") {
    return platformPlan(
      process.execPath,
      [
        geminiWebBridgeEntrypoint(),
        "--timeout",
        String(Math.max(10, Math.ceil(request.timeoutMs / 1000)))
      ],
      request.projectPath,
      request.timeoutMs,
      request.prompt
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

// 브리지는 이 저장소 안에 있다. 절대경로를 박으면 다른 PC·다른 체크아웃에서 조용히
// 없는 파일을 가리키고, 실행은 "no output produced" 로만 실패해 원인이 안 보인다.
// 빌드 산출물(dist/…)에서도 같은 저장소 루트를 찾아 올라간다.
const GEMINI_WEB_BRIDGE_RELATIVE_PATH = path.join("scripts", "gemini-web-adapter.mjs");

function geminiWebBridgeEntrypoint(): string {
  const configured = process.env.GEMINI_WEB_BRIDGE_ENTRYPOINT;
  if (configured) return configured;

  let dir = import.meta.dirname;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, GEMINI_WEB_BRIDGE_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 없는 경로로 조용히 실행해 "no output produced" 로 끝나는 것보다, 무엇을 못 찾았는지
  // 이름을 달고 즉시 실패하는 편이 원인 추적이 된다.
  throw new Error("gemini-web-bridge-entrypoint-not-found:" + GEMINI_WEB_BRIDGE_RELATIVE_PATH);
}
