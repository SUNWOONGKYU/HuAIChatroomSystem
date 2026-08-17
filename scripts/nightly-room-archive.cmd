@echo off
REM 매일 밤 방 대화를 보관하고 요약한다. Windows 작업 스케줄러가 부른다.
REM
REM 순서가 중요하다: 보관(무손실) -> 요약(손실 압축) -> 정리 점검(dry-run).
REM 정리는 --apply 를 붙이지 않는다. 실제 삭제는 사람이 결과를 보고 판단한다 —
REM 텔레그램은 지운 대화를 되돌려주지 않으므로, 자동 삭제는 되돌릴 수 없는 쪽으로만 틀린다.

cd /d C:\Dev\HuAIChatroomSystem

REM 로그는 이 파일 안에서 남긴다. 스케줄러 인자에 리다이렉트를 넣으면 인용 규칙 때문에 깨진다.
if not exist "C:\tmp\huai-logs" mkdir "C:\tmp\huai-logs"
call :run >> "C:\tmp\huai-logs\nightly-archive.log" 2>&1
exit /b

:run
echo [%date% %time%] archive start
node --env-file=.env.operation.local scripts/archive-room-conversations.mjs --apply

echo [%date% %time%] distill start
node --env-file=.env.operation.local scripts/distill-room-memory.mjs --apply

echo [%date% %time%] prune check (dry-run, 삭제하지 않음)
node --env-file=.env.operation.local scripts/prune-archived-rows.mjs

echo [%date% %time%] done
exit /b
