// 순수 핸들러 — Deno.* 를 참조하지 않는다. index.ts 가 실제 Supabase 호출을 주입한다.
// miniapp-proposals/handler.ts 와 같은 이유로 분리했다: Deno.serve 가 모듈 로드 시점에 실행되는
// 파일을 Node 로 import 하면 "Deno is not defined" 로 즉시 죽어서 node --test 로 회귀 테스트를
// 돌릴 수 없다. 이 파일은 그 문제가 없다.
//
// buildDepsFromClient 를 여기 둔 이유(room-isolation.test.ts 가 실제로 검증하는 지점):
// 기존 handler 단위 테스트 패턴(miniapp-proposals/handler.test.ts 참고)은 deps.fetchTasksForRoom
// 을 통짜 가짜 함수로 갈아끼워서 "handler 가 요청받은 roomId 를 그 함수에 정확히 넘기는가"만
// 증명한다 — 그 가짜 함수가 roomId 인자를 무시하고 항상 전체 행을 돌려줘도 그 테스트는 통과한다.
// 진짜 위험은 이 함수 밖(원래 index.ts 안)에서 조립되던 `.from("huai_tasks").eq("room_id",
// roomId)` 쿼리가 실제로 필터링을 거는가이다. 그 쿼리 조립 로직을 buildDepsFromClient 로 뽑아
// 여기(Deno 미참조 파일)에 두면, 진짜 Supabase 클라이언트 대신 ../_shared/fake-supabase-client.ts
// 의 FakeSupabaseClient(실제로 필터링하는 인메모리 대역)를 넣어 "room-A 쿼리가 room-B 행을
// 절대 안 돌려주는가"까지 node --test 로 실행 검증할 수 있다.
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import type { MembershipCheckResult, MiniAppAuthResult } from "../_shared/types.ts";
import { taskStatusMeta } from "../_shared/task-status.ts";
import type { MinimalSupabaseClient } from "../_shared/fake-supabase-client.ts";

// huai_tasks 조회 select 절이 돌려주는 행 모양. 컬럼 목록은 원래 index.ts(리팩터 전)의
// .select(...) 문자열을 그대로 옮긴 것 — 응답 JSON 계약(taskId/status/...)을 바꾸지 않기
// 위해 필드 이름·의미를 추측하지 않고 그대로 유지했다.
export type TaskRow = {
  task_id: string;
  status: string;
  priority: string | number | null;
  title: string;
  purpose: string | null;
  scope: string | null;
  completion_criteria: string | null;
  created_at: string;
  updated_at: string;
  assignee_actor_id: string | null;
  assignee: { role: string; adapter_type: string } | null;
};

export type TasksHandlerDeps = {
  authenticate(req: Request): Promise<MiniAppAuthResult>;
  checkRoomAccess(roomId: string, telegramUserId: string): Promise<MembershipCheckResult>;
  // room_id 로 이미 스코프된 조회를 기대한다 — 이 함수는 그 필터가 실제로 걸렸는지까지는
  // 보장하지 못한다(miniapp-proposals/handler.ts 의 동일 주석 참고). 그 증명은
  // room-isolation.test.ts 가 buildDepsFromClient + FakeSupabaseClient 로 별도 수행한다.
  // messageThreadId 를 주면 그 포럼 주제에서 시작된 작업만 돌려준다. 없으면 방 전체다 —
  // 주제 없이 열린 현황판(일반 그룹, 포럼의 General)은 지금까지처럼 방을 통으로 본다.
  fetchTasksForRoom(roomId: string, messageThreadId?: string): Promise<{ error?: string; data?: TaskRow[] }>;
  // 작업이 실제로 무엇을 만들어냈는지. 이게 없으면 현황판은 "완료"라고만 말하고,
  // 방장은 결과물을 보려고 방 대화를 거슬러 올라가야 한다.
  fetchArtifactsForTasks(taskIds: readonly string[]): Promise<{ error?: string; data?: ArtifactRow[] }>;
};

export type ArtifactRow = {
  artifact_id: string;
  task_id: string;
  uri: string;
  // 게이트웨이가 웹 산출물을 올렸으면 여기에 공개 주소가 있다.
  public_url?: string | null;
  created_at: string;
};

// 방장에게 보여줄 이름. 로컬 경로를 그대로 보여주면 폰에서는 아무 뜻도 없다.
export function artifactDisplayName(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri;
  // 게이트웨이가 Windows 경로를 그대로 실어 보낸다 — 역슬래시도 구분자로 본다.
  const last = withoutQuery.split(/[\\/]/).filter(Boolean).pop() ?? withoutQuery;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// 눌러서 열 수 있는 주소인가. file:// 은 이 PC 안에서만 뜻이 있어 폰에서는 못 연다.
export function artifactOpenUrl(artifact: { uri: string; public_url?: string | null }): string | null {
  if (artifact.public_url && /^https?:\/\//i.test(artifact.public_url)) return artifact.public_url;
  return /^https?:\/\//i.test(artifact.uri) ? artifact.uri : null;
}

export async function handleMiniappTasksRequest(req: Request, deps: TasksHandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "GET") return jsonResponse(405, { error: "method-not-allowed" });

  const auth = await deps.authenticate(req);
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.message });

  const url = new URL(req.url);
  const rawRoomId = url.searchParams.get("roomId");
  if (!rawRoomId) return jsonResponse(400, { error: "missing-room-id" });

  // 현황판 링크는 "<roomId>__t<주제번호>" 로 온다. 페이지가 그걸 갈라 threadId 로 넘겨주지만,
  // 아직 옛 페이지를 보고 있는 사용자는 통째로 roomId 에 실어 보낸다. 그 경우 방 조회가
  // 실패해 현황판이 빈 화면이 된다 — 페이지 배포가 늦어도 여기서 받아준다.
  const separatorIndex = rawRoomId.indexOf("__t");
  const roomId = separatorIndex < 0 ? rawRoomId : rawRoomId.slice(0, separatorIndex);
  const threadFromRoomParam = separatorIndex < 0 ? undefined : rawRoomId.slice(separatorIndex + 3) || undefined;

  const access = await deps.checkRoomAccess(roomId, auth.telegramUserId);
  if (!access.ok) return jsonResponse(access.status, { error: access.message });

  const tasksResult = await deps.fetchTasksForRoom(roomId, url.searchParams.get("threadId") ?? threadFromRoomParam);
  if (tasksResult.error) {
    console.error(`miniapp-tasks: tasks query failed: ${tasksResult.error}`);
    return jsonResponse(500, { error: "lookup-failed" });
  }

  const taskIds = (tasksResult.data ?? []).map((task) => task.task_id);
  const artifactsResult = taskIds.length > 0 ? await deps.fetchArtifactsForTasks(taskIds) : { data: [] };
  if (artifactsResult.error) {
    // 산출물 조회가 실패해도 작업 목록은 보여준다. 목록까지 못 보는 것이 더 나쁘다.
    console.error(`miniapp-tasks: artifacts query failed: ${artifactsResult.error}`);
  }
  const artifactsByTask = new Map<string, ArtifactRow[]>();
  for (const artifact of artifactsResult.data ?? []) {
    const bucket = artifactsByTask.get(artifact.task_id);
    if (bucket) bucket.push(artifact);
    else artifactsByTask.set(artifact.task_id, [artifact]);
  }

  const board = (tasksResult.data ?? []).map((task) => {
    const meta = taskStatusMeta(task.status);
    return {
      taskId: task.task_id,
      status: task.status,
      statusLabel: meta.label,
      bucket: meta.bucket,
      decidable: meta.decidable,
      // decidable=false 인데 방장이 뭔가 할 게 있어 보이는 상태(mid_approval_pending 등)에
      // "왜 버튼이 없는지"를 설명한다. 없으면 null — 정적 페이지는 버튼 없이 조용히 넘어간다.
      hint: meta.hint ?? null,
      priority: task.priority,
      title: task.title,
      purpose: task.purpose,
      scope: task.scope,
      completionCriteria: task.completion_criteria,
      assignee: task.assignee ?? null,
      artifacts: (artifactsByTask.get(task.task_id) ?? []).map((artifact) => ({
        artifactId: artifact.artifact_id,
        name: artifactDisplayName(artifact.uri),
        // 열 수 없는 산출물도 이름은 보여준다 — 무엇이 만들어졌는지는 알아야 한다.
        url: artifactOpenUrl(artifact),
        createdAt: artifact.created_at
      })),
      createdAt: task.created_at,
      updatedAt: task.updated_at
    };
  });

  return jsonResponse(200, {
    room: access.room,
    viewerRole: access.viewerRole,
    tasks: board,
    generatedAt: new Date().toISOString()
  });
}

// authenticate/checkRoomAccess 를 뺀 나머지 — 실제 Supabase 쿼리 조립 부분만 담은 타입.
// index.ts 의 buildDeps() 는 이 결과에 authenticate/checkRoomAccess 를 얹어 TasksHandlerDeps
// 전체를 완성한다(그쪽은 _shared/miniapp-auth.ts, _shared/membership.ts 를 그대로 쓴다 — 둘 다
// Deno.* 를 참조하므로 이 파일에서는 안 건드린다).
export type TasksQueryDeps = Pick<TasksHandlerDeps, "fetchTasksForRoom" | "fetchArtifactsForTasks">;

export function buildDepsFromClient(supabase: MinimalSupabaseClient): TasksQueryDeps {
  return {
    async fetchArtifactsForTasks(taskIds: readonly string[]) {
      const { data, error } = await supabase
        .from("huai_artifacts")
        .select("artifact_id, task_id, uri, public_url, created_at")
        .in("task_id", [...taskIds])
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) return { error: error.message };
      return { data: (data ?? []) as ArtifactRow[] };
    },
    async fetchTasksForRoom(roomId: string, messageThreadId?: string) {
      const scoped = supabase
        .from("huai_tasks")
        .select(
          "task_id, status, priority, title, purpose, scope, completion_criteria, created_at, updated_at, assignee_actor_id, assignee:huai_ai_actors(role, adapter_type)"
        )
        .eq("room_id", roomId);
      // 주제가 지정된 현황판은 그 주제 작업만 본다. 방 조건은 그대로 둔다 — 주제 번호는
      // 방마다 다시 매겨지므로 주제만으로 거르면 다른 방 작업이 섞인다.
      const query = messageThreadId ? scoped.eq("telegram_message_thread_id", messageThreadId) : scoped;
      const { data, error } = await query
        .order("updated_at", { ascending: false })
        .limit(200);
      if (error) return { error: error.message };
      return { data: (data ?? []) as TaskRow[] };
    }
  };
}
