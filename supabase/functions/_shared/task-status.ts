// huai_tasks.status 값 23개를 작업 현황판 칸반 칼럼으로 묶는다.
// 값 목록은 supabase/schema.sql 의 huai_tasks_status_check 제약을 그대로 옮긴 것이다 —
// 추측하지 않고 그 파일을 직접 읽어 확인했다. 새 상태가 추가되면 이 파일도 같이 갱신해야 한다.
//
// 칼럼 구성(4개)은 이번 작업의 판단 사항이다:
//   backlog        — 아직 실행 전 단계
//   in_progress    — AI 가 진행·검증 중 (사람 개입 불필요)
//   needs_decision — 방장(owner)의 승인/거부/보완이 필요 (Mini App 승인 버튼의 대상)
//   done           — 완료
//   stopped        — 중단·취소·거부되어 더 진행되지 않는 상태
export type TaskBoardBucket = "backlog" | "in_progress" | "needs_decision" | "done" | "stopped";

export type TaskStatus =
  | "proposal_pending"
  | "proposal_revision_requested"
  | "proposal_rejected"
  | "scheduled"
  | "waiting_dependencies"
  | "queued_for_gateway"
  | "in_progress"
  | "mid_approval_pending"
  | "paused_by_owner"
  | "verification_pending"
  | "verification_in_progress"
  | "revision_requested"
  | "revision_in_progress"
  | "reverification_pending"
  | "commander_completion_pending"
  | "completion_approval_pending"
  | "owner_supplement_requested"
  | "completed"
  | "cancel_requested"
  | "cancelled"
  | "failed_retryable"
  | "blocked"
  | "rejected_or_cancelled";

export type TaskStatusMeta = {
  bucket: TaskBoardBucket;
  label: string;
  // true 면 이 상태의 작업에 대해 방장이 miniapp-approve 로 결정을 내릴 수 있다.
  decidable: boolean;
  // decidable=false 인데 needs_decision 버킷에 있는(=방장이 뭔가 해야 할 것처럼 보이는) 상태에
  // 붙이는 안내문. 결정 버튼 대신 이 문구를 보여줘서 "버튼이 없다"가 아니라 "왜 없는지"를
  // 알게 한다 — 버튼이 조용히 없는 것과 문구로 설명하는 것의 차이가 "거짓 안심" 여부를 가른다.
  hint?: string;
};

export const TASK_STATUS_META: Record<TaskStatus, TaskStatusMeta> = {
  proposal_pending: { bucket: "backlog", label: "제안 대기", decidable: false },
  proposal_revision_requested: { bucket: "backlog", label: "제안 보완 요청됨", decidable: false },
  scheduled: { bucket: "backlog", label: "예약됨", decidable: false },
  waiting_dependencies: { bucket: "backlog", label: "선행 작업 대기", decidable: false },
  queued_for_gateway: { bucket: "backlog", label: "실행 대기열", decidable: false },

  in_progress: { bucket: "in_progress", label: "진행 중", decidable: false },
  revision_in_progress: { bucket: "in_progress", label: "수정 진행 중", decidable: false },
  verification_pending: { bucket: "in_progress", label: "검증 대기", decidable: false },
  verification_in_progress: { bucket: "in_progress", label: "검증 진행 중", decidable: false },
  reverification_pending: { bucket: "in_progress", label: "재검증 대기", decidable: false },

  // mid_approval_pending: Telegram 에도 이 상태를 벗어나는 버튼이 없다(packages/telegram-ui/src/
  // index.ts:38-48 buildTaskDecisionKeyboard 는 approve/reject/cancel 뿐이고 mid 게이트가
  // 아니다). Mini App 이 여기서 결정 버튼을 새로 만들면 Telegram 에 없는 정책을 발명하는
  // 것이라 decidable=false 로 두고, 방장이 오해하지 않게 hint 로 명시한다.
  mid_approval_pending: {
    bucket: "needs_decision",
    label: "중간 승인 필요",
    decidable: false,
    hint: "이 단계의 결정은 협업 운영센터에서 처리합니다. 협업 운영센터를 열어 확인해 주세요."
  },
  // completion_approval_pending 과 stage='final_approval' 로 통합됐다(팀장님 확정 — 같은
  // 결정, 상태 이름만 다르다). 방장에게도 같은 종류의 결정임을 알 수 있게 라벨을 맞췄다.
  commander_completion_pending: { bucket: "needs_decision", label: "완료 승인 필요", decidable: true },
  completion_approval_pending: { bucket: "needs_decision", label: "완료 승인 필요", decidable: true },
  owner_supplement_requested: { bucket: "needs_decision", label: "정보 보완 필요 (채팅으로 답변)", decidable: false },

  completed: { bucket: "done", label: "완료", decidable: false },

  proposal_rejected: { bucket: "stopped", label: "제안 거부됨", decidable: false },
  paused_by_owner: { bucket: "stopped", label: "일시중지됨", decidable: false },
  revision_requested: { bucket: "stopped", label: "수정 요청됨", decidable: false },
  cancel_requested: { bucket: "stopped", label: "취소 요청됨", decidable: false },
  cancelled: { bucket: "stopped", label: "취소됨", decidable: false },
  failed_retryable: { bucket: "stopped", label: "실패(재시도 가능)", decidable: false },
  blocked: { bucket: "stopped", label: "막힘", decidable: false },
  rejected_or_cancelled: { bucket: "stopped", label: "거부/취소됨", decidable: false }
};

export function taskStatusMeta(status: string): TaskStatusMeta {
  return (TASK_STATUS_META as Record<string, TaskStatusMeta>)[status] ?? {
    bucket: "backlog",
    label: status,
    decidable: false
  };
}

export const BOARD_BUCKET_ORDER: { id: TaskBoardBucket; label: string }[] = [
  { id: "needs_decision", label: "승인 필요" },
  { id: "in_progress", label: "진행 중" },
  { id: "backlog", label: "대기" },
  { id: "stopped", label: "중단" },
  { id: "done", label: "완료" }
];
