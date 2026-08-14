# HuAI — 로그온 시 서비스 자동 기동 등록 (이 PC 에서 1회 실행).
#
# AtStartup 이 아니라 AtLogOn 인 이유:
#   local-gateway 가 Claude Code·Codex CLI 를 실행하는데, 그 구독 인증이 사용자 프로필에 있다.
#   SYSTEM 계정으로 부팅 시점에 띄우면 CLI 가 로그인되지 않아 모든 작업이 실패한다.
#
# 네트워크가 올라오기 전에 시작하면 Telegram 폴링이 초기 오류를 내므로 1분 지연을 준다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'start-services.ps1'
$taskName = 'HuAI-Chatroom-Services'

if (-not (Test-Path $script)) { throw "start-services.ps1 이 없습니다: $script" }
if (-not (Test-Path (Join-Path $root '.env.operation.local'))) {
  throw '.env.operation.local 이 없습니다 — 운영 환경변수를 먼저 준비하세요.'
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
try { $trigger.Delay = 'PT1M' } catch { }

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "등록 완료: '$taskName' — 로그온 1분 후 기동 (사용자: $env:USERNAME)"
Write-Host ''
Write-Host '지금 바로 켜기 :  Start-ScheduledTask -TaskName ''HuAI-Chatroom-Services'''
Write-Host '상태 보기      :  Get-ScheduledTask -TaskName ''HuAI-Chatroom-Services'''
Write-Host '해제           :  Unregister-ScheduledTask -TaskName ''HuAI-Chatroom-Services'' -Confirm:$false'
Write-Host "로그            :  $(Join-Path $root 'logs')"
