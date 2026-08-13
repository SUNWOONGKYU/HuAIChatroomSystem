import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function defaultOperationEnvFile(root = process.cwd()) {
  return resolve(root, ".env.operation.local");
}

export function loadOperationEnvFile(filePath) {
  if (!existsSync(filePath)) return { loaded: false, values: {} };
  const values = parseOperationEnv(readFileSync(filePath, "utf8"));
  return { loaded: true, values };
}

export function applyOperationEnvFile(env = process.env, filePath = defaultOperationEnvFile()) {
  const result = loadOperationEnvFile(filePath);
  for (const [key, value] of Object.entries(result.values)) {
    if (env[key] === undefined) env[key] = value;
  }
  applyOperationEnvAliases(env);
  return { loaded: result.loaded, keys: Object.keys(result.values) };
}

export function parseOperationEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    values[key] = unquoteEnvValue(rawValue);
  }
  return values;
}

export function applyOperationEnvAliases(env = process.env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_SERVICE_KEY) {
    env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_KEY;
  }
  return env;
}

function unquoteEnvValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
