# Full Scope Verification Report — HuAI Collab Chatroom System

검증일: 2026-08-13 KST

## 결론

당초 기획서와 Gate 1 요구사항에 제시된 모든 기능이 구현 완료된 상태는 아니다.

현재 구현은 Telegram 기반 핵심 운영 경로까지 도달했다. 그러나 완성 제품 인수 기준 전체로 보면 아직 미완료 항목과 안전 결함이 남아 있다. 따라서 관계도, 흐름도, 소개문, GitHub 배포 자료를 "전체 완성" 기준으로 갱신하면 안 된다. 현행화는 "핵심 운영 경로 작동, 전체 명세 미완료" 기준으로 해야 한다.

## 실행한 검증

### 자동 검증

명령:

```text
npm run verify:operation-ready
```

결과:

```text
operation-ready passed
```

확인된 범위:

- TypeScript typecheck
- Gate 12~29 자동 검증
- Supabase store/outbox/idempotency
- Telegram webhook E2E
- Telegram callback answer
- Telegram long message split
- local-gateway runtime/consumer
- bot token resolver
- operation env/template/runbook/doc-sync/secrets

### 라이브 운영 상태

명령:

```text
node scripts\operation-status-report.mjs
```

결과 요약:

```text
operation_status status=attention
service bot_service=ok local_gateway=ok(errors=0)
telegram_updates scanned=100 processed=98 failed=2 pending=0
outbox scanned=416 sent=385 dead=31 retry_pending=0 processing=0 stale_processing=0
```

추가 확인:

```text
local-gateway /readyz = {"ok":true,"service":"local-gateway","ready":true}
```

최근 실행 결과:

- CodexBot: 완료 보고 `sent`
- ClaudeBot: Claude Code 세션 한도 실패가 발생했으며, 현재 Telegram에는 사람이 이해할 수 있는 한도 메시지로 표시됨
- AuditBot: 최근 감사 보고는 outbox에 `sent`로 기록됨

## 요구사항 커버리지 판정

| 영역 | 판정 | 근거 |
|---|---|---|
| Telegram 비공개 그룹 + 역할별 4봇 | 부분 통과 | 봇 4개, webhook, 역할별 발신 구조 존재 |
| 중앙 오케스트레이터 | 부분 통과 | 명령/멘션/콜백 라우팅과 outbox 배정 존재 |
| webhook 보안/멱등 | 통과 근거 있음 | invalid secret, unauthorized chat, duplicate update 테스트 통과 |
| 승인 버튼 즉시 응답 | 부분 통과 | callback answer 테스트 통과, 과거 expired/dead row 남음 |
| 작업 제안 생성 | 부분 통과 | `/newtask`, 멘션 제안 생성 동작 존재 |
| 작업 카드 생성 | 통과 근거 있음 | 승인된 `proposal_...`가 `huai_task_proposals`/`huai_tasks`로 물질화되고 실행 요청은 task UUID에 연결되도록 테스트 추가 |
| `/tasks`, `/task` 조회 | 통과 근거 있음 | 구조화 query payload와 Supabase `huai_tasks` 목록/상세 hydration 구현, `verify:supabase-store`/`verify:orchestrator-owner-flow` 통과 |
| DAG 병렬/순차 제어 | 통과 근거 있음 | `planReadyTasks` 단위 테스트와 Supabase local-gateway leasing의 blocking dependency 대기 테스트 통과. 같은 리소스 충돌은 workflow primitive로 검증됨 |
| 중간 승인 게이트 | 미완료 또는 증거 부족 | 상태명은 있으나 실사용 흐름 검증 부족 |
| 의미 있는 결과만 검증 | 부분 통과 | 자동검증 기본 비활성 테스트는 있음. 의미성 판정 정책은 아직 제한적 |
| 검증 의견서 구조화 | 부분 통과 | AuditBot 완료 결과를 `huai_verifications`에 verdict/evidence/required_fixes로 저장하고 통과 시 완료 검토 버튼을 발행하는 테스트 통과. 실제 Telegram 라이브 E2E는 추가 필요 |
| 수정·재검증 | 부분 통과 | 버튼/이벤트와 AuditBot 실행 라우팅, verification 저장은 있음. 원 담당팀 보완 후 범위 재검증 라이브 E2E는 추가 필요 |
| 3단계 완료 | 부분 통과 | AuditBot 통과 후 LeaderBot 완료 검토 outbox와 완료 버튼 발행 테스트 통과. 방장 최종 승인까지의 live E2E는 추가 필요 |
| 완료 후 변경 분기 | 미완료 또는 증거 부족 | 상태기계 항목은 있으나 새 카드 분기 구현/검증 부족 |
| 검색·추적 | 통과 근거 있음 | `/search <단어>`는 `huai_tasks` 검색 결과를, `/trace <task_id>`는 `huai_events` 이벤트명/시간, `huai_artifacts` URI/버전/final 여부, `huai_verifications` 판정/대상버전을 Telegram outbox로 직접 내보낸다. raw payload와 secret query 값은 내보내지 않도록 테스트 통과 |
| 알림/현황 메시지 편집 갱신 | 부분 통과 | 핵심 메시지 축소는 있음. 고정 현황 메시지 편집 갱신 증거 부족 |
| 비밀정보 보호 | 통과 근거 있음 | secret scan, token-free webhook/runbook 테스트 통과 |
| 백업/복구 | 미완료 또는 증거 부족 | `huai_recovery_snapshots`는 있으나 복구 인수 테스트 부족 |

## 확인된 결함

1. 자기검증 방지 가드는 저장소 상태 전이에 배선되었고 테스트가 추가되었다.
   - `packages/workflow/src/index.ts`에는 `isIndependentVerifier`가 있다.
   - 하지만 `apps/bot-service/src/supabase-store.ts`의 `applyTaskTransitions`는 `transitionTaskStatus(current, eventType)`만 호출해 기본 시스템 context가 적용된다.
   - `workflowContextFromEvent`가 이벤트 payload와 event type에서 역할 context를 구성해 `transitionTaskStatus`에 전달한다.

2. 완료/취소 이후 상태 오염 방지는 상태기계 테스트로 보강되었다.
   - `execution_retry_scheduled`, `execution_delayed_or_failed`는 현재 상태와 무관하게 `failed_retryable` 또는 `blocked`로 전이될 수 있다.
   - `execution_retry_scheduled`, `execution_delayed_or_failed`는 terminal status에서 차단된다.

3. `commander_completion_approved`는 `platoon_leader` actor role이 필요하도록 보강되었다.
   - 소대장 완료 결정 단계가 누구에게 허용되는지 코드상 명확히 강제되지 않는다.

4. `packages/workflow` 단위 테스트가 추가되었다.
   - 상태기계가 핵심인데 독립 패키지 단위 테스트 커버리지가 없다.

5. 현재 live ClaudeBot 실행은 Claude Code 세션 한도에 막힌다.
   - 이는 코드 경로의 일반 구현 문제와 별개로, 인수 테스트 전체 통과를 막는 운영 조건이다.

## 문서 현행화 기준

현재 문서와 GitHub 배포 자료는 다음 표현을 사용해야 한다.

```text
Telegram 기반 핵심 운영 경로는 구현되어 있고 자동 검증은 통과했다.
다만 당초 완성 제품 명세 전체는 아직 미완료이며, 특히 보완 후 재검증 live E2E, 백업/복구, 실제 Telegram 라이브 인수 검증이 남아 있다.
```

금지 표현:

```text
전체 기능 구현 완료
정식 인수 완료
모든 Gate 요구사항 완전 통과
Claude/Codex/Audit 종단 운영 상시 정상
```

## 다음 단독 안건

다음 작업은 1건만 먼저 처리해야 한다.

```text
백업/복구와 event/artifact 역추적을 구현하고 인수 테스트를 추가한다.
```

이 안건이 끝나면 workflow 단위 테스트를 추가하고, 그 다음 종결 상태 오염 방지로 넘어간다.
## 2026-08-13 추가 보강

- `/tasks`, `/task <id>`, `/search <단어>`, `/trace <task_id>`는 더 이상 접수 문구만 보내지 않고 Supabase에서 목록/상세/검색/이력 데이터를 조회해 Telegram outbox 본문으로 hydration한다. `/trace`는 이벤트 payload 원문 없이 event type/time, artifact URI/version/final, verification verdict/target version만 출력한다.
- Workflow DAG primitive `planReadyTasks`를 추가해 독립 작업 병렬 실행, blocking dependency 대기, 같은 리소스 충돌 직렬화, cycle 차단을 테스트했다. Supabase local-gateway leasing도 blocking predecessor가 끝나기 전에는 `retry_pending`으로 되돌리도록 연결했다.
- Gateway 결과 보고 truncation 한도를 1200자에서 3200자로 높이고 내부 JSON/hook 로그 필터는 유지했다.
- AuditBot 완료 결과를 `huai_verifications`에 기록하고, 검증 통과 시 LeaderBot이 완료 검토 버튼을 발행하도록 보강했다.
- 검증: `verify:workflow`, `verify:supabase-store`, `verify:orchestrator-owner-flow`, `verify:gate20`, `verify:gate22` 통과.
