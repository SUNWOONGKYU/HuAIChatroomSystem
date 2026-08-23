# GitHub Quick Start

이 문서는 HuAI Collab Chatroom System을 처음 받은 사람이 Telegram 프로젝트방 기반 운영 환경을 빠르게 구축하기 위한 절차입니다.

## 1. 준비물

- Node.js 24 이상
- Supabase 프로젝트 1개
- (webhook을 쓸 경우에만) 공개 HTTPS 주소 1개: Cloudflare Tunnel, reverse proxy, 또는 배포 호스트 —
  기본값인 polling은 이게 아예 필요 없습니다. 아래 5단계 참고.
- 작업 PC 1대: Codex CLI와 Claude Code가 로그인된 상태
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
BOT_SERVICE_TELEGRAM_CHAT_ID=
BOT_SERVICE_OWNER_TELEGRAM_USER_ID=
BOT_SERVICE_RECEIVE_MODE=polling
BOT_SERVICE_PLATOON_BOT_TOKEN=
BOT_SERVICE_CLAUDE_BOT_TOKEN=
BOT_SERVICE_CODEX_BOT_TOKEN=
BOT_SERVICE_AUDITOR_BOT_TOKEN=
BOT_SERVICE_EXECUTION_TIMEOUT_MS=900000
LOCAL_GATEWAY_MAX_RUNTIME_MS=900000
LOCAL_GATEWAY_LEASE_MS=960000
```

`BOT_SERVICE_RECEIVE_MODE`를 비우거나 `webhook`으로 두면 기본값이 webhook으로 바뀌는데,
그때만 `BOT_SERVICE_PUBLIC_BASE_URL`(공개 HTTPS 주소)이 필요합니다. polling은 이 값 자체가
필요 없습니다.

운영 기본 실행 제한은 15분입니다. 더 긴 작업은 작은 단위로 나누는 것이 기본 원칙입니다.

## 4. Supabase 준비

1. Supabase SQL editor 또는 CLI에서 `supabase/schema.sql`을 적용합니다.
2. 프로젝트방 정보를 seed SQL로 생성합니다.

```powershell
node scripts/generate-supabase-room-seed.mjs
```

3. 생성된 SQL을 검토한 뒤 Supabase에 적용합니다.

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

## 6. Telegram 작업 지시 방식

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

## 7. 서비스 실행

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
Invoke-RestMethod http://127.0.0.1:8797/healthz
Invoke-RestMethod http://127.0.0.1:8797/readyz
```

## 8. Telegram smoke test

Telegram 그룹에서 다음처럼 입력합니다.

```text
@leader_chatroom_bot CodexBot에게 gateway-report-rendering 테스트를 실행하고 통과 여부만 보고하게 해줘
```

정상 흐름:

1. LeaderBot이 작업 제안을 표시합니다.
2. 방장이 `실행` 버튼을 누릅니다.
3. LeaderBot이 작업 시작을 짧게 보고합니다.
4. CodexBot이 실행 결과를 보고합니다.
5. Telegram에는 내부 JSON, hook log, token, stack trace가 노출되지 않습니다.

## 9. 운영 사용법

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
@my_audit_chatroom_bot 이 작업을 보안 검토해줘
```

버튼 — 방과 현황판에 나뉘어 있습니다.

**텔레그램 방** (작업 제안 단계, `buildProposalKeyboard`)

- `실행`: 제안을 승인하고 실제 작업을 시작합니다.
- `수정`: 제안을 다시 다듬도록 요청합니다.
- `반려`: 제안을 진행하지 않습니다.

방에는 이 밖에 `작업 현황판 열기`(주제마다 고정, `/tasks`로도 열림)와, 300자를 넘는 보고에 붙는 `전문 보기`가 있습니다. 둘 다 Mini App을 여는 버튼입니다.

**작업 현황판 / Mini App** (완료 게이트, `FINAL_APPROVAL_ACTIONS`)

- `승인`: 완료를 승인합니다. 웹 산출물은 이때 프로덕션으로 승격됩니다.
- `보완 요청`: 작업자에게 보완을 요청합니다.

완료 단계에 `거부`는 없습니다. 파일을 변경한 작업은 `승인` 앞에 3문항 퀴즈 게이트가 먼저 뜹니다.

> 2026-08-23 승인 게이트 리팩터 이전에는 완료 버튼이 방에 `검증`·`보완`·`완료` 3개로 붙었습니다(`buildCompletionKeyboard`). 그 경로는 현재 프로덕션에서 호출되지 않습니다.

## 10. 배포 전 최종 확인

```powershell
npm run verify:operation-ready
node scripts/verify-no-secrets.mjs
```

GitHub에 올리기 전에는 `.env.operation.local`, bot token, Supabase service role key, webhook secret, CLI 인증 파일이 포함되지 않았는지 반드시 확인합니다.
