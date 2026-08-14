# HuAI 상주 서비스 기동 (bot-service + local-gateway).
#
# 예약 작업이 이 파일을 실행한다. 손으로 실행해도 된다.
# 빌드 산출물이 없으면 먼저 빌드한다 — 부팅 직후 dist 가 비어 있을 수 있다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root 'dist/apps/bot-service/src/cli.js'))) {
  Write-Host 'dist 가 없어 먼저 빌드합니다...'
  npm run build
  if ($LASTEXITCODE -ne 0) { throw '빌드 실패 — 서비스를 기동하지 않습니다.' }
}

node (Join-Path $root 'scripts/start-services.mjs')
