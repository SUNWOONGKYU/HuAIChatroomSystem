# Gate 7 — Supabase Runtime Persistence

목표: fake-store와 동일한 포트를 구현하는 Supabase REST/RPC 저장소를 추가해 Telegram update, orchestrator event/outbox, outbox lease/send/retry/dead 경계를 실제 DB 런타임에 연결할 수 있게 한다.

- [x] Phase 1: 현 포트/스키마/테스트 구조 확인
- [x] Phase 2: Supabase REST/RPC store 구현
- [x] Phase 3: fake fetch 기반 persistence/lease/mark 테스트 추가
- [x] Phase 4: typecheck/build/기존 consumer 검증
- [x] Phase 5: Codex 읽기전용 검증 반영

제외: 실제 Supabase 프로젝트 접속, 실제 secret 값 입력, 운영 webhook 배포.

