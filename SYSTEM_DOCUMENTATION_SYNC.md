# HuAI 시스템 문서 동기화 규칙

시스템 동작이나 Telegram 사용자 경험이 바뀌면 코드 수정과 함께 아래 문서를 같이 갱신한다.

## 동기화 대상

- `2026_08_11__HuAI_Collab_Chatroom_System_페이스북_소개글.md`
- `2026_08_11__CODEX_방식A_다중그룹_온보딩_지시문.md`
- `2026_08_11__HuAI_System_관계도.svg`
- `2026_08_11__HuAI_System_작업흐름도.svg`
- `README.md`
- `GITHUB_QUICKSTART.md`
- `GITHUB_RELEASE_CHECKLIST.md`

## 문서 동기화 체크

- Telegram 버튼 문구나 의미가 바뀌었는가?
- LeaderBot, CodexBot, ClaudeBot, AuditBot 역할이 바뀌었는가?
- 승인, 실행, 검증, 완료 흐름이 바뀌었는가?
- 자동 검증 조건이 바뀌었는가?
- Supabase, local-gateway, webhook 연결 방식이 바뀌었는가?
- 운영 기본값, 실행 제한, 재시작 절차가 바뀌었는가?

해당 항목 중 하나라도 맞으면 설명문, 관계도, 흐름도, GitHub 빠른 구축 문서를 함께 수정한다.

## 현재 사용자 표시 기준

- 작업 제안 버튼: `실행`, `수정`, `반려`
- 검증 단계 버튼: `검증`, `보완`, `완료`
- 실행 결과는 사람이 알아야 할 짧은 내용만 Telegram에 표시한다.
- 내부 JSON, 훅 로그, 토큰 사용량, 파일 경로 나열은 기본적으로 숨긴다.
- AuditBot 자동 검증은 의미 있는 결과물에만 붙인다.
- AI 협의 요청은 LeaderBot이 ClaudeBot, CodexBot, AuditBot 역할 실행으로 분리한다. 이를 다중 AI 협의로 표기한다.
- 사람이 원하면 `@audit_chatroom_bot`으로 직접 감사를 요청한다.
- `/trace <task_id>`는 이벤트·산출물 URI·검증 이력을 Telegram으로 직접 출력한다.
- `/trace` 출력에는 raw event payload와 URI secret query 값을 포함하지 않는다.
- 질문형 멘션은 작업 제안 버튼 없이 즉답하고, 실제 변경 지시만 작업 제안으로 만든다.
- 기본 AI 실행 제한은 15분이다.