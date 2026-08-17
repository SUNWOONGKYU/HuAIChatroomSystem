@echo off
REM Nightly room archive. Called by Windows Task Scheduler.
REM
REM Order matters: archive (lossless) -> distill (lossy) -> prune check (dry-run).
REM The prune step never gets --apply here. Deleting is a human decision, because
REM Telegram cannot return a conversation once it is gone from our database.
REM
REM English only in this file on purpose. cmd.exe reads it in the OEM codepage, so
REM Korean comment lines were parsed as commands and the whole job died before it
REM reached the first node call - silently, since the log redirect died with it.
REM Korean explanation lives in scripts/nightly-room-archive.md next to this file.

chcp 65001 > nul
REM Node writes Korean to the log. Without this it lands as mojibake and the log is
REM unreadable to the person who needs it most - the one investigating a bad night.
set PYTHONIOENCODING=utf-8
set NODE_OPTIONS=
cd /d C:\Dev\HuAIChatroomSystem

if not exist "C:\tmp\huai-logs" mkdir "C:\tmp\huai-logs"
call :run >> "C:\tmp\huai-logs\nightly-archive.log" 2>&1
exit /b

:run
echo [%date% %time%] archive start
node --env-file=.env.operation.local scripts/archive-room-conversations.mjs --apply

echo [%date% %time%] distill start
node --env-file=.env.operation.local scripts/distill-room-memory.mjs --apply

echo [%date% %time%] prune check (dry-run, deletes nothing)
node --env-file=.env.operation.local scripts/prune-archived-rows.mjs

echo [%date% %time%] done
exit /b
