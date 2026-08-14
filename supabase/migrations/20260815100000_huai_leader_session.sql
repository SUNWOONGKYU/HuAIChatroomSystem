-- 소대장 CLI 세션 유지.
--
-- 소대장이 방의 맥락을 기억하려면 Claude Code 세션을 이어받아야 한다(--resume).
-- 세션을 잇지 않으면 매 호출이 백지에서 시작해 "직전 논의 뭉치"를 매번 통째로
-- 다시 실어 보내야 하고, 그마저도 이전 판단의 이유를 기억하지 못한다.
--
-- actor 단위로 붙인다 — 방마다 역할마다 세션이 다르다.

alter table huai_ai_actors
  add column if not exists cli_session_id text,
  add column if not exists cli_session_updated_at timestamptz;
