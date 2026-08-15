import { execFileSync, spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const projectRef = "smxtewoijwelmmpyogwt";
const raw = execFileSync("supabase", ["projects", "api-keys", "--project-ref", projectRef, "-o", "json"], {
  encoding: "utf8"
});
const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
const service = JSON.parse(json).find((key) => key.name === "service_role");
const serviceRoleKey = service?.api_key ?? service?.apiKey ?? service?.key;
if (!serviceRoleKey) throw new Error("missing-service-role-key");

const pidFile = "C:\\tmp\\huai-local-gateway.pid";
stopExistingLocalGateways(pidFile);
rmSync(pidFile, { force: true });

const child = spawn("node", ["dist/apps/local-gateway/src/cli.js"], {
  cwd: "C:\\Dev\\HuAIChatroomSystem",
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: {
    ...process.env,
    SUPABASE_URL: `https://${projectRef}.supabase.co`,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\Dev\\HuAIChatroomSystem",
    LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code",
    LOCAL_GATEWAY_HEALTH_PORT: "8797",
    LOCAL_GATEWAY_MAX_ATTEMPTS: "3",
    LOCAL_GATEWAY_LIMIT: "5",
    LOCAL_GATEWAY_INTERVAL_MS: "250",
    // 동시 3방 요구에 맞춘 워커 수. 배치 하나를 소화하는 최악 시간은
    // maxRuntime × ceil(limit / concurrency) 이고, lease 는 그보다 길어야
    // 아직 돌고 있는 행이 재리스돼 같은 CLI 가 두 번 실행되는 걸 막는다.
    // 900000 × ceil(5 / 3) = 1800000 이므로 여기에 1분 여유를 더했다.
    LOCAL_GATEWAY_CONCURRENCY: "3",
    LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000",
    LOCAL_GATEWAY_LEASE_MS: "1860000"
  }
});

child.unref();
writeFileSync(pidFile, String(child.pid));
console.log(`local_gateway_pid=${child.pid}`);

function stopExistingLocalGateways(pidFile) {
  const escapedPidFile = pidFile.replace(/'/g, "''");
  const command = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$pidFile = '${escapedPidFile}'`,
    "if (Test-Path -LiteralPath $pidFile) { $oldPid = Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue; if ($oldPid -match '^\\d+$') { Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue } }",
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dist[/\\\\]apps[/\\\\]local-gateway[/\\\\]src[/\\\\]cli\\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join('; ');
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { stdio: "ignore" });
  if (result.error) throw result.error;
}
