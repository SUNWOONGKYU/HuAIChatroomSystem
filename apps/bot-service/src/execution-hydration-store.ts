// God file 분리(2026-08, 3차) — supabase-store.ts 에서 뽑아낸 실행 요청 파이프라인.
// commitTelegramInputResult 가 outbox 행을 만든 직후, 실행 트리거(실행 시작 알림/
// 리더 판단 프롬프트/실행 요청 프롬프트)에 필요한 정보를 outbox row 에 채워 넣는다
// (=hydrate). SupabaseBotServiceStore 와 같은 SupabaseRestClient 인스턴스를 그대로
// 주입받아 동작은 바꾸지 않는다 — 순수 리팩터링(클래스 분리)이다.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { maskTelegramSensitiveText as maskSensitiveText } from "../../../packages/telegram-ui/src/sanitize.js";
import { type TaskStatus } from "../../../packages/workflow/src/index.js";
import { isLeaderPlanningAttempt } from "../../../packages/orchestrator/src/index.js";
import {
  buildLeaderPlanningPrompt,
  extractPersonaTag,
  type AgentPersona,
  type RoomFacts,
  type RoomTurn
} from "../../../packages/orchestrator/src/leader-planning.js";
import { createNodeGitRunner, ensureWorktree } from "../../local-gateway/src/worktree.js";
import {
  type ExecutionActorRole,
  type ProposalExecutionHint,
  type OutboxInsertRow,
  type ExecutionActorRow,
  DEFAULT_COMPLETION_CRITERIA,
  taskStatusMeta,
  requestedExecutionRolesForHint,
  buildMultiAiExecutionRows,
  promptWithRiskQuiz,
  proposalExecutionModeFromPayload,
  roomTurnFromRawUpdate,
  botLabelForRole,
  executionWorkerLabel,
  proposalTitleFromPayload,
  proposalFieldFromPayload,
  proposalRequestTextFromPayload,
  proposalIdNeedingPromptHydration,
  executionRequestPayload,
  proposalPromptFromPayload,
  proposalActorRoleFromPayload,
  uuidFromProposalId,
  taskIdempotencyKey
} from "./command-prompt-helpers.js";
import { type ApprovalStage, escapePostgrestInValue, optionalPayloadString } from "./event-row-mapping.js";
import { SupabaseRestClient } from "./rest-client.js";

// 리더 프롬프트에 넣을 방 기억의 양. 최근 며칠 / 하루치 최대 글자.
// 너무 넣으면 최근 지시가 밀려나고, 너무 적으면 지난 결정을 못 찾는다.
const ROOM_MEMORY_DAYS = 5;
const ROOM_MEMORY_MAX_CHARS = 2_000;

export class SupabaseExecutionHydrationStore {
  constructor(
    private readonly client: SupabaseRestClient,
    // 방 기억(위키)을 읽어올 폴더. 아카이브 스크립트가 쓰는 자리와 같아야 한다.
    private readonly archiveRootDir: string
  ) {}

  // "작업 실행을 시작했습니다: p_032d2db2..." 처럼 내부 id 만 보여주면
  // 방장은 무슨 작업이 시작됐는지, 누가 하는지 알 수 없다.
  // 리더가 이미 제목과 담당을 정해뒀으니 그것을 실어 보낸다.
  async hydrateExecutionStartedMessages(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const targets = rows.filter((row) => row.idempotency_key.startsWith("telegram:execution-started:"));
    if (targets.length === 0) return rows;

    const proposalIds = Array.from(new Set(targets.map((row) => row.idempotency_key.split(":")[2]).filter(Boolean)));
    const hints = await this.fetchProposalExecutionHints(proposalIds, roomId);

    return rows.map((row) => {
      if (!row.idempotency_key.startsWith("telegram:execution-started:")) return row;
      const hint = hints.get(row.idempotency_key.split(":")[2] ?? "");
      if (!hint?.title) return row;
      const worker = executionWorkerLabel(hint.requestedActorRole, hint.executionMode);
      return {
        ...row,
        payload: {
          ...row.payload,
          text: [
            `작업을 시작했습니다: ${hint.title}`,
            worker ? `담당: ${worker}` : undefined,
            hint.completionCriteria ? `완료 조건: ${hint.completionCriteria}` : undefined,
            "",
            "작업에는 보통 몇 분이 걸립니다. 끝나면 결과를 보고하겠습니다."
          ].filter((line) => line !== undefined).join("\n")
        }
      };
    });
  }

  // 리더 판단 요청에 방의 직전 논의를 실어준다.
  // 오케스트레이터는 순수 함수라 DB 를 못 읽으므로 여기서 채운다.
  async hydrateLeaderPlanningRows(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const request = executionRequestPayload(row.payload);
      if (!request || typeof request.attemptId !== "string" || !isLeaderPlanningAttempt(request.attemptId)) {
        hydrated.push(row);
        continue;
      }
      const rawTriggeringText = typeof row.payload.triggeringText === "string" ? row.payload.triggeringText : "";
      // "!페르소나이름 지시" 형태면 등록된 페르소나를 찾아 프롬프트에 실어준다. 못 찾으면
      // 태그를 떼지 않고 그대로 평범한 요청으로 취급한다 — 오타로 지시 자체가 사라지면 안 된다.
      const personaTag = extractPersonaTag(rawTriggeringText);
      const persona = personaTag ? await this.fetchAgentPersona(roomId, personaTag.personaName) : undefined;
      const triggeringText = persona && personaTag ? personaTag.remainingText : rawTriggeringText;
      const telegramChatId = typeof row.payload.telegramChatId === "string" ? row.payload.telegramChatId : undefined;
      const turns = telegramChatId ? await this.fetchRecentRoomTurns(telegramChatId, roomId) : [];
      const leader = await this.fetchLeaderActor(roomId);
      const facts = await this.fetchRoomFacts(roomId, await this.fetchRoomLabel(roomId));
      hydrated.push({
        ...row,
        payload: {
          ...row.payload,
          executionRequest: {
            ...request,
            prompt: buildLeaderPlanningPrompt({ turns, triggeringText, facts, persona }),
            ...(leader?.actor_id ? { actorId: leader.actor_id } : {}),
            ...(leader?.cli_session_id ? { resumeSessionId: leader.cli_session_id } : {})
          }
        }
      });
    }
    return hydrated;
  }

  // 직전 논의 뭉치 — 마지막으로 작업이 만들어진 시점 이후의 방 대화.
  // 그 시점을 못 찾으면 최근 40건으로 자른다.
  private async fetchRecentRoomTurns(telegramChatId: string, roomId: string): Promise<RoomTurn[]> {
    const since = await this.fetchLastWorkCreatedAt(roomId);
    const ownerId = await this.fetchOwnerTelegramUserId(roomId);
    const filter = since ? "&received_at=gt." + encodeURIComponent(since) : "";
    const rows = await this.client
      .request(
        "GET",
        "/huai_telegram_updates?telegram_chat_id=eq." + encodeURIComponent(telegramChatId) +
          filter + "&select=raw_update,received_at&order=received_at.desc&limit=40"
      )
      .then((response) => response.json<Array<{ raw_update: Record<string, unknown>; received_at?: string }>>())
      .catch(() => []);

    return rows
      .map((row) => roomTurnFromRawUpdate(row.raw_update, ownerId))
      .filter((turn): turn is RoomTurn => Boolean(turn))
      .reverse();
  }

  private async fetchLastWorkCreatedAt(roomId: string): Promise<string | undefined> {
    const rows = await this.client
      .request("GET", "/huai_events?room_id=eq." + encodeURIComponent(roomId) + "&event_type=eq.owner_task_approved&select=created_at&order=created_at.desc&limit=1")
      .then((response) => response.json<Array<{ created_at?: string }>>())
      .catch(() => []);
    return rows[0]?.created_at;
  }

  private async fetchOwnerTelegramUserId(roomId: string): Promise<string | undefined> {
    const rows = await this.client
      .request("GET", "/huai_room_members?room_id=eq." + encodeURIComponent(roomId) + "&role=eq.owner&select=telegram_user_id&limit=1")
      .then((response) => response.json<Array<{ telegram_user_id: string | number }>>())
      .catch(() => []);
    const value = rows[0]?.telegram_user_id;
    return value === undefined || value === null ? undefined : String(value);
  }

  // 리더가 방에 대해 이미 알아야 하는 것.
  // 이게 없으면 "이 방에 봇이 몇 개야?" 같은 질문에도 조사 작업을 만든다 —
  // 자기가 모르니까 확인하겠다고 하는 것이고, 방장은 답을 원했는데 일이 하나 생긴다.
  // 방 기억을 세션 폴더에서 읽는다.
  //
  // 요약을 DB 에 넣지 않는 이유: 이 프로세스가 게이트웨이와 같은 작업 PC 에서 돈다.
  // 디스크를 직접 읽을 수 있으므로 DB 를 거칠 이유가 없고, 요약까지 DB 에 쌓으면 용량만
  // 늘어난다. 무손실 원본은 Supabase Storage 에 따로 있다.
  //
  // 못 읽어도 판단은 진행한다 — 기억이 얕아질 뿐이고, 그건 이 기능을 붙이기 전의 상태다.
  private async readRoomMemory(roomId: string, roomLabel: string): Promise<RoomFacts["memory"]> {
    try {
      const folder = roomLabel.replace(/[\/:*?"<>|]/g, "_").slice(0, 60);
      const dir = path.join(this.archiveRootDir, folder);
      const entries = await readdir(dir).catch(() => [] as string[]);
      const notes = entries.filter((name) => name.endsWith("_위키.md")).sort().slice(-ROOM_MEMORY_DAYS);
      const memory: Array<{ date: string; summary: string }> = [];
      for (const note of notes) {
        const text = await readFile(path.join(dir, note), "utf8").catch(() => "");
        if (!text.trim()) continue;
        // frontmatter 는 사람이 파일을 열었을 때를 위한 것이다. 프롬프트에는 본문만 넣는다.
        const body = text.replace(/^---[\s\S]*?---\n/, "").trim();
        memory.push({ date: note.replace("_위키.md", ""), summary: body.slice(0, ROOM_MEMORY_MAX_CHARS) });
      }
      return memory.length > 0 ? memory : undefined;
    } catch {
      return undefined;
    }
  }

  // 세션 폴더 이름은 방 이름으로 만들어진다(archive-room-conversations.mjs 와 같은 규칙).
  private async fetchRoomLabel(roomId: string): Promise<string | undefined> {
    try {
      const rows = await this.client
        .request("GET", "/huai_rooms?room_id=eq." + encodeURIComponent(roomId) + "&select=purpose&limit=1")
        .then((response) => response.json<Array<{ purpose?: string }>>());
      return rows[0]?.purpose || roomId;
    } catch {
      return undefined;
    }
  }

  private async fetchRoomFacts(roomId: string, roomLabel?: string): Promise<RoomFacts | undefined> {
    try {
      const [actors, members, tasks] = await Promise.all([
        this.client
          .request("GET", "/huai_ai_actors?room_id=eq." + encodeURIComponent(roomId) + "&status=eq.active&select=role")
          .then((response) => response.json<Array<{ role: string }>>()),
        this.client
          .request("GET", "/huai_room_members?room_id=eq." + encodeURIComponent(roomId) + "&status=eq.active&select=telegram_user_id")
          .then((response) => response.json<Array<{ telegram_user_id: string }>>()),
        this.client
          .request("GET", "/huai_tasks?room_id=eq." + encodeURIComponent(roomId) + "&status=not.in.(completed,cancelled,rejected_or_cancelled,proposal_rejected)&select=title,status&order=updated_at.desc&limit=8")
          .then((response) => response.json<Array<{ title: string; status: TaskStatus }>>())
      ]);

      return {
        bots: actors.map((actor) => botLabelForRole(actor.role)),
        memberCount: members.length,
        memory: roomLabel ? await this.readRoomMemory(roomId, roomLabel) : undefined,
        // TASK_STATUS_META 가 단일 출처다 — 별도 상태 라벨표를 여기 두지 않는다.
        // 이 결과는 리더 판단 프롬프트(buildLeaderPlanningPrompt)에 순수 텍스트로만
        // 들어간다: `${title}(${status})`. 파싱하는 코드는 없다(packages/orchestrator/src/leader-planning.ts 확인).
        openTasks: tasks.map((task) => ({ title: task.title, status: taskStatusMeta(task.status).label }))
      };
    } catch {
      // 방 정보를 못 읽어도 판단 자체는 진행한다. 맥락이 얕아질 뿐이다.
      return undefined;
    }
  }

  private async fetchLeaderActor(roomId: string): Promise<{ actor_id: string; cli_session_id?: string } | undefined> {
    const rows = await this.client
      .request("GET", "/huai_ai_actors?room_id=eq." + encodeURIComponent(roomId) + "&role=eq.leader&select=actor_id,cli_session_id&limit=1")
      .then((response) => response.json<Array<{ actor_id: string; cli_session_id?: string }>>())
      .catch(() => []);
    return rows[0];
  }

  private async fetchAgentPersona(roomId: string, personaName: string): Promise<AgentPersona | undefined> {
    const rows = await this.client
      .request(
        "GET",
        "/huai_agent_personas?room_id=eq." + encodeURIComponent(roomId) +
          "&persona_name=eq." + encodeURIComponent(personaName) +
          "&status=eq.active&select=persona_name,base_role,instructions&limit=1"
      )
      .then((response) => response.json<Array<{ persona_name: string; base_role: string; instructions: string }>>());
    const row = rows[0];
    if (!row || (row.base_role !== "claude_leader" && row.base_role !== "codex_leader")) return undefined;
    return { name: row.persona_name, baseRole: row.base_role, instructions: row.instructions };
  }

  async hydrateExecutionOutboxPrompts(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const proposalIds = Array.from(new Set(rows.map((row) => proposalIdNeedingPromptHydration(row)).filter((value): value is string => Boolean(value))));
    if (proposalIds.length === 0) return rows;

    const hintsByProposalId = await this.fetchProposalExecutionHints(proposalIds, roomId);
    const requestedRoles = Array.from(new Set(Array.from(hintsByProposalId.values()).flatMap((hint) => requestedExecutionRolesForHint(hint))));
    const actorsByRole = await this.fetchActiveExecutionActorsByRole(requestedRoles, roomId);
    const hydrated: OutboxInsertRow[] = [];

    for (const row of rows) {
      const proposalId = proposalIdNeedingPromptHydration(row);
      const hint = proposalId ? hintsByProposalId.get(proposalId) : undefined;
      if (!proposalId || !hint?.prompt) {
        hydrated.push(row);
        continue;
      }
      const executionRequest = executionRequestPayload(row.payload);
      if (!executionRequest) {
        hydrated.push(row);
        continue;
      }
      const primaryActor = hint.executionMode === "multi_ai_review"
        ? actorsByRole.get("codex_leader") ?? actorsByRole.get("claude_leader")
        : hint.requestedActorRole ? actorsByRole.get(hint.requestedActorRole) : undefined;
      const taskId = await this.ensureApprovedProposalTask(proposalId, hint, primaryActor?.actor_id, roomId);
      const isolatedProjectPath = hint.useIsolatedWorktree && typeof executionRequest.projectPath === "string"
        ? await this.ensureIsolatedWorktree(taskId, executionRequest.projectPath)
        : undefined;
      const taskExecutionRequest = {
        ...executionRequest,
        taskId,
        sourceProposalId: proposalId,
        ...(isolatedProjectPath ? { projectPath: isolatedProjectPath } : {})
      };
      if (hint.executionMode === "multi_ai_review") {
        hydrated.push(...buildMultiAiExecutionRows(row, taskExecutionRequest, hint, actorsByRole));
        continue;
      }
      const actor = hint.requestedActorRole ? actorsByRole.get(hint.requestedActorRole) : undefined;
      // reportBotRole 까지 함께 바꿔야 한다.
      // 예전에는 actorId·adapterType 만 바꿔서, 리더가 ClaudeBot 을 지정해도
      // 보고는 기본값인 CodexBot 이름으로 나갔다 — 방장이 보기에 배분이 무시된 것처럼 보인다.
      hydrated.push({
        ...row,
        payload: {
          ...row.payload,
          executionRequest: {
            ...taskExecutionRequest,
            ...(actor ? { actorId: actor.actor_id, adapterType: actor.adapter_type, reportBotRole: actor.role } : {}),
            prompt: promptWithRiskQuiz(hint.prompt, hint.rawText ?? hint.prompt)
          }
        }
      });
    }

    return hydrated;
  }

  // "버전 N개" 변형은 공유 프로젝트 폴더가 아니라 자기만의 git worktree 에서 돈다 —
  // 안 그러면 변형끼리 같은 파일을 밟는다(이 격리가 없으면 병렬 변형의 존재 이유가 없다).
  // taskId 하나마다 워크트리 하나(variantIndex 는 항상 1 — 여기 도달한 시점에 이미
  // "제안 1개 = 변형 1개 = 작업 1개"로 갈라져 있어서 taskId 자체가 이미 유일하다).
  // 실패해도(예: git 오류) 실행을 막지 않는다 — 공유 폴더로 폴백한다. 최악의 경우도
  // "격리가 덜 됐다"이지 "작업이 아예 안 됐다"가 아니다.
  private async ensureIsolatedWorktree(taskId: string, repoPath: string): Promise<string | undefined> {
    try {
      const handle = await ensureWorktree({ runner: createNodeGitRunner(), repoPath, taskId, variantIndex: 1 });
      return handle.path;
    } catch (error) {
      console.error(JSON.stringify({
        type: "isolated_worktree_create_failed",
        taskId,
        reason: maskSensitiveText(error instanceof Error ? error.message : String(error))
      }));
      return undefined;
    }
  }

  private async fetchProposalExecutionHints(proposalIds: readonly string[], roomId: string): Promise<Map<string, ProposalExecutionHint>> {
    if (proposalIds.length === 0) return new Map();
    // room_id 필터 없이 전역 최근 200건만 보면, 방이 늘수록 이 창이 남의 방 제안으로
    // 차서 자기 방 제안을 못 찾는다(approved-task-materialization-missing).
    const rows = await this.client
      .request("GET", "/huai_events?event_type=eq.proposal_created&room_id=eq." + encodeURIComponent(roomId) + "&select=payload,created_at&order=created_at.desc&limit=200")
      .then((response) => response.json<Array<{ payload: Record<string, unknown> }>>());
    const wanted = new Set(proposalIds);
    const hints = new Map<string, ProposalExecutionHint>();
    for (const row of rows) {
      const proposalId = typeof row.payload.proposalId === "string" ? row.payload.proposalId : undefined;
      if (!proposalId || !wanted.has(proposalId) || hints.has(proposalId)) continue;
      const prompt = proposalPromptFromPayload(row.payload);
      if (prompt) hints.set(proposalId, { prompt, messageThreadId: optionalPayloadString(row.payload.messageThreadId), title: proposalTitleFromPayload(row.payload), requestedActorRole: proposalActorRoleFromPayload(row.payload), executionMode: proposalExecutionModeFromPayload(row.payload), rawText: proposalRequestTextFromPayload(row.payload), purpose: proposalFieldFromPayload(row.payload, "purpose"), scope: proposalFieldFromPayload(row.payload, "scope"), completionCriteria: proposalFieldFromPayload(row.payload, "completionCriteria"), useIsolatedWorktree: row.payload.useIsolatedWorktree === true });
    }
    return hints;
  }

  private async fetchActiveExecutionActorsByRole(roles: readonly ExecutionActorRole[], roomId: string): Promise<Map<ExecutionActorRole, ExecutionActorRow>> {
    if (roles.length === 0) return new Map();
    const quoted = roles.map((role) => '"' + escapePostgrestInValue(role) + '"').join(",");
    const rows = await this.client
      .request("GET", "/huai_ai_actors?room_id=eq." + encodeURIComponent(roomId) + "&role=in.(" + encodeURIComponent(quoted) + ")&status=eq.active&select=actor_id,role,adapter_type")
      .then((response) => response.json<ExecutionActorRow[]>());
    return new Map(rows.map((row) => [row.role, row]));
  }

  private async ensureApprovedProposalTask(proposalId: string, hint: ProposalExecutionHint, assigneeActorId: string | undefined, roomId: string): Promise<string> {
    const proposalUuid = uuidFromProposalId(proposalId);
    const existing = proposalUuid ? await this.fetchTaskByProposalId(proposalUuid) : undefined;
    if (existing) return existing.task_id;

    if (proposalUuid) {
      await this.insertProposalIfMissing(proposalUuid, hint, roomId);
    }

    const taskRows = await this.insertTaskForProposal(proposalId, proposalUuid, hint, assigneeActorId, roomId);
    return taskRows[0]?.task_id ?? await this.fetchTaskIdByIdempotencyKey(taskIdempotencyKey(proposalId));
  }

  private async fetchTaskByProposalId(proposalUuid: string): Promise<{ task_id: string } | undefined> {
    const rows = await this.client
      .request("GET", "/huai_tasks?proposal_id=eq." + encodeURIComponent(proposalUuid) + "&select=task_id&limit=1")
      .then((response) => response.json<Array<{ task_id: string }>>());
    return rows[0];
  }

  private async fetchTaskIdByIdempotencyKey(idempotencyKey: string): Promise<string> {
    const rows = await this.client
      .request("GET", "/huai_tasks?idempotency_key=eq." + encodeURIComponent(idempotencyKey) + "&select=task_id&limit=1")
      .then((response) => response.json<Array<{ task_id: string }>>());
    const taskId = rows[0]?.task_id;
    if (!taskId) throw new Error("approved-task-materialization-missing");
    return taskId;
  }

  private async insertProposalIfMissing(proposalUuid: string, hint: ProposalExecutionHint, roomId: string): Promise<void> {
    const response = await this.client.request("POST", "/huai_task_proposals", {
      body: {
        proposal_id: proposalUuid,
        room_id: roomId,
        title: hint.title,
        purpose: hint.purpose ?? hint.title,
        scope: hint.scope ?? hint.rawText ?? hint.title,
        completion_criteria: hint.completionCriteria ?? DEFAULT_COMPLETION_CRITERIA,
        status: "approved",
        decided_at: new Date().toISOString()
      },
      prefer: "return=minimal"
    });
    if (response.status !== 409) await response.expectOk();
  }

  private async insertTaskForProposal(proposalId: string, proposalUuid: string | undefined, hint: ProposalExecutionHint, assigneeActorId: string | undefined, roomId: string): Promise<Array<{ task_id: string }>> {
    // 승인 원장은 절대 수정하지 않는다. 대신 task 를 만들 때 그 task 가 어느 승인으로 생겼는지를
    // 여기서 한 번 연결한다 (AC-08 "완료 전 3단계 승인 증거").
    const approvalId = await this.fetchApprovalIdForEntity(proposalId, "task_approval", roomId);
    const response = await this.client.request("POST", "/huai_tasks", {
      body: {
        room_id: roomId,
        proposal_id: proposalUuid ?? null,
        approved_by_approval_id: approvalId ?? null,
        assignee_actor_id: assigneeActorId ?? null,
        idempotency_key: taskIdempotencyKey(proposalId),
        status: "scheduled",
        title: hint.title,
        purpose: hint.purpose ?? hint.title,
        scope: hint.scope ?? hint.rawText ?? hint.title,
        completion_criteria: hint.completionCriteria ?? DEFAULT_COMPLETION_CRITERIA,
        // 현황판을 주제별로 가르는 값. 없으면 주제 없이 만들어진 작업이다.
        telegram_message_thread_id: hint.messageThreadId ?? null,
        use_isolated_worktree: hint.useIsolatedWorktree ?? false
      },
      prefer: "return=representation"
    });
    if (response.status === 409) return [{ task_id: await this.fetchTaskIdByIdempotencyKey(taskIdempotencyKey(proposalId)) }];
    return response.json<Array<{ task_id: string }>>();
  }

  private async fetchApprovalIdForEntity(entityRef: string, stage: ApprovalStage, roomId: string): Promise<string | undefined> {
    const rows = await this.client
      .request(
        "GET",
        "/huai_approvals?entity_ref=eq." + encodeURIComponent(entityRef) +
          "&stage=eq." + encodeURIComponent(stage) +
          "&room_id=eq." + encodeURIComponent(roomId) +
          "&decision=eq.approved&select=approval_id&order=created_at.asc&limit=1"
      )
      .then((response) => response.json<Array<{ approval_id: string }>>());
    return rows[0]?.approval_id;
  }
}
