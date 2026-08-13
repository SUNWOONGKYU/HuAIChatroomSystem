# PHASE 체크리스트 — Gate 6 Local Gateway Execution

## 목표

중앙 outbox의 `local_gateway` target을 로컬 PC 실행 루프로 연결하고, Claude Code/Codex 실행 요청을 정책 검증, 실행 계획, 이벤트 기록, 완료/재시도/폐기 상태로 처리한다.

## 범위

- `ExecutionRequest` payload 검증
- `GatewayPolicy` 기반 project path/adapter/timeout 정책 검증
- 주입 가능한 process runner
- `GatewayEvent` sink
- local gateway consumer loop
- fake runner/store 기반 실행 검증

## Phase

- [x] Phase 0: Gate 5 완료 상태 확인
- [x] Phase 1: Codex 작업팀 병렬 분석
- [x] Phase 2: local gateway executor/consumer 구현
- [x] Phase 3: fake 실행 검증 추가
- [x] Phase 4: 타입·빌드·구조·비밀정보 검증
- [x] Phase 5: Codex V1/V2 검증

## 제외

- 실제 Claude Code/Codex CLI 호출 테스트
- 실제 Supabase SDK 연결
- 실제 Telegram bot token 입력
- 별도 웹/PWA/모바일 앱

## 현재 검증 결과

- `npm run typecheck` 통과
- `npm run build` 통과
- `node scripts/verify-structure.mjs` 통과
- `node scripts/verify-no-secrets.mjs` 통과
- `npm run verify:local-gateway-consumer` 통과
  - allowed path + codex adapter success 검증
  - path policy reject 검증
  - adapter policy reject 검증
  - stdout/stderr secret masking + retryable failure 검증
- 실제 orchestrator approval payload -> ExecutionRequest -> local gateway consumer 실행 검증 추가 통과
- consumer markRetry/markDead가 failed event의 실제 errorKind를 저장하도록 보강
- Codex V1 재검증 PASS
- Codex V2 최종 재검증 PASS
