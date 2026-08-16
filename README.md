# HuAI Collab Chatroom System

HuAI Collab Chatroom System은 Telegram 비공개 프로젝트방을 사람과 역할별 AI 봇의 업무 지휘소로 사용하는 Human-AI 협업 운영 시스템입니다.


## 빠른 구축

처음 설치하는 운영자는 아래 문서부터 보면 됩니다.

- `GITHUB_QUICKSTART.md`: GitHub에서 받은 뒤 Telegram 프로젝트방을 실제로 연결하는 빠른 구축 절차
- `GITHUB_RELEASE_CHECKLIST.md`: GitHub 배포 전 보안·문서·검증 체크리스트
- `.env.operation.example`: 운영 환경변수 템플릿
## 현재 구조

- Telegram 프로젝트방: 사람이 요청하고 방장이 버튼으로 결정하는 기본 UI
- LeaderBot: 요청 정리, 작업 제안, 승인 흐름, 역할 라우팅
- CodexBot: Codex 기반 코드·파일 작업 실행 결과 보고
- ClaudeBot: Claude Code 기반 작업 실행 결과 보고
- AuditBot: 의미 있는 결과물 또는 직접 요청된 감사의 독립 검증
- bot-service: Telegram webhook, 권한 확인, update 멱등 처리, outbox 발신
- Supabase: rooms, members, tasks, events, artifacts, verifications, outbox의 공식 저장소
- local-gateway: 작업 PC에서 허용된 프로젝트 폴더와 adapter만 실행

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

버튼 의미:

- `실행`: 제안을 승인하고 실제 작업을 시작합니다.
- `수정`: 제안을 다시 다듬도록 요청합니다.
- `반려`: 제안을 진행하지 않습니다.
- `검증`: AuditBot 재검증을 요청합니다.
- `보완`: 작업자에게 보완을 요청합니다.
- `완료`: 방장이 최종 완료 승인합니다.

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
```

## 상태

Telegram 기반 핵심 운영 경로와 `/tasks`, `/task`, `/search`, `/trace` 조회 흐름은 자동 검증을 통과했습니다. 실제 서비스 운영 시에는 Supabase, Telegram webhook, bot-service, local-gateway, 작업 PC 인증 상태를 함께 기동해야 합니다. GitHub 배포 전에는 `GITHUB_RELEASE_CHECKLIST.md`를 확인합니다.

최신 갱신일: 2026-08-16
실행 엔진: Claude · Codex · Antigravity (3단 폴백 · 검증완료)
