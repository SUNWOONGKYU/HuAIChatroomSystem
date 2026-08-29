import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const roots = ["apps", "packages", "supabase", "scripts"];
// 루트의 배포 템플릿도 본다. 라이브에서 .env.operation.example 에 개발자 PC 의 절대경로가
// 기본값으로 들어간 채 나갔는데, 확장자가 .example 이라 이 스캔이 아예 안 봤다.
const rootTemplates = readdirSync(".").filter((name) => /^\.env.*\.example$/.test(name));

const patterns = [
  { name: "telegram-bot-token", regex: /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/ },
  { name: "service-role-key", regex: /\bservice_role_[A-Za-z0-9_-]{16,}\b/ },
  { name: "private-key-block", regex: /BEGIN (RSA|OPENSSH|PRIVATE) KEY/ },
  // 특정 PC 에만 있는 경로. 코드·템플릿에 박히면 다른 PC 에서 조용히 없는 파일을 가리킨다.
  // 테스트 fixture 는 제외한다(아래 collect).
  { name: "machine-absolute-path", regex: /[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+\\{1,2}|[A-Za-z]:\\{1,2}Dev\\{1,2}HuAIChatroomSystem/ }
];

const files = [];
for (const root of roots) collect(root, files);
for (const template of rootTemplates) files.push(template);

const hits = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const { name, regex } of patterns) {
    const match = regex.exec(text);
    if (match) hits.push(`${file} [${name}] ${match[0].slice(0, 60)}`);
  }
}

if (hits.length > 0) {
  console.error("Potential secret material found:");
  for (const hit of [...new Set(hits)]) console.error(`- ${hit}`);
  process.exit(1);
}

console.log("Secret scan passed.");

function collect(path, out) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) collect(join(path, child), out);
  } else if (/\.(ts|js|mjs|sql|json|ya?ml|md)$/.test(path) && !/\.test\.(ts|js|mjs)$/.test(path) && !/browser-test\.mjs$/.test(path)) {
    out.push(path);
  }
}
