# HuAI Collab Chatroom System

HuAI Collab Chatroom System은 Telegram 비공개 프로젝트방을 사람과 역할별 AI 봇의 업무 지휘소로 사용하는 Human-AI 협업 운영 시스템입니다.


## 빠른 구축

처음 설치하는 운영자는 아래 문서부터 보면 됩니다.

- `GITHUB_QUICKSTART.md`: GitHub에서 받은 뒤 Telegram 프로젝트방을 실제로 연결하는 빠른 구축 절차
- `HuAI_설치_및_사용_설명서.md`: 비개발자용 설치+사용 통합 가이드(같은 절차를 클릭 단위로 더 잘게 쪼갠 버전)
- `GITHUB_RELEASE_CHECKLIST.md`: GitHub 배포 전 보안·문서·검증 체크리스트
- `.env.operation.example`: 운영 환경변수 템플릿
## 현재 구조

- Telegram 프로젝트방: 사람이 지시하고 결과·협업 운영센터 링크를 받는 대화 UI. 포럼 주제(topic)를
  쓰면 주제마다 작업·협업 운영센터가 따로 흐릅니다.
- LeaderBot: 요청 정리, 작업 제안, 승인 흐름, 역할 라우팅. 파일을 안 바꾸는 조회성 작업은
  별도 승인 없이 자동으로 시작합니다(아래 "승인 카테고리" 참고).
- CodexBot / ClaudeBot: 실제 작업 실행과 결과 보고
- AuditBot: 의미 있는 결과물의 독립 검증. 작업자와 다른 엔진이 맡습니다.
- bot-service: Telegram 수신(코드 자체 기본값은 webhook이나 운영 템플릿 `.env.operation.example`은 polling으로 설정해 배포, 공개 URL 불필요), 권한 확인, update 멱등 처리, outbox 발신
- Supabase: rooms, members, tasks, events, artifacts, verifications, outbox, 보고 전문, 보관 장부
- local-gateway: 작업 PC에서 허용된 프로젝트 폴더와 adapter만 실행. 방마다 한 프로세스.
- 협업 운영센터(Mini App): 작업·산출물·보고 전문을 보고 완료를 승인하는 화면

### 운영 자동화

- **자동 백업**: bot-service가 6시간마다(`BOT_SERVICE_ROOM_BACKUP_MS`) `status=active`인 방 전체를
  스냅샷으로 남깁니다(방당 13개 테이블 + 체크섬 사이드카, `huai_recovery_snapshots`에 장부 기록).
  운영자가 즉시 백업하려면 `npm run backup:rooms`, 되돌리려면 `scripts/restore-room-backup.mjs`를
  씁니다(기본 dry-run, `--apply`는 터미널에서 "yes" 확인 필요).
- **정체 제안 정리**: 1시간마다 방장이 응답하지 않고 쌓인 제안을 자동으로 정리합니다
  (`BOT_SERVICE_STALE_PROPOSAL_CLEANUP_ENABLED`).
- **로그 회전**: `logs/`의 서비스 로그가 기본 20MB(`HUAI_LOG_MAX_BYTES`)를 넘으면 자동 회전하고
  백업 5개(`HUAI_LOG_MAX_BACKUPS`)까지만 보관합니다.
- **서비스 상시 실행**: `node scripts/start-services.mjs` 하나로 bot-service·local-gateway를 함께
  띄우고, 죽으면 자동으로 다시 올립니다. Windows 로그온 시 자동 기동을 원하면
  `scripts/install-autostart.ps1`을 한 번 실행합니다.

### 실행 엔진 3종과 인계

Claude Code · Codex · Gemini 웹 세 엔진을 씁니다. 기존 Antigravity(agy) 데이터는 Gemini 웹으로
호환 라우팅됩니다. 한 엔진이 사용 한도에 걸리면 다른
엔진이 이어받고, 최대 세 번까지 넘깁니다 — 세 엔진이 각자 한 번씩 기회를 갖고, 그래도 다
막히면 처음 엔진으로 한 바퀴 더 돕니다.

감사는 작업자와 다른 엔진이 맡는 것이 원칙입니다. 셋 중 둘이 막혀 작업자 엔진만 남으면 그
엔진으로 감사하되, 독립성이 낮다는 사실을 방에 밝힙니다 — 방장이 알고 승인하는 것과 시스템이
몰래 때우는 것은 다릅니다.

### 결과물 전달

- 웹 산출물(.html): 게이트웨이가 실행 직후 Vercel **프리뷰**로 올립니다. 아직 공개 서비스
  주소가 아니라 방장이 미리 눌러 확인만 할 수 있는 상태입니다. 완료 승인이 실제로 기록된
  뒤에야 그 프리뷰가 프로덕션으로 승격됩니다 — 승인 전에 결과물이 이미 공개돼 있는 문제를
  막기 위해서입니다(Grok Bot 벤치마크 반영, 2026-08-23).
- 문서 산출물(hwp·xlsx·pdf 등): 방에 파일로 올립니다. 링크로는 열리지 않기 때문입니다.
- 작업 중 부산물(디버그 스크린샷, 테스트 파일, 세션 기록)은 결과물로 취급하지 않습니다.

### 승인 카테고리 (필수승인 / 자동허용)

Grok Bot 벤치마크를 반영해 모든 작업을 같은 승인 게이트로 묶지 않습니다.

- 파일을 만들거나 바꾸는 작업(기본값): 협업 운영센터에서 방장이 승인해야 시작됩니다.
- 조회·분석·설명처럼 파일을 안 바꾸는 작업: 승인 버튼을 기다리지 않고 바로 시작됩니다.
  판단이 애매하면 항상 "필수승인" 쪽으로 떨어집니다 — 자동화를 덜 하는 쪽이 안전한 기본값입니다.
- 자동허용은 새 권한이 아닙니다. 자동승인 기록도 방장 승인과 똑같은 권한 검사(owner 전용)를
  통과해야 실제로 실행됩니다 — 승인 권한이 없는 사람의 요청은 자동으로 시작되지 않고 평소처럼
  버튼을 기다립니다.

### 긴 보고

실행 결과·감사 보고가 300자를 넘으면 방에는 앞부분만 나가고 [전문 보기] 버튼이 붙습니다.
전문은 협업 운영센터에서 읽습니다. 감사 보고 하나가 방을 도배해 정작 대화가 밀려나던 문제 때문입니다.

### 방 기억

하루치 방 대화를 요약해 `sessions/rooms/<방>/<날짜>_위키.md` 로 남기고, 리더 판단과 감사에
최근 며칠치를 함께 넣습니다. 리더가 프롬프트로 받는 대화는 최근 40턴이라, 그 창 밖의 결정을
이 요약으로 봅니다.

## Telegram 사용법

```text
@leader_chatroom_bot 작업 내용을 말합니다
/newtask@leader_chatroom_bot 작업 내용을 말합니다
/tasks
/task <task_id>
/search <단어>
/trace <task_id>
@audit_chatroom_bot 이 작업을 보안 검토해줘
```

Telegram의 작업 제안·진행 알림에는 협업 운영센터를 여는 링크가 제공됩니다. 제안 승인·수정·반려,
중간 승인, 완료 승인·보완·취소 등 상태 변경은 모두 협업 운영센터에서 처리합니다.

완료 승인은 방 안 버튼이 아니라 협업 운영센터(Mini App)에서 합니다 — `승인`(최종 완료) 또는
`보완 요청` 둘 중 하나를 누릅니다. 방장이 결과물을 실제로 열어보게 만들기 위한 설계이며,
배포·삭제·권한/인증·환경변수·중요 설정·DB 스키마 변경 등 고위험 작업은 완료 승인 전에
퀴즈 3문항을 먼저 통과해야 합니다. 조회·분석·설명과 단순 저위험 파일 변경에는 퀴즈를 만들지 않습니다.

## 추적 기능

`/trace <task_id>`는 Telegram으로 다음 이력을 직접 내보냅니다.

- 이벤트: 이벤트 종류와 시간
- 산출물: URI, 버전, final 여부, 시간
- 검증: 판정, 대상 버전, 시간

보안 원칙상 raw event payload, bot token, service role key, webhook secret, URI의 민감 query 값은 출력하지 않습니다.

## 운영 원칙

- 공통 봇 4개를 여러 Telegram 프로젝트방에서 재사용합니다.
- 각 프로젝트방은 `telegram_chat_id` 기준으로 별도 room에 연결합니다.
- 권한은 `telegram_user_id` 기준으로 판단합니다.
- 공식 작업 상태는 Telegram 메시지가 아니라 Supabase DB입니다.
- local-gateway는 허용된 프로젝트 루트와 adapter만 실행합니다.
- AuditBot 자동 검증은 의미 있는 결과물이 있을 때만 붙습니다.
- 질문형 멘션은 작업 제안 버튼을 만들지 않고 LeaderBot이 바로 답합니다. 실제 변경 지시는 작업 제안으로 정리합니다.
- 파일을 안 바꾸는 작업 제안은 승인 버튼을 기다리지 않고 자동 시작됩니다. 요청자가 승인 권한이
  없으면 자동 시작은 조용히 무시되고 평소처럼 버튼 승인을 기다립니다(승인 카테고리 참고).
- 지시는 봇을 지목해야 접수됩니다: `@봇이름` 멘션, 봇 메시지에 답장, 또는 이름 호출(리더 몫).
  아무도 지목하지 않은 대화는 맥락으로만 기록하고 작업을 만들지 않습니다.
- 방 대화 원본은 매일 자정 보관하고(Storage + 로컬), 60일이 지난 통신 기록만 정리합니다.
  작업·승인·산출물·보고 전문은 나이와 무관하게 남습니다.
- 작업자는 자신이 띄우지 않은 프로세스를 종료하지 않습니다. 작업 PC 는 사람의 데스크톱입니다.

## 검증

현재 운영 준비 검증 명령:

```powershell
npm run verify:operation-ready
```

주요 개별 검증:

```powershell
npm run build
npm run verify:orchestrator-owner-flow
npm run verify:supabase-store
npm run verify:telegram-bot-commands
npm run verify:doc-sync
node scripts/verify-no-secrets.mjs
npm run lint
```

`npm run verify:all`(= `verify:operation-ready`)은 typecheck·lint·전체 gate(gate12~gate52)·
패키지 경계·스키마-마이그레이션 동기화·테스트 도달성·Supabase Edge Functions까지 순서대로
묶어서 실행하는 단일 진입점입니다. GitHub Actions(`.github/workflows/verify.yml`)가 push·PR마다
`npm ci` → typecheck → lint → `verify:all` 순서로 같은 것을 돌립니다.

## 상태

Telegram 기반 핵심 운영 경로와 `/tasks`, `/task`, `/search`, `/trace` 조회 흐름은 자동 검증을 통과했습니다. 실제 서비스 운영 시에는 Supabase, bot-service, local-gateway, 작업 PC 인증 상태를 함께 기동해야 합니다. Telegram 수신은 코드 자체 기본값이 webhook이지만 운영 템플릿(`.env.operation.example`)은 `BOT_SERVICE_RECEIVE_MODE=polling`으로 설정해 배포하므로 공개 URL이 필요 없고, 공개 도메인을 안정적으로 열어둘 수 있는 배포라면 webhook(`BOT_SERVICE_RECEIVE_MODE=webhook`)으로 전환할 수 있습니다. GitHub 배포 전에는 `GITHUB_RELEASE_CHECKLIST.md`를 확인합니다.

자세한 구조는 `docs/시스템_관계도.md`, 실행 흐름은 `docs/작업_흐름도.md` 를 보면 됩니다.
저장소 루트의 SVG/PNG 두 쌍은 이 두 md와 같은 날짜(아래 최신 갱신일)로 맞춰 다시 그린
것입니다 — 날짜가 이보다 오래된 이미지가 있다면 md가 최신입니다.

최신 갱신일: 2026-09-01
실행 엔진: Claude · Codex · Gemini 웹 (3엔진, 기존 Antigravity 값은 Gemini 웹으로 호환)
검증 상태: 방 4개 운영 흐름과 게임 로컬 상호작용 테스트는 통과했다. 게임의 실제 30초 생존과 공개 URL 브라우저 여정은 테스트 훅·환경 제약으로 완전 검증하지 않아 최종 게이트가 남아 있다.
2026-08-23 반영: Telegram 수신 기본을 polling으로 전환(webhook 터널 불안정 문제 근본 해결) ·
미니앱 승인/퀴즈 API JWT 게이트웨이 버그 수정 · 웹 산출물 배포 전 승인 게이트(프리뷰→프로덕션
승격) · 승인 카테고리 분리(필수승인/자동허용) · Codex 사용량 한도 오분류 수정
2026-08-29~31 반영: bot-service `/readyz`(Supabase 왕복·수신 경로 실측) 신설 · 방 자동 백업/복구
CLI 추가(운영 프로젝트에서 백업·복구 실사용 검증 완료, 파괴적 복구 리허설은 전용 테스트 방에서만
검증) · 정체 제안 자동 정리(1시간 주기) · 로그 회전 · 산출물 배포 타임아웃(멈춘 vercel CLI를
강제 종료) · 미니앱 승인 중 처리 불가능한 결정(예: 없는 방) 종결 처리 · GitHub Actions CI ·
eslint 계층 경계 강제 · DB 마이그레이션(FK 인덱스, allowed_adapters CHECK, 결정 outcome
'failed') 운영 DB 적용 완료.

## 최신 문서 대조 기준 (2026-08-28)

- Telegram은 지시·접수·진행·결과 알림과 협업 운영센터 링크만 제공한다. 승인·보완·취소는 Mini App에서만 실행하며, `/center`는 현재 `roomId`와 포럼 `threadId`를 보존한다.
- 구형 “협업 운영센터 열기” 고정 메시지는 새로 만들지 않는다. 기존 메시지 정리는 `scripts/remove-room-board-message.mjs --apply`를 운영자가 필요할 때 1회 실행한다.
- 실행자는 Claude Code·Codex이고, Gemini 웹은 전용 Chrome CDP 세션을 통한 계획·검토·텍스트 결과용이다. `antigravity`/`agy` 레거시 값은 `gemini_web`로 호환한다.
- 퀴즈는 배포·삭제·권한/인증·환경변수·시크릿·중요 설정·DB 스키마 변경 등 고위험 작업에만 3문항 게이트를 적용한다. 조회·분석·설명·검토와 단순 저위험 파일 변경에는 퀴즈 행을 만들지 않는다.
- LeaderBot은 대화 정리·계획/제안, 작업자는 실행·보고, AuditBot은 독립 검증을 담당한다. synthetic 계획 테스트는 다음과 같이 실행한다.

```powershell
npm run build
node --test dist/apps/bot-service/test/synthetic-leader-planning-webhook.test.js
```

이 테스트는 가상 room, 방장 5001, 참여자 9001의 4턴 대화와 가짜 fetch만 사용하며 실제 Telegram/Supabase에 연결하지 않는다.
