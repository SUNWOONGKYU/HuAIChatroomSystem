# HuAI Collab Chatroom System

HuAI Collab Chatroom System은 Telegram 비공개 프로젝트방을 사람과 역할별 AI 봇의 업무 지휘소로 사용하는 Human-AI 협업 운영 시스템입니다.


## 빠른 구축

처음 설치하는 운영자는 아래 문서부터 보면 됩니다.

- `GITHUB_QUICKSTART.md`: GitHub에서 받은 뒤 Telegram 프로젝트방을 실제로 연결하는 빠른 구축 절차
- `GITHUB_RELEASE_CHECKLIST.md`: GitHub 배포 전 보안·문서·검증 체크리스트
- `.env.operation.example`: 운영 환경변수 템플릿
## 현재 구조

- Telegram 프로젝트방: 사람이 요청하고 방장이 버튼으로 결정하는 기본 UI. 포럼 주제(topic)를
  쓰면 주제마다 작업·현황판이 따로 흐릅니다.
- LeaderBot: 요청 정리, 작업 제안, 승인 흐름, 역할 라우팅
- CodexBot / ClaudeBot: 실제 작업 실행과 결과 보고
- AuditBot: 의미 있는 결과물의 독립 검증. 작업자와 다른 엔진이 맡습니다.
- bot-service: Telegram 수신(폴링), 권한 확인, update 멱등 처리, outbox 발신
- Supabase: rooms, members, tasks, events, artifacts, verifications, outbox, 보고 전문, 보관 장부
- local-gateway: 작업 PC에서 허용된 프로젝트 폴더와 adapter만 실행. 방마다 한 프로세스.
- 작업 현황판(Mini App): 작업·산출물·보고 전문을 보고 완료를 승인하는 화면

### 실행 엔진 3종과 인계

Claude Code · Codex · Antigravity(agy) 세 엔진을 씁니다. 한 엔진이 사용 한도에 걸리면 다른
엔진이 이어받고, 최대 두 번까지 넘깁니다 — 세 엔진이 각자 한 번씩 기회를 갖습니다.

감사는 작업자와 다른 엔진이 맡는 것이 원칙입니다. 셋 중 둘이 막혀 작업자 엔진만 남으면 그
엔진으로 감사하되, 독립성이 낮다는 사실을 방에 밝힙니다 — 방장이 알고 승인하는 것과 시스템이
몰래 때우는 것은 다릅니다.

### 결과물 전달

- 웹 산출물(.html): 게이트웨이가 Vercel 에 올려 공개 주소를 만들고, 현황판에서 눌러 실행합니다.
- 문서 산출물(hwp·xlsx·pdf 등): 방에 파일로 올립니다. 링크로는 열리지 않기 때문입니다.
- 작업 중 부산물(디버그 스크린샷, 테스트 파일, 세션 기록)은 결과물로 취급하지 않습니다.

### 긴 보고

실행 결과·감사 보고가 300자를 넘으면 방에는 앞부분만 나가고 [전문 보기] 버튼이 붙습니다.
전문은 현황판에서 읽습니다. 감사 보고 하나가 방을 도배해 정작 대화가 밀려나던 문제 때문입니다.

### 방 기억

하루치 방 대화를 요약해 `sessions/rooms/<방>/<날짜>_위키.md` 로 남기고, 소대장 판단과 감사에
최근 며칠치를 함께 넣습니다. 소대장이 프롬프트로 받는 대화는 최근 40턴이라, 그 창 밖의 결정을
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
- 지시는 봇을 지목해야 접수됩니다: `@봇이름` 멘션, 봇 메시지에 답장, 또는 이름 호출(소대장 몫).
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
```

## 상태

Telegram 기반 핵심 운영 경로와 `/tasks`, `/task`, `/search`, `/trace` 조회 흐름은 자동 검증을 통과했습니다. 실제 서비스 운영 시에는 Supabase, Telegram webhook, bot-service, local-gateway, 작업 PC 인증 상태를 함께 기동해야 합니다. GitHub 배포 전에는 `GITHUB_RELEASE_CHECKLIST.md`를 확인합니다.

자세한 구조는 `docs/시스템_관계도.md`, 실행 흐름은 `docs/작업_흐름도.md` 를 보면 됩니다.
저장소 루트의 2026-08-11 SVG 두 장은 그날 기준이라 오늘 구조가 빠져 있습니다 — 다시 그리기
전까지는 위 두 md 가 최신입니다.

최신 갱신일: 2026-08-17
실행 엔진: Claude · Codex · Antigravity (3엔진, 최대 2회 인계)
실사용 검증: 방 4개(개발·개인회생·상증세법·DCF) 실행 성공, 게임 산출물 배포·브라우저 실행 확인
