# GitHub Release Checklist

GitHub 배포 전 아래 항목을 확인합니다.

## 코드와 검증

- [ ] `npm install` 또는 lockfile 기준 의존성 설치가 가능하다.
- [ ] `npm run typecheck`가 통과한다.
- [ ] `npm run lint`가 통과한다(패키지 레이어 경계 위반, `no-eval`/`no-new-func`를 잡는다).
- [ ] `npm run build`가 통과한다.
- [ ] `npm run verify:all`(= `verify:operation-ready`)이 통과한다 — typecheck·lint·gate12~gate52·
      패키지 경계·스키마-마이그레이션 동기화·테스트 도달성·Supabase Edge Functions까지 전부 포함한다.
- [ ] `node scripts/verify-no-secrets.mjs`가 통과한다(추적 파일 전체 스캔, 바이너리 블랙리스트,
      PII 패턴, 제어문자로 쪼갠 시크릿까지 잡는다).
- [ ] GitHub Actions(`.github/workflows/verify.yml`)가 push·PR마다 `npm ci` → typecheck → lint →
      `verify:all`을 자동으로 돌리고 있다.
- [ ] 고위험 작업만 3문항 퀴즈를 적용하고, 조회·분석·설명·검토 및 단순 저위험 변경은 퀴즈를 만들지 않는다.
- [ ] `npm run build` 후 `node --test dist/apps/bot-service/test/synthetic-leader-planning-webhook.test.js`가 통과한다.

## 문서

- [ ] `README.md`에서 빠른 구축 문서로 이동할 수 있다.
- [ ] `GITHUB_QUICKSTART.md`가 최신 운영 흐름과 일치한다.
- [ ] `docs/시스템_관계도.md` 와 `docs/작업_흐름도.md` 가 현재 구조·버튼·검증 흐름과 일치한다.
- [ ] 관계도 SVG와 흐름도 SVG(있다면)가 위 두 문서와 어긋나지 않는다.
- [ ] Facebook 소개글 또는 외부 소개문이 현재 구조와 일치한다.
- [ ] `SYSTEM_DOCUMENTATION_SYNC.md`의 동기화 대상에 새 GitHub 문서가 포함되어 있다.
- [ ] 기능명이 `협업 운영센터`로 통일되고, 구형 고정 메시지는 비활성화되며 필요 시 `scripts/remove-room-board-message.mjs --apply`로 식별된 대상만 정리한다.
- [ ] Telegram은 지시·접수·진행 알림만 담당하고 승인·보완·취소는 Mini App에서만 처리한다. `/center`의 room/thread 전달을 확인했다.
- [ ] LeaderBot·작업자·AuditBot 역할 분리와 Gemini 웹의 Chrome CDP/응답 전용 제약을 문서화했다.
- [ ] 게임 로컬 테스트 결과와 30초 테스트 훅·공개 URL 브라우저 검증 미완료 caveat를 릴리스 판단에 반영했다.

## 운영 자산 (코드 밖)

- [ ] Supabase 마이그레이션이 적용돼 있다(`supabase db push`).
- [ ] Edge Function 은 `--no-verify-jwt` 로 배포돼 있다. 빼면 텔레그램 인증 헤더가 게이트웨이에
      막혀 협업 운영센터가 통째로 "인증 실패"가 된다.
- [ ] Edge Function 시크릿에 `TELEGRAM_LEADER_BOT_TOKEN` 이 있다.
- [ ] 협업 운영센터 페이지가 `huai-board` 프로젝트로 배포됐다(빌드가 `.vercel` 링크를 다시 박는다.
      등록·빌드·배포 전체 절차는 `GITHUB_QUICKSTART.md` 6단계 참고).
- [ ] `BOT_SERVICE_MINIAPP_DIRECT_LINK`가 채워져 있다. 비어 있으면 제안 승인·수정·반려·완료
      승인·보완 요청 키보드 자체가 만들어지지 않는다.
- [ ] 산출물 프로젝트(`huai-artifacts`)의 배포 보호가 꺼져 있다. 켜져 있으면 방장이 결과물을
      열 때 Vercel 로그인 화면으로 튕긴다.
- [ ] 야간 작업(`HuAI-NightlyRoomArchive`)이 등록돼 있고, 마지막 실행 로그가 정상이다.
- [ ] bot-service `/readyz`가 `ok:true`를 반환한다(Supabase 왕복 + Telegram 수신 경로 실측).
      503이면 `checks.supabase`/`checks.receive`로 원인을 먼저 확인한다.
- [ ] 방 자동 백업(`BOT_SERVICE_ROOM_BACKUP_ENABLED`, 기본 6시간 주기)이 켜져 있고,
      `npm run backup:rooms`로 수동 백업이 실제로 되는지 한 번 확인했다.
- [ ] `scripts/restore-room-backup.mjs`의 존재와 dry-run 동작을 운영자가 알고 있다(기본
      dry-run, `--apply`는 터미널 확인 필요).
- [ ] 정체 제안 자동 정리(`BOT_SERVICE_STALE_PROPOSAL_CLEANUP_ENABLED`, 기본 1시간 주기)가 켜져 있다.
- [ ] Windows 로그온 자동 기동을 쓴다면 `scripts/install-autostart.ps1`이 등록돼 있다.

## 보안

- [ ] 실제 bot token이 없다.
- [ ] Supabase service role key가 없다.
- [ ] webhook secret 원문이 없다.
- [ ] `.env.operation.local`이 커밋되지 않는다.
- [ ] 로컬 Codex/Claude 인증 파일이 커밋되지 않는다.

## 운영자가 알아야 할 기본값

- 기본 AI 실행 제한: 15분
- 산출물 배포·승격 타임아웃: 180초 / 90초(`LOCAL_GATEWAY_ARTIFACT_DEPLOY_TIMEOUT_MS`/
  `_PROMOTE_TIMEOUT_MS`) — 넘으면 멈춘 vercel CLI 프로세스 트리를 강제 종료한다.
- Telegram은 접수·진행 알림을 제공하고 승인·보완·취소는 협업 운영센터에서만 수행한다.
- AuditBot 자동 검증: 의미 있는 결과물 또는 직접 감사 요청이 있을 때만 수행
- 공식 상태 저장소: Supabase DB
- 실제 작업 실행: local-gateway가 허용된 프로젝트 폴더에서 수행
- 방 자동 백업: 6시간 주기(`BOT_SERVICE_ROOM_BACKUP_MS`), 방당 스냅샷 보관 상한 240개
  (`HUAI_ROOM_BACKUP_MAX_SNAPSHOTS`)
- 정체 제안 자동 정리: 1시간 주기(`BOT_SERVICE_STALE_PROPOSAL_CLEANUP_MS`)
- 로그 회전: 20MB(`HUAI_LOG_MAX_BYTES`)마다, 백업 5개(`HUAI_LOG_MAX_BACKUPS`)까지 보관

## 첫 운영 테스트

Telegram 그룹에서 아래 예제로 smoke test를 수행합니다.

```text
@leader_chatroom_bot CodexBot에게 gateway-report-rendering 테스트를 실행하고 통과 여부만 보고하게 해줘
```

정상 기준:

- LeaderBot이 작업 제안과 `협업 운영센터 열기` 버튼을 만든다.
- 방장이 협업 운영센터(Mini App)에서 누른 `실행`이 처리된다.
- CodexBot 또는 ClaudeBot이 결과를 보고한다.
- 내부 JSON, hook log, token, stack trace가 Telegram에 노출되지 않는다.
