# 야간 방 대화 보관 (nightly-room-archive.cmd)

매일 00:10 Windows 작업 스케줄러가 부른다(작업 이름 `HuAI-NightlyRoomArchive`).

## 순서와 이유

1. **보관** `archive-room-conversations.mjs --apply`
   - 어제까지의 방 대화·이벤트를 jsonl 로 내보내 Supabase Storage 와 로컬에 둔다.
   - LLM 을 쓰지 않는다. 백업은 조용히 실패하면 안 되고, 요약은 조용히 실패할 수 있다.
   - 장부(`huai_archive_manifest`)에 날짜·행수·체크섬을 남긴다. 나중에 지울 때의 유일한 근거다.

2. **요약** `distill-room-memory.mjs --apply`
   - 보관된 하루치를 로컬 claude CLI 로 요약해 `sessions/rooms/<방>/<날짜>_위키.md` 로 남긴다.
   - 리더 판단과 감사가 이 파일을 읽는다(40턴 창 밖을 아는 유일한 통로).
   - 실패해도 1단계 결과에는 영향이 없다. 다음 실행에서 다시 시도된다.

3. **정리 점검** `prune-archived-rows.mjs` (dry-run)
   - `--apply` 를 붙이지 않는다. 무엇이 지워질지 로그로만 보여준다.
   - 실제 삭제는 사람이 판단한다 — 텔레그램은 지운 대화를 되돌려주지 않는다.

## 왜 .cmd 안에 한글이 없나

cmd.exe 는 이 파일을 OEM 코드페이지로 읽는다. UTF-8 한글 주석 줄이 명령으로 해석되어
`'텔레그램은' is not recognized as an internal or external command` 로 죽었고, 로그
리다이렉트까지 같은 줄에서 무너져 **로그 파일조차 남지 않았다**. 자정에 그대로 돌았다면
아무도 모르게 실패했을 것이다. 그래서 설명은 이 파일에, 스크립트에는 영어만 둔다.

## 로그

`C:\tmp\huai-logs\nightly-archive.log` — 실행마다 append.
