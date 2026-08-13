# Gate22 Workflow Task State Persistence

## Scope

Supabase persistence now connects workflow events to `huai_tasks.status` when the event payload identifies a UUID task.

## Completed behavior

- `huai_events.task_id` is populated from `targetId`, `entityId`, or `taskId` when the value is a UUID.
- The current `huai_tasks.status` is loaded after event persistence.
- `transitionTaskStatus` decides the next status.
- Allowed transitions are patched back to `huai_tasks.status` with `updated_at`.
- Disallowed transitions fail with `task-transition-not-allowed` instead of silently corrupting state.
- Non-UUID proposal ids are ignored, preserving existing proposal/outbox behavior.

## Verification

- `npm run typecheck`
- `npm run verify:task-state-transition`
- `npm run verify:supabase-store`
- `npm run verify:gate22`
- `npm run verify:operation-ready`
