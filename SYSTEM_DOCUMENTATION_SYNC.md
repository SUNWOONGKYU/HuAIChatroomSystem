# HuAI 시스템 문서 동기화 규칙

시스템 동작이나 Telegram 사용자 경험이 바뀌면 코드 수정과 함께 아래 문서를 같이 갱신한다.

## 동기화 대상

- `2026_08_11__HuAI_Collab_Chatroom_System_페이스북_소개글.md`
- `2026_08_11__CODEX_방식A_다중그룹_온보딩_지시문.md`
- `2026_08_23__HuAI_System_관계도.svg` (+ `.png`) — 2026-08-23 기준. 3엔진 인계·포럼 주제 분리·
  결과물 배포/파일 전달·전문 보기·방 기억·야간 보관·수신 polling 전환·배포 전 승인 게이트(프리뷰→
  프로덕션 승격)·승인 카테고리 분리를 모두 담았다
- `2026_08_23__HuAI_System_작업흐름도.svg` (+ `.png`) — 위와 같음
  (이전판 2026-08-17 두 장은 `_archive/도해/` 로 옮겼다. 그림을 고치면
   `node ~/.claude/skills/svg-도해-감사/audit.mjs <파일>` 로 95점 이상을 확인하고 PNG 를 다시 뽑는다.)
- `docs/시스템_관계도.md` (관계도 본문 — SVG 보다 이쪽이 최신이면 SVG 를 맞춘다)
- `docs/작업_흐름도.md` (흐름도 본문 — 위와 같다)
- `OPERATION_STATUS.md` (라이브에서 무엇이 확인됐는지)
- `README.md`
- `GITHUB_QUICKSTART.md`
- `GITHUB_RELEASE_CHECKLIST.md`
- `HuAI_설치_및_사용_설명서.md` — 비개발자용 통합 설치+사용 가이드. GITHUB_QUICKSTART.md 와
  같은 절차를 다루지만 클릭 단위로 더 잘게 쪼갠 별도 문서다(하나를 고치면 다른 하나도 봐야 한다).

## 문서 동기화 체크

- Telegram 버튼 문구나 의미가 바뀌었는가?
- LeaderBot, CodexBot, ClaudeBot, AuditBot 역할이 바뀌었는가?
- 승인, 실행, 검증, 완료 흐름이 바뀌었는가?
- 자동 검증 조건이 바뀌었는가?
- Supabase, local-gateway, webhook 연결 방식이 바뀌었는가?
- 운영 기본값, 실행 제한, 재시작 절차가 바뀌었는가?
- 실행 엔진 구성이나 인계 규칙이 바뀌었는가?
- 결과물 전달 방식(웹 배포 / 파일 업로드)이 바뀌었는가?
- 방에 보이는 길이 기준이나 전문 보기 경로가 바뀌었는가?
- 방 기억·보관·정리 주기가 바뀌었는가?
- 헬스체크(`/healthz`·`/readyz`) 판정 기준이 바뀌었는가?
- 방 백업·복구 자동화 동작(주기, 보관 상한, 수동 실행 명령)이 바뀌었는가?
- 서비스 기동·재시작·자동 기동(autostart) 절차가 바뀌었는가?
- CI(`.github/workflows/verify.yml`)나 `verify:all`/`npm run lint`에 새 게이트가 편입됐는가?

해당 항목 중 하나라도 맞으면 설명문, 관계도, 흐름도, GitHub 빠른 구축 문서를 함께 수정한다.

## 현재 사용자 표시 기준

- 작업 제안 버튼: `실행`, `수정`, `반려`
- 완료 승인 버튼: 방 안이 아니라 협업 운영센터(Mini App)에만 있다 — `승인`(final_approve), `보완 요청`
  (request_revision) 둘. 옛 방 안 3버튼(`검증`/`보완`/`완료`)은
  2026-08-23부로 어떤 운영 경로에서도 호출되지 않는다.
- 실행 결과는 사람이 알아야 할 짧은 내용만 Telegram에 표시한다.
- 내부 JSON, 훅 로그, 토큰 사용량, 파일 경로 나열은 기본적으로 숨긴다.
- AuditBot 자동 검증은 의미 있는 결과물에만 붙인다.
- AI 협의 요청은 LeaderBot이 ClaudeBot, CodexBot, AuditBot 역할 실행으로 분리한다. 이를 다중 AI 협의로 표기한다.
- 사람이 원하면 `@audit_chatroom_bot`으로 직접 감사를 요청한다.
- `/trace <task_id>`는 이벤트·산출물 URI·검증 이력을 Telegram으로 직접 출력한다.
- 실행 엔진은 Claude Code·Codex·Gemini 웹 셋이고, 기존 Antigravity/agy 값은 Gemini 웹으로 호환한다. Gemini 웹은 전용 Chrome CDP 세션의 응답 전용 경로이며 로컬 파일을 수정하지 않는다. 실제 한도·로그인·CDP·타임아웃 오류는 명시적으로 기록한다.
  한도 판정은 각 CLI 자체 통보(프로토콜 이벤트 포함)일 때만 인정한다.
- 실행 결과·감사 보고가 300자를 넘으면 앞부분만 방에 보내고 `전문 보기` 버튼을 붙인다.
- 웹 산출물은 실행 직후 Vercel 프리뷰로만 올리고, 완료 승인이 실제로 기록된 뒤에만 프로덕션
  주소로 승격한다. 문서 산출물은 방에 파일로 올린다.
- 파일을 안 바꾸는 조회·분석·설명 작업은 시작 승인 버튼 없이 자동 시작된다(승인 카테고리 분리).
  자동승인도 방장 승인과 같은 권한 검사를 통과해야 실행된다.
- Telegram 수신은 기본이 polling(`BOT_SERVICE_RECEIVE_MODE=polling`)이라 공개 URL이 필요 없다.
  공인 도메인이 있는 배포는 webhook 으로 전환할 수 있다.
- 포럼 주제를 쓰는 방은 주제마다 작업·협업 운영센터가 따로 흐른다.
- 협업 운영센터 진입은 Telegram 메뉴 `/center` 또는 작업 메시지 링크다. 예전 고정 메시지는 만들지 않는다.
- `/center`는 현재 방의 roomId와 포럼 주제의 threadId를 함께 전달한다.
- `/trace` 출력에는 raw event payload와 URI secret query 값을 포함하지 않는다.
- 질문형 멘션은 작업 제안 버튼 없이 즉답하고, 실제 변경 지시만 작업 제안으로 만든다.
- 기본 AI 실행 제한은 15분이다.
- 퀴즈는 `classifyTaskRisk`가 고위험으로 분류한 배포·삭제·권한/인증·환경변수·시크릿·중요 설정·DB 스키마 변경에만 3문항을 요구한다. 조회·분석·설명·검토와 단순 저위험 파일 변경은 퀴즈 행을 만들지 않는다.
- synthetic 계획 테스트는 `apps/bot-service/test/synthetic-leader-planning-webhook.test.ts`에서 가상 room과 5001/9001 사용자, 가짜 fetch로만 실행하며 실제 Telegram/Supabase에는 쓰지 않는다.
- bot-service `/healthz`는 설정값(봇 개수·허용 chat 개수)만 보는 liveness이고, `/readyz`는 Supabase 왕복과 Telegram 수신 경로(polling 최신성 또는 webhook 등록)를 실제로 확인하는 readiness다. 실패하면 503과 `checks.supabase`/`checks.receive` JSON을 준다. 기동 직후 첫 polling 바퀴 전에는 `no-successful-poll-yet`으로 503이 정상이다.
- 방 자동 백업은 bot-service가 6시간마다(`BOT_SERVICE_ROOM_BACKUP_MS`) `status=active` 방 전체를 스냅샷(방당 13개 테이블 + `.sha256` 사이드카)으로 남기고 `huai_recovery_snapshots`에 장부를 쓴다. 수동 백업은 `npm run backup:rooms`, 복구는 `scripts/restore-room-backup.mjs`(기본 dry-run)다.
- 정체 제안(방장이 응답 안 한 제안)은 bot-service가 1시간마다 자동으로 종결 정리한다.
- 서비스 기동은 `node scripts/start-services.mjs` 하나로 bot-service·local-gateway를 함께 띄우고 죽으면 재시작하며 로그를 자동 회전한다. Windows 로그온 자동 기동은 `scripts/install-autostart.ps1`로 등록한다.
