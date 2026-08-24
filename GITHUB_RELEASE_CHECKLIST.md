# GitHub Release Checklist

GitHub 배포 전 아래 항목을 확인합니다.

## 코드와 검증

- [ ] `npm install` 또는 lockfile 기준 의존성 설치가 가능하다.
- [ ] `npm run build`가 통과한다.
- [ ] `npm run verify:operation-ready`가 통과한다.
- [ ] `node scripts/verify-no-secrets.mjs`가 통과한다.

## 문서

- [ ] `README.md`에서 빠른 구축 문서로 이동할 수 있다.
- [ ] `GITHUB_QUICKSTART.md`가 최신 운영 흐름과 일치한다.
- [ ] `docs/시스템_관계도.md` 와 `docs/작업_흐름도.md` 가 현재 구조·버튼·검증 흐름과 일치한다.
- [ ] 관계도 SVG와 흐름도 SVG(있다면)가 위 두 문서와 어긋나지 않는다.
- [ ] Facebook 소개글 또는 외부 소개문이 현재 구조와 일치한다.
- [ ] `SYSTEM_DOCUMENTATION_SYNC.md`의 동기화 대상에 새 GitHub 문서가 포함되어 있다.

## 운영 자산 (코드 밖)

- [ ] Supabase 마이그레이션이 적용돼 있다(`supabase db push`).
- [ ] Edge Function 은 `--no-verify-jwt` 로 배포돼 있다. 빼면 텔레그램 인증 헤더가 게이트웨이에
      막혀 현황판이 통째로 "인증 실패"가 된다.
- [ ] Edge Function 시크릿에 `TELEGRAM_LEADER_BOT_TOKEN` 이 있다.
- [ ] 현황판 페이지가 `huai-board` 프로젝트로 배포됐다(빌드가 `.vercel` 링크를 다시 박는다).
- [ ] 산출물 프로젝트(`huai-artifacts`)의 배포 보호가 꺼져 있다. 켜져 있으면 방장이 결과물을
      열 때 Vercel 로그인 화면으로 튕긴다.
- [ ] 야간 작업(`HuAI-NightlyRoomArchive`)이 등록돼 있고, 마지막 실행 로그가 정상이다.

## 보안

- [ ] 실제 bot token이 없다.
- [ ] Supabase service role key가 없다.
- [ ] webhook secret 원문이 없다.
- [ ] `.env.operation.local`이 커밋되지 않는다.
- [ ] 로컬 Codex/Claude 인증 파일이 커밋되지 않는다.

## 운영자가 알아야 할 기본값

- 기본 AI 실행 제한: 15분
- 작업 제안 버튼: `실행`, `수정`, `반려`
- 검증 단계 버튼: `검증`, `보완`, `완료`
- AuditBot 자동 검증: 의미 있는 결과물 또는 직접 감사 요청이 있을 때만 수행
- 공식 상태 저장소: Supabase DB
- 실제 작업 실행: local-gateway가 허용된 프로젝트 폴더에서 수행

## 첫 운영 테스트

Telegram 그룹에서 아래 예제로 smoke test를 수행합니다.

```text
@leader_chatroom_bot CodexBot에게 gateway-report-rendering 테스트를 실행하고 통과 여부만 보고하게 해줘
```

정상 기준:

- LeaderBot이 작업 제안을 만든다.
- 방장의 `실행` 버튼이 처리된다.
- CodexBot 또는 ClaudeBot이 결과를 보고한다.
- 내부 JSON, hook log, token, stack trace가 Telegram에 노출되지 않는다.