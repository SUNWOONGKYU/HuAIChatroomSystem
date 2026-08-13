import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["apps", "packages", "supabase", "scripts"];
const patterns = [
  /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/,
  /\bservice_role_[A-Za-z0-9_-]{16,}\b/,
  /BEGIN (RSA|OPENSSH|PRIVATE) KEY/
];

const files = [];
for (const root of roots) collect(root, files);

const hits = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(text)) hits.push(file);
  }
}

if (hits.length > 0) {
  console.error("Potential secret material found:");
  for (const hit of [...new Set(hits)]) console.error(`- ${hit}`);
  process.exit(1);
}

console.log("Secret scan passed.");

function collect(path, out) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) collect(join(path, child), out);
  } else if (/\.(ts|js|sql|json|ya?ml|md)$/.test(path)) {
    out.push(path);
  }
}
