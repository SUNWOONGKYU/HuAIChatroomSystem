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
    LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000",
    LOCAL_GATEWAY_LEASE_MS: "960000"
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
