// 결함 2(package.json 에 dependencies 필드 부재) 대응 — "선언된 경계"가 실제 import
// 그래프와 일치하는지 검증한다. eslint.config.js 의 no-restricted-imports 는 "금지된
// 것"만 잡고 "실제 쓰는 의존"을 선언하게 강제하지는 않는다. 이 스크립트는 그 반대편,
// 즉 각 워크스페이스 패키지가 자기 src/ 에서 실제로 import 하는 다른 내부 패키지
// 목록을 실측하고, package.json 의 dependencies 필드와 대조한다.
//
// 상대경로 깊이("../../" vs "../../../")를 세지 않는다 — eslint.config.js 의
// no-restricted-imports 가 정확히 그 실수로 결함이 났었다(하위 폴더가 생기면 깊이가
// 늘어 조용히 안 잡힘). 대신 실제 파일시스템 경로로 resolve 해서 그 경로가 어느
// 워크스페이스 패키지 폴더 아래에 있는지로 판정한다 — 깊이·중첩과 무관하게 항상 맞는다.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 워크스페이스 레이아웃(packages/*, apps/*)을 실제로 디스크에서 읽어 만든다 —
// 새 패키지가 추가돼도 이 스크립트를 고칠 필요가 없다.
export function discoverWorkspacePackages(repoRoot = REPO_ROOT) {
  const groups = ["packages", "apps"];
  const found = [];
  for (const group of groups) {
    const groupDir = path.join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = path.join(groupDir, entry);
      const packageJsonPath = path.join(dir, "package.json");
      if (!statSync(dir).isDirectory() || !existsSync(packageJsonPath)) continue;
      const name = JSON.parse(readFileSync(packageJsonPath, "utf8")).name;
      found.push({ name, dir, packageJsonPath, srcDir: path.join(dir, "src") });
    }
  }
  return found;
}

function listTsFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) results.push(full);
  }
  return results;
}

const IMPORT_SPECIFIER_RE = /\bfrom\s+"([^"]+)"/g;

// packageDir 의 src/ 아래 모든 .ts 파일에서 다른 워크스페이스 패키지로 나가는
// 상대경로 import(export ... from 포함)를 찾아, 실제로 가리키는 패키지 이름 집합을 낸다.
// 자기 자신을 가리키는 경로(같은 패키지 안 상대 import)는 제외한다.
export function actualInternalDependencies(target, allPackages) {
  const names = new Set();
  for (const file of listTsFiles(target.srcDir)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue; // bare import(@hu-ai/x, node:x 등)는 대상 아님 — 실측상 전부 상대경로다.
      const resolvedBase = path.resolve(path.dirname(file), specifier);
      const owner = allPackages.find((candidate) =>
        candidate.name !== target.name &&
        (resolvedBase === candidate.dir || resolvedBase.startsWith(candidate.dir + path.sep))
      );
      if (owner) names.add(owner.name);
    }
  }
  return names;
}

export function declaredDependencies(packageJsonPath) {
  const json = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return new Set(Object.keys(json.dependencies ?? {}).filter((name) => name.startsWith("@hu-ai/")));
}

export function checkAllPackageBoundaries(repoRoot = REPO_ROOT) {
  const packages = discoverWorkspacePackages(repoRoot);
  return packages.map((target) => {
    const actual = actualInternalDependencies(target, packages);
    const declared = declaredDependencies(target.packageJsonPath);
    const missing = [...actual].filter((name) => !declared.has(name)).sort();
    const extra = [...declared].filter((name) => !actual.has(name)).sort();
    return { name: target.name, actual: [...actual].sort(), declared: [...declared].sort(), missing, extra, ok: missing.length === 0 && extra.length === 0 };
  });
}

// 단독 실행: `node scripts/verify-package-boundaries.mjs` — 다른 verify-*.mjs 스크립트와
// 같은 관례(사람이 읽는 진단 출력 + 실패 시 exit 1).
// `file://${argv[1]}` 문자열 비교는 Windows 에서 argv[1] 이 백슬래시 경로라 항상
// 어긋난다 — fileURLToPath 로 둘 다 실제 경로로 바꿔서 비교한다.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const results = checkAllPackageBoundaries();
  let failed = false;
  for (const result of results) {
    if (result.ok) {
      console.log(`OK   ${result.name}  (dependencies: ${result.declared.join(", ") || "없음"})`);
      continue;
    }
    failed = true;
    console.error(`FAIL ${result.name}`);
    if (result.missing.length > 0) console.error(`  선언 누락(실제 import 하는데 package.json dependencies 에 없음): ${result.missing.join(", ")}`);
    if (result.extra.length > 0) console.error(`  죽은 선언(package.json dependencies 에는 있는데 실제로 import 안 함): ${result.extra.join(", ")}`);
  }
  if (failed) process.exit(1);
  console.log("Package boundary verification passed.");
}
