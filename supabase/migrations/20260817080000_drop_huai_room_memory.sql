-- 방 기억 표를 없앤다.
--
-- 요약을 DB 에 넣으려 했던 이유는 "소대장이 읽어야 하니까"였는데, 소대장 프롬프트를
-- 조립하는 bot-service 가 게이트웨이와 같은 작업 PC 에서 돈다. 즉 디스크를 직접 읽을 수
-- 있고, DB 를 거칠 이유가 없었다.
--
-- 요약은 sessions/rooms/<방>/<날짜>_위키.md 로 남는다. 무손실 원본은 Supabase Storage 의
-- jsonl 이고, DB 에는 그 둘을 가리키는 장부(huai_archive_manifest)만 둔다.

drop table if exists huai_room_memory;
