-- 무엇을 어디에 내보냈는지 적는 장부.
--
-- 정리(삭제)의 근거가 되는 표다. 처음 설계는 "오늘 아카이브 파일이 생겼는가"를 보고
-- 60일 지난 행을 지우려 했는데, 그러면 작업 PC 가 꺼져 있던 날의 데이터가 백업 없이
-- 지워진다 — 텔레그램 봇은 지난 대화를 되가져올 수 없으므로 그 소실은 복구가 안 된다.
--
-- 그래서 "지우려는 행이 장부에 등재돼 있고 내보낸 행 수가 맞는가"를 조건으로 삼는다.
-- 스케줄이 며칠 밀려도, 밀린 날짜는 등재가 안 돼 있으니 그날 것은 지워지지 않는다.

create table if not exists huai_archive_manifest (
  manifest_id uuid primary key default gen_random_uuid(),
  room_id uuid not null references huai_rooms(room_id) on delete cascade,
  -- 내보낸 날짜(KST 기준 하루). UTC 로 자르면 자정 경계에서 이중·누락이 생긴다.
  archive_date date not null,
  -- telegram_updates | events. 표마다 따로 내보내고 따로 지운다.
  source text not null,
  row_count integer not null,
  -- 내보낸 내용의 지문. 장부만 남고 파일이 바뀌었는지 알 수 있어야 한다.
  checksum text not null,
  -- Supabase Storage 안의 경로. 작업 PC 디스크가 죽어도 사본이 남는다.
  object_path text not null,
  byte_size integer not null,
  created_at timestamptz not null default now(),
  constraint huai_archive_manifest_source_check check (source in ('telegram_updates', 'events')),
  -- 같은 날짜를 두 번 내보내도 장부는 한 줄. 멱등의 근거.
  unique (room_id, archive_date, source)
);

create index if not exists huai_archive_manifest_room_date_idx
  on huai_archive_manifest (room_id, archive_date desc);
