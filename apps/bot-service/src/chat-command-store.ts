// God file 분리(2026-08, 3차) — supabase-store.ts 에서 뽑아낸 명시적 슬래시 명령
// 응답(페르소나·전문 AI·방·참여자 등록, 방장 제어 버튼 리다이렉트)과 조회 명령
// (/tasks·/search·/task·/trace) 렌더링. SupabaseBotServiceStore 와 같은
// SupabaseRestClient 인스턴스를 그대로 주입받아 동작은 바꾸지 않는다 —
// 순수 리팩터링(클래스 분리)이다.
import { safeTelegramTraceUri } from "../../../packages/telegram-ui/src/sanitize.js";
import { buildMiniAppOpenKeyboard, buildProjectStatusMessage } from "../../../packages/telegram-ui/src/index.js";
import {
  type OutboxInsertRow,
  type TaskSummaryRow,
  type TaskDetailRow,
  type TaskTraceEventRow,
  type TaskTraceArtifactRow,
  type TaskTraceVerificationRow,
  type TaskStatusGroupKey,
  TASK_STATUS_GROUP_ORDER,
  TASK_STATUS_GROUPS,
  taskQueryPayload,
  agentPersonaCommandPayload,
  aiActorCommandPayload,
  roomCommandPayload,
  roomMemberCommandPayload,
  formatTraceTime,
  shortTaskId,
  parseContentRangeTotal,
  taskStatusMeta,
  taskAssigneeLabel,
  formatElapsedSince,
  uuidFromProposalId,
  taskIdempotencyKey
} from "./command-prompt-helpers.js";
import { isUuid, isOwnerControlKeyboard, toBigIntString, escapePostgrestInValue, optionalPayloadString } from "./event-row-mapping.js";
import { SupabaseRestClient } from "./rest-client.js";

export class SupabaseChatCommandStore {
  constructor(
    private readonly client: SupabaseRestClient,
    private readonly now: () => Date,
    private readonly miniAppDirectLinkBaseUrl: string | undefined
  ) {}

  // Telegram은 알림·운영센터 열기만 제공한다. 기존 코드 경로와 과거 보고가
  // callback_data 키보드를 만들어도 실제 전송 직전에 URL 버튼으로 바꿔
  // Telegram에서 상태 변경이 일어날 수 없게 한다.
  //
  // 슬래시 명령 쪽도 이미 닫혀 있다 — /approve·/reject·/done·/cancel·/verify 는
  // orchestrator 의 renderOwnerActionRedirect 로 빠져 events: [] 만 돌려준다.
  // 여기서 버튼을 바꾸는 것은 그 단일 창구 원칙의 나머지 절반이다.
  hydrateOwnerControlRows(rows: OutboxInsertRow[], roomId: string): OutboxInsertRow[] {
    return rows.map((row) => {
      if (row.target_kind !== "telegram_bot") return row;
      const payload = row.payload;
      const redirect = payload.ownerActionRedirect === true;
      const hasOwnerCallback = isOwnerControlKeyboard(payload.keyboard);
      if (!redirect && !hasOwnerCallback) return row;
      const threadId = optionalPayloadString(payload.messageThreadId);
      // 링크가 없으면 버튼을 지운 자리에 아무것도 남지 않는다. 그대로 두면 방장은
      // 결정 수단을 잃은 채 "운영센터에서 처리하세요"라는 갈 곳 없는 안내만 받는다.
      // supabase-runtime 의 중간승인 보고와 같은 문구로 원인을 알린다.
      const guidance = this.miniAppDirectLinkBaseUrl
        ? "\n협업 운영센터에서 작업을 확인하고 처리해 주세요."
        : "\n협업 운영센터 링크가 설정되지 않아 승인 UI가 비활성화되었습니다. 운영 담당자에게 BOT_SERVICE_MINIAPP_DIRECT_LINK 설정을 요청하세요.";
      return {
        ...row,
        payload: {
          ...payload,
          keyboard: this.miniAppDirectLinkBaseUrl
            ? buildMiniAppOpenKeyboard({ directLinkBaseUrl: this.miniAppDirectLinkBaseUrl, roomId, messageThreadId: threadId })
            : undefined,
          text: redirect || !this.miniAppDirectLinkBaseUrl
            ? `${String(payload.text ?? "")}${guidance}`
            : payload.text
        }
      };
    });
  }

  // /newagent·/agents 는 오케스트레이터가 표식만 실어 보내고, 실제 DB 기록·조회는
  // 여기서 한다(오케스트레이터는 DB 를 안 읽는 순수 함수라서). 새 봇 계정을 만들지 않고
  // 기존 실행 담당 봇(claude_leader/codex_leader) 위에 이름 붙은 페르소나를 얹는다 —
  // huai_ai_actors 의 role 4종 고정 상태머신은 건드리지 않는다.
  async hydrateAgentPersonaRows(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const command = agentPersonaCommandPayload(row.payload);
      if (!command || row.target_kind !== "telegram_bot") {
        hydrated.push(row);
        continue;
      }

      const text = command.action === "create"
        ? await this.createAgentPersona(roomId, command)
        : await this.renderAgentPersonaList(roomId);
      hydrated.push({ ...row, payload: { ...row.payload, text } });
    }
    return hydrated;
  }

  private async createAgentPersona(
    roomId: string,
    command: { personaName: string; baseRole: string; instructions: string; createdByTelegramUserId?: string }
  ): Promise<string> {
    const response = await this.client.request("POST", "/huai_agent_personas", {
      body: {
        room_id: roomId,
        persona_name: command.personaName,
        base_role: command.baseRole,
        instructions: command.instructions,
        created_by_telegram_user_id: command.createdByTelegramUserId
          ? toBigIntString(command.createdByTelegramUserId, "created_by_telegram_user_id")
          : null
      },
      prefer: "return=minimal"
    });

    if (response.status === 409) {
      return `이미 "${command.personaName}" 페르소나가 있습니다. 다른 이름을 쓰거나 기존 것을 그대로 사용하세요.`;
    }
    await response.expectOk();

    const roleLabel = command.baseRole === "claude_leader" ? "ClaudeBot" : "CodexBot";
    return [
      `페르소나 "${command.personaName}" 등록 완료 (담당: ${roleLabel}).`,
      `이제 리더봇을 부를 때 "!${command.personaName} <지시>" 형식으로 쓰면 이 페르소나로 처리됩니다.`,
      `예: @leader_chatroom_bot !${command.personaName} 최신 소식 조사해줘`
    ].join("\n");
  }

  private async renderAgentPersonaList(roomId: string): Promise<string> {
    const rows = await this.client
      .request(
        "GET",
        "/huai_agent_personas?room_id=eq." + encodeURIComponent(roomId) +
          "&status=eq.active&select=persona_name,base_role,instructions&order=created_at.asc"
      )
      .then((response) => response.json<Array<{ persona_name: string; base_role: string; instructions: string }>>());

    if (rows.length === 0) {
      return "등록된 페르소나가 없습니다.\n/newagent <이름> <claude_leader|codex_leader> <할 일> 로 추가할 수 있습니다.";
    }

    const lines = [`등록된 페르소나 (${rows.length}개)`];
    for (const row of rows) {
      const roleLabel = row.base_role === "claude_leader" ? "ClaudeBot" : "CodexBot";
      lines.push("", `!${row.persona_name} (담당: ${roleLabel})`, row.instructions.slice(0, 200));
    }
    return lines.join("\n");
  }

  async hydrateAiActorRows(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const command = aiActorCommandPayload(row.payload);
      if (!command || row.target_kind !== "telegram_bot") {
        hydrated.push(row);
        continue;
      }
      if (command.action === "check") {
        const inactive = await this.client.request(
          "GET",
          "/huai_ai_actors?room_id=eq." + encodeURIComponent(roomId) + "&status=eq.inactive&select=actor_id,role"
        ).then((response) => response.json<Array<{ actor_id: string; role: string }>>()).catch(() => []);
        for (const actor of inactive) {
          await this.client.request("POST", "/huai_events", {
            body: {
              room_id: roomId,
              task_id: null,
              event_type: "ai_actor_inactive",
              idempotency_key: "ai-actor-inactive:" + actor.actor_id,
              payload: { actorId: actor.actor_id, role: actor.role, action: "propose_exit" }
            },
            prefer: "return=minimal"
          }).then((response) => (response.status === 409 ? undefined : response.expectOk())).catch(() => undefined);
        }
        hydrated.push({ ...row, payload: { ...row.payload, text: inactive.length === 0 ? "현재 장기 미사용 전문 AI가 없습니다." : `${inactive.length}개 전문 AI가 장기 미사용 상태입니다. 퇴장 제안을 기록했습니다.` } });
        continue;
      }
      const response = await this.client.request("POST", "/huai_ai_actors", {
        body: {
          room_id: roomId,
          role: command.role,
          adapter_type: command.adapterType,
          status: "active"
        },
        prefer: "return=minimal"
      });
      const text = response.status === 409
        ? `${command.role} 전문 AI가 이미 이 방에 등록되어 있습니다.`
        : (await response.expectOk(), `${command.role} 전문 AI 초대가 등록되었습니다.`);
      hydrated.push({ ...row, payload: { ...row.payload, text } });
    }
    return hydrated;
  }

  async hydrateRoomCommandRows(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const command = roomCommandPayload(row.payload);
      if (!command || row.target_kind !== "telegram_bot") {
        hydrated.push(row);
        continue;
      }
      const response = await this.client.request("POST", "/huai_rooms?on_conflict=room_id", {
        body: {
          room_id: roomId,
          telegram_chat_id: command.telegramChatId,
          owner_telegram_user_id: command.ownerTelegramUserId,
          purpose: "Telegram 프로젝트 채팅룸",
          rules: "방장 승인 후 실행"
        },
        prefer: "resolution=merge-duplicates,return=minimal"
      });
      await response.expectOk();
      hydrated.push({ ...row, payload: { ...row.payload, text: "프로젝트 채팅룸 등록이 완료되었습니다." } });
    }
    return hydrated;
  }

  async hydrateRoomMemberRows(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const command = roomMemberCommandPayload(row.payload);
      if (!command || row.target_kind !== "telegram_bot") {
        hydrated.push(row);
        continue;
      }
      if (command.action === "add") {
        await this.client.request("POST", "/huai_room_members?room_id=eq." + encodeURIComponent(roomId) + "&telegram_user_id=eq." + encodeURIComponent(command.telegramUserId), {
          body: { room_id: roomId, telegram_user_id: command.telegramUserId, role: "human_member", permissions: ["task:read"], status: "active" },
          prefer: "resolution=merge-duplicates,return=minimal"
        }).then((response) => response.expectOk());
      } else {
        await this.client.request("PATCH", "/huai_room_members?room_id=eq." + encodeURIComponent(roomId) + "&telegram_user_id=eq." + encodeURIComponent(command.telegramUserId), { body: { status: "left" }, prefer: "return=minimal" }).then((response) => response.expectOk());
      }
      await this.client.request("POST", "/huai_events", {
        body: { room_id: roomId, task_id: null, event_type: "participant_changed", idempotency_key: row.idempotency_key + ":participant", payload: { telegramUserId: command.telegramUserId, action: command.action } },
        prefer: "return=minimal"
      }).then((response) => (response.status === 409 ? undefined : response.expectOk()));
      hydrated.push({ ...row, payload: { ...row.payload, text: command.action === "add" ? "참여자를 초대했습니다." : "참여자를 퇴장 처리했습니다." } });
    }
    return hydrated;
  }

  async hydrateTaskQueryOutboxRows(rows: OutboxInsertRow[], roomId: string): Promise<OutboxInsertRow[]> {
    const hydrated: OutboxInsertRow[] = [];
    for (const row of rows) {
      const query = taskQueryPayload(row.payload);
      if (!query || row.target_kind !== "telegram_bot") {
        hydrated.push(row);
        continue;
      }

      const text = query.kind === "center"
        ? String(row.payload.text ?? "협업 운영센터 링크입니다.")
        : query.kind === "tasks"
        ? await this.renderTaskListQuery(query.limit, roomId)
        : query.kind === "search"
          ? await this.renderTaskSearchQuery(query.term, roomId)
          : query.kind === "trace"
            ? await this.renderTaskTraceQuery(query.taskId, roomId)
            : await this.renderTaskDetailQuery(query.taskId, roomId);
      // "협업 운영센터 열기" 버튼은 /tasks 에만 붙인다(/search·/task·/trace 는 이번 범위가 아니다).
      // BOT_SERVICE_MINIAPP_DIRECT_LINK 미설정 시 keyboard 필드 자체를 안 만든다 —
      // 기존 payload 에 keyboard 가 없던 것과 완전히 동일하게 유지한다.
      const keyboard = (query.kind === "tasks" || query.kind === "center") && this.miniAppDirectLinkBaseUrl
        ? buildMiniAppOpenKeyboard({
          directLinkBaseUrl: this.miniAppDirectLinkBaseUrl,
          roomId,
          messageThreadId: optionalPayloadString(row.payload.messageThreadId)
        })
        : undefined;
      hydrated.push({ ...row, payload: { ...row.payload, text, ...(keyboard ? { keyboard } : {}) } });
    }
    return hydrated;
  }

  // Phase 3: /tasks 를 평문 나열에서 상태별 그룹 + 경과시간 + 담당자 표시로 바꾼다.
  // 상태 분류표는 TASK_STATUS_META(전수 커버리지, huai_tasks_status_check 기준) 참고.
  private async renderTaskListQuery(limit: number, roomId: string): Promise<string> {
    const safeLimit = Math.max(1, Math.min(limit, 30));
    // in_progress 작업은 장기 체류로 updated_at 이 밀려 단일 updated_at.desc 쿼리에서
    // 창 밖으로 탈락하는 결함이 있었다. 별도 조회로 항상 포함시킨다.
    const IN_PROGRESS_CAP = 30;
    const taskSelect = "task_id,title,status,priority,assignee_actor_id,updated_at,created_at";
    const inProgressResponse = await this.client.request(
      "GET",
      "/huai_tasks?room_id=eq." + encodeURIComponent(roomId) + "&status=eq.in_progress&select=" + taskSelect + "&order=updated_at.desc&limit=" + IN_PROGRESS_CAP,
      { prefer: "count=exact" }
    );
    const inProgressRows = await inProgressResponse.json<TaskSummaryRow[]>();
    const inProgressTotal = parseContentRangeTotal(inProgressResponse.header("content-range")) ?? inProgressRows.length;

    const otherLimit = Math.max(1, safeLimit - inProgressRows.length);
    const otherResponse = await this.client.request(
      "GET",
      "/huai_tasks?room_id=eq." + encodeURIComponent(roomId) + "&status=neq.in_progress&select=" + taskSelect + "&order=updated_at.desc&limit=" + otherLimit,
      { prefer: "count=exact" }
    );
    const otherRows = await otherResponse.json<TaskSummaryRow[]>();
    const otherTotal = parseContentRangeTotal(otherResponse.header("content-range")) ?? otherRows.length;

    const rows = [...inProgressRows, ...otherRows];
    const totalCount = inProgressTotal + otherTotal;

    if (rows.length === 0) return "작업 목록\n현재 등록된 작업이 없습니다.";


    const assigneeActorIds = Array.from(new Set(rows.map((task) => task.assignee_actor_id).filter((value): value is string => Boolean(value))));
    const roleByActorId = await this.fetchActorRolesByActorIds(assigneeActorIds);
    const now = this.now();

    const grouped = new Map<TaskStatusGroupKey, TaskSummaryRow[]>();
    for (const task of rows) {
      const meta = taskStatusMeta(task.status);
      const bucket = grouped.get(meta.group) ?? [];
      bucket.push(task);
      grouped.set(meta.group, bucket);
    }

    const headerLine = totalCount > rows.length
      ? `작업 목록 (최근 ${rows.length}건 표시 · 전체 ${totalCount}건 중 ${totalCount - rows.length}건 더 있음)`
      : `작업 목록 (총 ${rows.length}건)`;
    const lines: string[] = [
      buildProjectStatusMessage({
        title: "HuAI 프로젝트",
        activeTasks: inProgressTotal,
        pendingApprovals: rows.filter((task) => task.status.includes("pending")).length,
        gatewayOnline: true
      }),
      "",
      headerLine
    ];
    let index = 0;
    for (const groupKey of TASK_STATUS_GROUP_ORDER) {
      const tasks = grouped.get(groupKey);
      if (!tasks || tasks.length === 0) continue; // 빈 그룹은 화면을 잡아먹으니 아예 출력하지 않는다.
      const groupInfo = TASK_STATUS_GROUPS[groupKey];
      lines.push("", `${groupInfo.icon} ${groupInfo.label} (${tasks.length})`);
      for (const task of tasks) {
        index += 1;
        // updated_at 은 상태가 바뀔 때마다 patchTaskStatus 가 갱신하고, 아직 한 번도
        // 안 바뀐 task 는 insert 시점 created_at 과 사실상 같은 값이 default now() 로 들어간다.
        // 그래서 상태별로 기준 필드를 분기할 필요 없이 updated_at 하나가
        // "이 상태로 바뀐 시점"과 "생성된 시점"을 동시에 커버한다.
        const elapsed = formatElapsedSince(task.updated_at ?? task.created_at, now);
        const assignee = taskAssigneeLabel(roleByActorId.get(task.assignee_actor_id ?? ""));
        // 그룹 헤더는 스캔용이고, 같은 그룹 안에도 서로 다른 세부 상태가 섞인다
        // (예: "⏳ 대기 중"에는 제안 검토 대기/실행 대기/검증 대기 등 6가지가 섞인다).
        // 그룹만 보여주면 어떤 대기인지 알 수 없어 정보 손실이라, 세부 라벨을 항상 같이 보여준다.
        const detailParts = [`상태: ${taskStatusMeta(task.status).label}`, `담당: ${assignee}`];
        if (elapsed) detailParts.push(elapsed);
        if (task.priority && task.priority !== "normal") detailParts.push(`우선순위: ${task.priority}`);
        lines.push(`${index}. ${shortTaskId(task.task_id)} · ${task.title || "제목 없음"}`);
        lines.push(`   ${detailParts.join(" · ")}`);
      }
    }
    return lines.join("\n");
  }

  // actor_id 는 UUID PK 라 room 필터가 필요 없다 (fetchTaskByProposalId 와 같은 근거).
  private async fetchActorRolesByActorIds(actorIds: readonly string[]): Promise<Map<string, string>> {
    if (actorIds.length === 0) return new Map();
    const quoted = actorIds.map((id) => '"' + escapePostgrestInValue(id) + '"').join(",");
    const rows = await this.client
      .request("GET", "/huai_ai_actors?actor_id=in.(" + encodeURIComponent(quoted) + ")&select=actor_id,role")
      .then((response) => response.json<Array<{ actor_id: string; role: string }>>());
    return new Map(rows.map((row) => [row.actor_id, row.role]));
  }

  private async renderTaskSearchQuery(term: string, roomId: string): Promise<string> {
    const normalized = term.trim();
    if (!normalized) return "작업 검색\n검색어를 함께 보내주세요. 예: /search 버튼";
    const encodedTerm = encodeURIComponent("*" + normalized.replace(/[*,()]/g, " ").trim() + "*");
    const rows = await this.client
      .request("GET", "/huai_tasks?room_id=eq." + encodeURIComponent(roomId) + "&or=(title.ilike." + encodedTerm + ",purpose.ilike." + encodedTerm + ",scope.ilike." + encodedTerm + ")&select=task_id,title,status,priority,assignee_actor_id,updated_at,created_at&order=updated_at.desc&limit=10")
      .then((response) => response.json<TaskSummaryRow[]>());
    if (rows.length === 0) return "작업 검색\n검색 결과가 없습니다: " + normalized;
    return [
      "작업 검색: " + normalized,
      ...rows.map((task, index) => `${index + 1}. ${shortTaskId(task.task_id)} · ${task.title || "제목 없음"}\n상태: ${taskStatusMeta(task.status).label}`)
    ].join("\n");
  }

  private async renderTaskTraceQuery(taskId: string, roomId: string): Promise<string> {
    const normalizedTaskId = taskId.trim();
    if (!isUuid(normalizedTaskId)) return "작업 이력\n작업 UUID를 함께 보내주세요. 예: /trace <task_id>";

    const encodedTaskId = encodeURIComponent(normalizedTaskId);
    // huai_artifacts·huai_verifications 에는 room_id 컬럼이 없어 직접 필터링할 수 없다.
    // 대신 이 task 가 이 방 소유인지 먼저 확인하고, 아니면 실재하지 않는 task 와
    // 똑같이 빈 이력으로 응답한다 — 존재 여부조차 다른 방에 알려주지 않는다.
    const owned = await this.taskBelongsToRoom(normalizedTaskId, roomId);
    const [events, artifacts, verifications] = owned
      ? await Promise.all([
          this.client
            .request("GET", "/huai_events?task_id=eq." + encodedTaskId + "&room_id=eq." + encodeURIComponent(roomId) + "&select=event_type,created_at&order=created_at.desc&limit=10")
            .then((response) => response.json<TaskTraceEventRow[]>()),
          this.client
            .request("GET", "/huai_artifacts?task_id=eq." + encodedTaskId + "&select=uri,version,is_final,created_at&order=created_at.desc&limit=10")
            .then((response) => response.json<TaskTraceArtifactRow[]>()),
          this.client
            .request("GET", "/huai_verifications?task_id=eq." + encodedTaskId + "&select=verdict,target_version,created_at&order=created_at.desc&limit=10")
            .then((response) => response.json<TaskTraceVerificationRow[]>())
        ])
      : [[], [], []] as [TaskTraceEventRow[], TaskTraceArtifactRow[], TaskTraceVerificationRow[]];

    return [
      "작업 이력: " + shortTaskId(normalizedTaskId),
      "이벤트:",
      ...(events.length === 0 ? ["- 없음"] : events.map((event) => "- " + event.event_type + formatTraceTime(event.created_at))),
      "산출물:",
      ...(artifacts.length === 0 ? ["- 없음"] : artifacts.map((artifact) => "- " + artifact.version + (artifact.is_final ? " · final" : "") + " · " + safeTelegramTraceUri(artifact.uri) + formatTraceTime(artifact.created_at))),
      "검증:",
      ...(verifications.length === 0 ? ["- 없음"] : verifications.map((verification) => "- " + verification.verdict + " · " + verification.target_version + formatTraceTime(verification.created_at)))
    ].join("\n");
  }

  private async renderTaskDetailQuery(taskId: string, roomId: string): Promise<string> {
    const normalizedTaskId = taskId.trim();
    if (!normalizedTaskId) return "작업 상세\n작업 ID를 함께 보내주세요. 예: /task task_id";

    const task = normalizedTaskId.startsWith("proposal_")
      ? await this.fetchTaskDetailByProposalId(normalizedTaskId, roomId)
      : await this.fetchTaskDetailByTaskId(normalizedTaskId, roomId);
    if (!task) return `작업 상세\n해당 작업을 찾지 못했습니다: ${normalizedTaskId}`;

    return [
      "작업 상세",
      `ID: ${shortTaskId(task.task_id)}`,
      `작업: ${task.title || "제목 없음"}`,
      `상태: ${taskStatusMeta(task.status).label}`,
      task.priority ? `우선순위: ${task.priority}` : undefined,
      task.purpose ? `목적: ${task.purpose}` : undefined,
      task.scope ? `범위: ${task.scope}` : undefined,
      task.completion_criteria ? `완료 기준: ${task.completion_criteria}` : undefined,
      task.updated_at ? `최근 갱신: ${task.updated_at}` : undefined
    ].filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
  }

  private async fetchTaskDetailByTaskId(taskId: string, roomId: string): Promise<TaskDetailRow | undefined> {
    if (!isUuid(taskId)) return undefined;
    // room_id 를 SELECT 필터에 직접 넣으면, 다른 방 task 는 "존재하지 않음"과
    // 똑같이 빈 결과로 돌아온다 — 별도 분기 없이 유출을 막는다.
    const rows = await this.client
      .request("GET", "/huai_tasks?task_id=eq." + encodeURIComponent(taskId) + "&room_id=eq." + encodeURIComponent(roomId) + "&select=task_id,title,status,priority,purpose,scope,completion_criteria,updated_at,created_at&limit=1")
      .then((response) => response.json<TaskDetailRow[]>());
    return rows[0];
  }

  private async fetchTaskDetailByProposalId(proposalId: string, roomId: string): Promise<TaskDetailRow | undefined> {
    const proposalUuid = uuidFromProposalId(proposalId);
    const query = proposalUuid
      ? "proposal_id=eq." + encodeURIComponent(proposalUuid)
      : "idempotency_key=eq." + encodeURIComponent(taskIdempotencyKey(proposalId));
    const rows = await this.client
      .request("GET", "/huai_tasks?" + query + "&room_id=eq." + encodeURIComponent(roomId) + "&select=task_id,title,status,priority,purpose,scope,completion_criteria,updated_at,created_at&limit=1")
      .then((response) => response.json<TaskDetailRow[]>());
    return rows[0];
  }

  // /trace 가드용. huai_artifacts·huai_verifications 에 room_id 가 없으므로
  // 산출물·검증 이력을 조회하기 전에 이 task 가 이 방 소유인지부터 확인한다.
  private async taskBelongsToRoom(taskId: string, roomId: string): Promise<boolean> {
    const rows = await this.client
      .request("GET", "/huai_tasks?task_id=eq." + encodeURIComponent(taskId) + "&room_id=eq." + encodeURIComponent(roomId) + "&select=task_id&limit=1")
      .then((response) => response.json<Array<{ task_id: string }>>());
    return rows.length > 0;
  }
}
