# GitHub Quick Start

> 협업 운영센터 진입: 텔레그램 봇 메뉴의 `/center`를 선택합니다. 예전 고정 협업 운영센터 메시지는 사용하지 않습니다.

이 문서는 HuAI Collab Chatroom System을 처음 받은 사람이 Telegram 프로젝트방 기반 운영 환경을 빠르게 구축하기 위한 절차입니다.

## 1. 준비물

- Node.js 24 이상
- Supabase 프로젝트 1개
- (webhook을 쓸 경우에만) 공개 HTTPS 주소 1개: Cloudflare Tunnel, reverse proxy, 또는 배포 호스트 —
  기본값인 polling은 이게 아예 필요 없습니다. 아래 5단계 참고.
- 작업 PC 1대: Codex CLI와 Claude Code가 로그인된 상태(설치·로그인 절차는 각 공식 문서 참고 —
  [Claude Code](https://code.claude.com/docs/en/quickstart) /
  [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)). Gemini 웹을 사용할 경우 자동화 전용
  Chrome(CDP 9222)에 운영자가 직접 로그인해야 합니다(비밀번호·2FA 자동 입력 없음).
- Telegram 비공개 그룹 1개
- Telegram BotFather로 만든 봇 4개

필수 봇:

- LeaderBot
- ClaudeBot
- CodexBot
- AuditBot

네 봇은 반드시 서로 다른 Telegram bot token을 사용합니다. 통합 봇 하나가 여러 역할을 연기하는 구조는 사용하지 않습니다.

권장 프로필 색상:

- LeaderBot: 진한 주황 `#D9480F`, `assets/telegram-bot-profiles/leaderbot-deep-orange.jpg`
- ClaudeBot: 밝은 주황 `#F59F00`, `assets/telegram-bot-profiles/claudebot-orange.jpg`
- CodexBot: 보라 `#7C3AED`, `assets/telegram-bot-profiles/codexbot-purple.jpg`
- AuditBot: 금색 `#F2C94C`, `assets/telegram-bot-profiles/auditbot-gold.jpg`

Telegram 기본 이니셜 배경색은 직접 제어하지 않습니다. `npm run apply:telegram-bot-profiles`로 위 JPG를 각 봇 프로필 사진에 적용합니다. 수동 대안은 BotFather `/setuserpic`입니다.

## 2. 설치

```powershell
npm install
npm run build
npm run verify:operation-ready
```

`verify:operation-ready`가 통과하면 코드, 스키마, 문서, 보안 검사, Telegram 연동 스크립트가 기본 기준을 만족한 상태입니다.

## 3. 환경변수 작성

`.env.operation.example`을 참고해서 실제 운영 환경변수를 준비합니다. 실제 token, service role key, webhook secret은 GitHub에 올리지 않습니다.

중요 값:

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
BOT_SERVICE_RECEIVE_MODE=polling
BOT_SERVICE_LEADER_BOT_TOKEN=
BOT_SERVICE_CLAUDE_BOT_TOKEN=
BOT_SERVICE_CODEX_BOT_TOKEN=
BOT_SERVICE_AUDITOR_BOT_TOKEN=
BOT_SERVICE_LEADER_BOT_USERNAME=
BOT_SERVICE_CLAUDE_BOT_USERNAME=
BOT_SERVICE_CODEX_BOT_USERNAME=
BOT_SERVICE_AUDITOR_BOT_USERNAME=
BOT_SERVICE_EXECUTION_TIMEOUT_MS=900000
LOCAL_GATEWAY_MAX_RUNTIME_MS=900000
LOCAL_GATEWAY_LEASE_MS=960000
LOCAL_GATEWAY_ALLOWED_ROOTS=
LOCAL_GATEWAY_ID=
BOT_SERVICE_MINIAPP_DIRECT_LINK=
VERCEL_BOARD_PROJECT_ID=
VERCEL_BOARD_ORG_ID=
GEMINI_WEB_SESSION_SCRIPT=<YOUR_HOME>\.codex\skills\웹세션-자동화\session.js
GEMINI_WEB_CHAT_URL=
GEMINI_WEB_BRIDGE_ENTRYPOINT=<YOUR_PROJECT_ROOT>\scripts\gemini-web-adapter.mjs
LOCAL_GATEWAY_ALLOWED_ADAPTERS=codex,claude_code,gemini_web,antigravity
```

`BOT_SERVICE_TELEGRAM_CHAT_ID`/`BOT_SERVICE_OWNER_TELEGRAM_USER_ID`는 위 목록에 없습니다 —
`SUPABASE_URL`을 채우면 멀티룸 모드(`hasAnySupabaseRuntimeEnv`, `apps/bot-service/src/
local-runtime.ts`)로 부팅되어 이 두 값은 아예 읽지 않습니다(방마다 chat-id/owner-id는
아래 4단계에서 온보딩 명령의 `--chat-id`/`--owner-id` 인자로 따로 넣습니다). `.env.
operation.example`에도 이 둘은 주석 처리돼 있습니다 — 굳이 채워도 해는 없지만 불필요한
이중 입력입니다.

`BOT_SERVICE_RECEIVE_MODE`를 비우거나 `webhook`으로 두면 기본값이 webhook으로 바뀌는데,
그때만 `BOT_SERVICE_PUBLIC_BASE_URL`(공개 HTTPS 주소)이 필요합니다. polling은 이 값 자체가
필요 없습니다.

`BOT_SERVICE_*_BOT_USERNAME`은 실제로 BotFather에서 만든 봇 username과 반드시 같아야
합니다(방에서 `@username` 멘션을 인식하는 데 그대로 쓰입니다) — 템플릿의 예시값
(`your_leader_bot` 등)을 그대로 두면 멘션이 인식되지 않습니다.

`LOCAL_GATEWAY_ID`는 `supabase-store.ts`의 `requiredEnv`가 부팅 시 강제하는 값입니다
(없으면 local-gateway가 `missing-env:LOCAL_GATEWAY_ID`로 즉시 죽습니다). 아래 4단계에서
방을 시딩할 때 나오는 `gateway_id` 값을 그대로 씁니다.

`BOT_SERVICE_MINIAPP_DIRECT_LINK`를 비워 두면 부팅은 되지만, 제안 승인·수정·반려·완료
승인·보완 요청을 만드는 키보드 자체가 하나도 생성되지 않습니다(`leader-planning-store.ts`
/ `chat-command-store.ts`) — 사실상 아무 작업도 승인할 수 없습니다. 값을 채우려면 먼저
아래 6단계(협업 운영센터 Mini App 등록·배포)를 완료해야 합니다. `VERCEL_BOARD_PROJECT_ID`
/ `VERCEL_BOARD_ORG_ID`도 6단계에서 만드는 Vercel 프로젝트 정보이므로 지금은 비워 둡니다.

운영 기본 실행 제한은 15분입니다. 더 긴 작업은 작은 단위로 나누는 것이 기본 원칙입니다.

## 4. Supabase 준비

1. Supabase SQL editor 또는 CLI에서 `supabase/schema.sql`을 적용합니다.
2. 프로젝트방 정보를 seed SQL로 생성합니다.

```powershell
node scripts/generate-supabase-room-seed.mjs
```

3. 생성된 SQL을 검토한 뒤 Supabase에 적용합니다.
4. 생성된 SQL의 `huai_gateway_instances` insert 문에 있는 `gateway_id` 값(또는
   `node scripts/onboard-telegram-room.mjs`를 쓴다면 그 출력의 `gateway_id=<uuid>` 줄)을
   복사해 `.env.operation.local`의 `LOCAL_GATEWAY_ID`에 넣습니다. 이 값이 비어 있으면
   local-gateway가 부팅 시 `missing-env:LOCAL_GATEWAY_ID`로 즉시 종료합니다
   (`apps/local-gateway/src/supabase-store.ts`의 `requiredEnv`).

저장 원칙:

- Telegram chat id와 user id는 숫자 표시명이나 username이 아니라 실제 id로 저장합니다.
- bot token 원문은 DB에 저장하지 않고 `env:...` 형태의 secret reference만 저장합니다.

## 5. Telegram 연결

BotFather에서 네 봇을 만들고 비공개 그룹에 초대합니다. 그룹 privacy는 운영 정책에 맞춰
설정하되, 어느 수신 방식이든 update는 중앙 오케스트레이터에서 권한 검사 후 처리합니다.

### 기본값: polling (권장)

`BOT_SERVICE_RECEIVE_MODE=polling`이면 bot-service가 시작할 때 자동으로 각 봇의 웹훅을
해제하고 Telegram에서 직접 update를 당겨옵니다 — 이 단계에서 따로 실행할 명령이 없습니다.
공개 HTTPS 주소, 터널, 인증서 관리가 전부 필요 없습니다. 개인 PC에서 자체 호스팅하거나
공인 도메인이 없는 대부분의 운영 환경에는 이쪽을 권합니다.

### 대안: webhook

공인 도메인이 있고 안정적으로 열어둘 수 있는 배포라면 webhook을 쓸 수 있습니다.
`BOT_SERVICE_RECEIVE_MODE=webhook` + `BOT_SERVICE_PUBLIC_BASE_URL`을 설정한 뒤:

```powershell
node scripts/generate-telegram-webhook-commands.mjs
node scripts/apply-telegram-webhooks.mjs --dry-run
node scripts/apply-telegram-webhooks.mjs --apply
```

임시 터널(예: `cloudflared tunnel --url ...`)로 webhook을 쓸 경우, 터널은 계정 없이 뜨는 대신
재시작마다 주소가 바뀌고 통보 없이 끊길 수 있습니다 — `scripts/webhook-watchdog.mjs`를
Windows 작업 스케줄러 등으로 주기 실행해 자동 감지·복구하거나, 애초에 polling을 쓰는 쪽이
운영 부담이 적습니다.

## 6. 협업 운영센터(Mini App) 등록·배포

`BOT_SERVICE_MINIAPP_DIRECT_LINK`가 비어 있으면 제안 승인·수정·반려·완료 승인·보완 요청
키보드가 전혀 만들어지지 않습니다(3단계 참고) — 이 단계는 건너뛸 수 없습니다.

### 6-1. Vercel CLI 로그인

```powershell
npm install -g vercel
vercel login
```

브라우저가 열리며 Vercel 계정 인증을 요구합니다. 이 로그인은 아래 6-2뿐 아니라, 운영 중
`local-gateway`가 실행 산출물(.html)을 올리는 `LOCAL_GATEWAY_ARTIFACT_VERCEL_PROJECT`
배포(`artifact-publisher.ts`)에도 그대로 쓰이는 같은 머신 단위 CLI 인증입니다.

### 6-2. Mini App 프론트엔드 빌드

```powershell
node --env-file=.env.operation.local scripts/build-miniapp-web.mjs
```

`supabase/miniapp-web/`의 `index.html`·`egg-game.html`·`robots.txt`를 `dist/miniapp-web/`로
복사하면서 `index.html`의 `__MINIAPP_FUNCTIONS_BASE_URL__` 자리표시자를 실제 Supabase
Functions 주소로 채웁니다(`MINIAPP_FUNCTIONS_BASE_URL`이 없으면 `SUPABASE_URL`에서
`<project-ref>.functions.supabase.co`로 자동 유도 — `scripts/build-miniapp-web.mjs`).
`VERCEL_BOARD_PROJECT_ID`/`VERCEL_BOARD_ORG_ID`가 이미 있으면 `dist/miniapp-web/.vercel/`도
같이 써서 다음 배포를 같은 Vercel 프로젝트에 고정합니다.

### 6-3. Vercel에 배포

`*.supabase.co`는 HTML 응답을 `text/plain`으로 덮어써 Mini App 페이지를 직접 못 올립니다
(`scripts/build-miniapp-web.mjs` 상단 주석) — 그래서 별도 정적 호스팅(Vercel)에 올립니다.

```powershell
cd dist/miniapp-web
vercel deploy --prod --yes --name huai-board
cd ../..
```

출력 마지막 줄의 `https://*.vercel.app` 주소를 메모해 둡니다(6-5에서 씁니다). 첫 배포면
Vercel이 `huai-board`라는 새 프로젝트를 만듭니다 — 그 프로젝트 Settings → General에서
Project ID(`prj_...`)와 Org/Team ID(`team_...`)를 확인해 `.env.operation.local`의
`VERCEL_BOARD_PROJECT_ID`/`VERCEL_BOARD_ORG_ID`에 채워 두면, 이후 빌드가 `dist/miniapp-web`를
지울 때마다(6-2가 매번 그렇게 합니다) 사라지는 `.vercel/` 연결 정보를 다시 박아 같은
프로젝트로 배포를 고정합니다 — 채우지 않으면 다음 빌드·배포가 폴더 이름으로 새 프로젝트를
또 만듭니다.

### 6-4. Supabase Edge Functions 배포

Mini App 화면은 `supabase/functions/board`, `miniapp-proposals`, `miniapp-approve`,
`miniapp-tasks`, `miniapp-quiz` 5개 Edge Function을 호출합니다. 이 저장소는
`supabase/config.toml`을 포함하지 않으므로 새 체크아웃은 기본적으로 CLI-link 안 된 상태입니다
(`2026_08_12__OPERATION_INCIDENT_RUNBOOK.md` "Database Migration After a Code Update" 참고) —
먼저 연결합니다.

```powershell
supabase link --project-ref <ref>
```

그 뒤 함수 5개를 배포합니다. `--no-verify-jwt`를 빼면 Mini App의 Telegram 인증 헤더가
Supabase 기본 JWT 검증에 막혀 협업 운영센터가 통째로 "인증 실패"가 됩니다
(`GITHUB_RELEASE_CHECKLIST.md`).

```powershell
supabase functions deploy board --no-verify-jwt
supabase functions deploy miniapp-proposals --no-verify-jwt
supabase functions deploy miniapp-approve --no-verify-jwt
supabase functions deploy miniapp-tasks --no-verify-jwt
supabase functions deploy miniapp-quiz --no-verify-jwt
```

함수가 Mini App의 Telegram `initData` 서명을 검증하는 데 쓰는 시크릿을 등록합니다
(`supabase/functions/_shared/telegram-init-data.ts`):

```powershell
supabase secrets set TELEGRAM_LEADER_BOT_TOKEN=<LeaderBot 토큰>
```

`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`는 Supabase가 Edge Function에 자동 주입하므로
따로 설정할 필요가 없습니다.

### 6-5. BotFather에 Mini App 등록

1. `@BotFather`에게 `/newapp`을 보내고 LeaderBot을 선택합니다.
2. 제목·설명·아이콘을 입력합니다.
3. Web App URL에 6-3에서 받은 Vercel 주소를 입력합니다.
4. Short name(영문/숫자, 예: `board`)을 입력합니다.

등록이 끝나면 Direct Link는 `https://t.me/<LeaderBot username>/<short name>` 형태입니다
(예: `https://t.me/my_leader_chatroom_bot/board`).

### 6-6. 환경변수에 반영

```text
BOT_SERVICE_MINIAPP_DIRECT_LINK=https://t.me/my_leader_chatroom_bot/board
```

값은 반드시 `https://t.me/`로 시작해야 그룹 채팅에서도 Mini App으로 열립니다(`web_app` 타입
인라인 버튼은 Telegram 공식 문서상 사설 채팅 전용이라 그룹에서 안 눌립니다 — 그래서 이
저장소는 Direct Link 방식을 씁니다, `packages/telegram-ui/src/index.ts`). 이미 서비스가
떠 있다면 아래 8단계의 재시작 스크립트로 반영합니다.

## 7. Telegram 작업 지시 방식

LeaderBot은 사람 말을 아래 유형으로 분류합니다. 사람끼리 하는 일반 대화는 멘션하지 않고 그냥 말하면 됩니다. AI에게 맡길 말만 `@leader_chatroom_bot`으로 보냅니다.

| 지시 유형 | 예시 | 처리 |
| --- | --- | --- |
| 새 작업 | `@leader_chatroom_bot 버튼 오류 원인을 찾아 수정해줘` | 실행 제안을 만들고 방장 승인을 기다립니다. |
| AI 지정 작업 | `@leader_chatroom_bot CodexBot에게 라우터 테스트를 보강해줘` | 제안에 담당 AI 힌트를 기록합니다. |
| 여러 AI 검토 | `@leader_chatroom_bot 개선 사항 3개를 찾아 우선순위까지 검증해봐` | ClaudeBot·CodexBot 검토와 AuditBot 검증 흐름으로 분류합니다. |
| 후속 작업 | `proposal_xxx 계속해` | 기존 작업의 후속 제안으로 묶습니다. |
| 답장 후속 작업 | 작업 메시지에 답장으로 `진행해`, `이거 수정해` | 답장 대상의 `proposal_id/task_id`를 찾아 후속 제안으로 묶습니다. |
| 오류 수정 | 오류 전문, 화면 캡처 caption, 또는 `proposal_id/task_id`와 함께 `이거 오류 해결해` | 실행 가능한 오류 수정 제안으로 만듭니다. |
| 조회/상담 | `현재 진행 상황 알려줘`, `어떻게 써?` | 작업 제안 없이 바로 답합니다. |
| 단순 확인 | `OK`, `확인`, `알겠어` | 짧게 확인만 응답합니다. |
| 모호한 지시 | `진행해`, `그거 해`, `코덱스에게 작업시켜` | 대상이나 작업 내용이 없으면 실행하지 않고 필요한 정보를 되묻습니다. |

Telegram 사진/파일 caption과 답장 대상 메시지는 라우터가 읽습니다. 단순 새 메시지로 `진행해`만 쓰면 어느 작업인지 알 수 없으므로, 작업 메시지에 답장하거나 `proposal_id/task_id`를 붙입니다.

"필요한 정보를 되묻습니다"는 화면에 실제로 이렇게 나타납니다(코드 그대로):

- `진행해`, `그거 해`처럼 답장 대상 없이 새 메시지로만 보내면:
  > 어느 작업을 이어갈지 확인이 필요합니다. task_id 또는 proposal_id를 붙여 다시 말하거나, 해당 작업 메시지에 답장해 주세요.
- `코덱스에게 작업시켜`처럼 AI만 지정하고 시킬 내용이 없으면:
  > CodexBot에게 넘길 작업 내용을 함께 적어주세요.
  > 예: @leader_chatroom_bot CodexBot에게 현재 오류 원인을 찾아 수정해줘

## 8. 서비스 실행

운영 환경변수를 로드한 상태에서 다음 두 서비스를 실행합니다.

```powershell
node dist/apps/bot-service/src/cli.js
node dist/apps/local-gateway/src/cli.js
```

이미 실행 중인 운영 서비스를 현재 환경값으로 재시작하려면 다음 스크립트를 사용합니다.

```powershell
node scripts/restart-operation-services-from-live-env.mjs
```

상태 확인:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
Invoke-RestMethod http://127.0.0.1:8797/healthz
Invoke-RestMethod http://127.0.0.1:8797/readyz
```

`/healthz`는 설정만 확인하는 liveness(프로세스가 떠 있는지)이고, `/readyz`는 실제로 일할
수 있는지(Supabase 연결·Telegram 수신 상태)를 확인하는 readiness입니다 — `curl 200`만 보고
"동작한다"고 판단하지 말고 `/readyz`의 `ok` 값을 봅니다. bot-service `/readyz`가 503을 주면
응답 JSON의 `checks.supabase`(Supabase 연결 실패)와 `checks.receive`(Telegram 수신 중단 —
polling이면 마지막 폴링이 오래됐다는 뜻, webhook이면 등록이 안 됐다는 뜻)를 확인합니다.
자세한 원인별 대응은 `2026_08_12__OPERATION_INCIDENT_RUNBOOK.md`의 "Service Health"를 참고합니다.

## 9. Telegram smoke test

Telegram 그룹에서 다음처럼 입력합니다.

```text
@leader_chatroom_bot CodexBot에게 gateway-report-rendering 테스트를 실행하고 통과 여부만 보고하게 해줘
```

정상 흐름:

1. LeaderBot이 작업 제안과 `협업 운영센터 열기` 버튼을 표시합니다.
2. 방장이 그 버튼으로 협업 운영센터(Mini App)를 열고 `실행` 버튼을 누릅니다.
3. LeaderBot이 작업 시작을 짧게 보고합니다.
4. CodexBot이 실행 결과를 보고합니다.
5. Telegram에는 내부 JSON, hook log, token, stack trace가 노출되지 않습니다.

## 10. 운영 사용법

일반 작업:

```text
@leader_chatroom_bot 작업 내용을 말합니다
```

명시적 새 작업:

```text
/newtask@leader_chatroom_bot 작업 내용을 말합니다
```

조회:

```text
/tasks
/task <task_id>
/search <단어>
/trace <task_id>
```

직접 감사:

```text
@audit_chatroom_bot 이 작업을 보안 검토해줘
```

Telegram에는 작업 접수·진행 알림과 `협업 운영센터 열기` 링크가 제공됩니다. 별도로 봇 메뉴의
`/center`를 선택하면 현재 방·포럼 주제의 협업 운영센터가 열립니다. 예전 고정 메시지는 사용하지 않습니다.
300자를 넘는 보고의 `전문 보기` 링크가 제공됩니다. 제안 승인·수정·반려, 중간 승인,
완료 승인·보완·취소 등 상태 변경은 모두 협업 운영센터에서 처리합니다.

**협업 운영센터 / Mini App** (완료 게이트, `FINAL_APPROVAL_ACTIONS`)

- `승인`: 완료를 승인합니다. 웹 산출물은 이때 프로덕션으로 승격됩니다.
- `보완 요청`: 작업자에게 보완을 요청합니다.

완료 단계에 `거부`는 없습니다. 배포·삭제·권한/인증·환경변수·시크릿·중요 설정·DB 스키마 변경 등 고위험 작업만 `승인` 앞에 3문항 퀴즈 게이트가 뜹니다. 조회·분석·설명·검토와 단순 저위험 파일 변경은 퀴즈가 없습니다.

> 2026-08-23 승인 게이트 리팩터 이전에는 완료 버튼이 방에 `검증`·`보완`·`완료` 3개로 붙었습니다(`buildCompletionKeyboard`). 그 경로는 현재 프로덕션에서 호출되지 않습니다.

## 11. GitHub·운영 배포

```powershell
node --env-file=.env.operation.local scripts/set-telegram-bot-commands.mjs --apply
node scripts/verify-no-secrets.mjs
npm run build
npm run verify:doc-sync
git status --short
```

GitHub에는 `.env.operation.local`, Telegram 토큰, Supabase service role key, webhook secret,
CLI 인증 파일을 올리지 않습니다. 운영 PC 반영 순서는 `git pull` → `npm install` → `npm run build`
→ 환경 검증 → 서비스 재시작 → 메뉴 등록입니다. 기존 고정 메시지 정리는 필요할 때 다음 명령을
한 번 실행합니다.

```powershell
node --env-file=.env.operation.local scripts/remove-room-board-message.mjs --apply
```

synthetic LeaderBot 계획 회귀 테스트는 실제 운영 데이터 없이 실행합니다.

```powershell
npm run build
node --test dist/apps/bot-service/test/synthetic-leader-planning-webhook.test.js
```

`apps/bot-service/test/synthetic-leader-planning-webhook.test.ts`가 가상 방의 방장 5001·참여자 9001 4턴을 주입해 최근 대화 기반 계획과 제목·목적·범위·완료조건 proposal을 검증합니다. 실제 Telegram/Supabase 전송이나 운영 DB 쓰기는 없습니다.

## 12. 배포 전 최종 확인

```powershell
npm run verify:operation-ready
node scripts/verify-no-secrets.mjs
```

GitHub에 올리기 전에는 `.env.operation.local`, bot token, Supabase service role key, webhook secret, CLI 인증 파일이 포함되지 않았는지 반드시 확인합니다.
