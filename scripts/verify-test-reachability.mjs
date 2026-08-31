// 결함(5차 감사) 대응(가장 높은 레버리지) — 이 감사 시리즈 5라운드 내내 "고아
// 테스트"(node --test 로 통과하지만 verify:all 실행 그래프 어디에서도 자동으로 안
// 도는 파일)가 매 라운드 새로 발견됐다. 개별 배선은 그때그때 땜질이었을 뿐, 이
// 패턴 자체를 막는 일반화된 안전망이 없었다. 이 파일이 그 안전망이다 —
// 저장소의 모든 *.test.{ts,mjs,js} 파일을 열거하고, 각각이 scripts/verify-operation
// -ready.mjs 의 STEPS 실행 그래프에서 실제로 도달 가능한지 검증한다.
//
// 그래프를 만드는 방식(완전한 빌드 시스템 그래프 분석이 아니다 — 실용적 텍스트
// 기반 추적이다):
//   1) scripts/verify-operation-ready.mjs 의 operationReadySteps() + commandForStep()
//      하드코딩 분기에서 시작한다.
//   2) 각 스텝의 명령을 "&&" 로 쪼개고, "npm run <script>" 는 package.json 의 scripts
//      필드에서 해당 스크립트 문자열로 치환해 재귀적으로 펼친다(사이클 방지용
//      visited 세트 사용).
//   3) "node --test <파일...>" / "node --test <디렉터리>" 형태에서 파일 인자를
//      전부 도달 가능으로 기록한다. "node <스크립트>.mjs"(--test 없음)는 그 자체로는
//      테스트 파일이 아니므로 무시한다(다음 "&&" 조각에서 --test 로 다시 나올 수
//      있다).
//   4) dist/**/*.test.js 는 원본 apps/**/*.test.ts, packages/**/*.test.ts 로 되돌려
//      매핑한다(빌드 산출물이지 원본이 아니므로 — 원본만 "테스트 파일"로 센다).
//   5) 세 가지 동적 참조는 명령 문자열 파싱만으로는 못 잡으므로 별도로 특례 처리한다:
//      - scripts/verify-supabase-functions.mjs: supabase/functions/** 를 파일명이
//        아니라 디렉터리 재귀 워크로 도는 Node 어댑터다 — 그 디렉터리 아래 전체
//        *.test.ts 를 도달 가능으로 처리한다.
//      - scripts/verify-game-browser.mjs: 하드코딩된 tests 배열을 읽어(부작용 없이 —
//        이 파일은 import 시 자동 실행되지 않도록 export + 가드 패턴으로 고쳤다)
//        그중 *.test.{ts,mjs,js} 로 끝나는 항목만 포함한다(browser-test.mjs 류는
//        애초에 이 메타 테스트의 대상 확장자가 아니다).
//      - scripts/verify-multiroom.mjs: multiRoomOfflineChecks()[].gates 는 문자열이
//        아니라 verify:multiroom-offline 스텝이 런타임에 `npm run ${gate}` 로 도는
//        JS 배열이라 명령 텍스트 파싱으로는 안 보인다 — 그 gate 이름들을 추가
//        "npm run" 진입점으로 취급해 같은 재귀 펼치기에 합류시킨다.
//
// 의도적으로 빼야 하는 것이 있으면 ALLOWLIST 에 { path, reason } 로만 허용한다 —
// 조용한 제외는 없다. 지금은 비어 있다(모든 *.test.* 파일이 실제로 도달 가능하다).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");

const TEST_FILE_RE = /\.test\.(ts|mjs|js)$/;
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git"]);

function normalize(p) {
  return p.replace(/\\/g, "/");
}

function toRepoRelative(absOrRelPath) {
  const abs = path.isAbsolute(absOrRelPath) ? absOrRelPath : path.join(REPO_ROOT, absOrRelPath);
  return normalize(path.relative(REPO_ROOT, abs));
}

// ── 1) 저장소의 모든 *.test.{ts,mjs,js} 파일 열거 ──────────────────────────────
export function listAllTestFiles(root = REPO_ROOT) {
  const results = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIR_NAMES.has(name)) continue;
      const full = path.join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (TEST_FILE_RE.test(name)) results.push(toRepoRelative(full));
    }
  }
  walk(root);
  return results.sort();
}

// ── package.json scripts 필드 ───────────────────────────────────────────────
export function loadPackageScripts(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return pkg.scripts ?? {};
}

// dist/apps/bot-service/test/x.test.js  →  apps/bot-service/test/x.test.ts
// dist/packages/workflow/test/y.test.js →  packages/workflow/test/y.test.ts
// dist/ 바깥 경로는 그대로 돌려준다(scripts/, supabase/ 등은 애초에 dist 로 안 빌드된다).
export function mapDistTestPathToSource(testPath) {
  const normalized = normalize(testPath);
  const match = /^dist\/(.+)\.test\.js$/.exec(normalized);
  if (!match) return normalized;
  return `${match[1]}.test.ts`;
}

// "node --test <a> <b> ..." / "node --test <dir>" 형태에서 뒤따르는 인자를 뽑는다.
// "--test" 뒤에 옵션 플래그(-- 로 시작)가 나오면 그 앞까지만 파일 인자로 본다
// (이 저장소 명령들에는 등장하지 않지만 방어적으로 처리한다).
function extractNodeTestArgs(commandPart) {
  const m = /^node\s+--test\s+(.+)$/.exec(commandPart.trim());
  if (!m) return [];
  return m[1]
    .split(/\s+/)
    .filter((token) => token && !token.startsWith("--"));
}

// 명령 하나(&& 로 이미 쪼개진 조각)를 처리해 도달 가능한 파일/디렉터리 인자를 모은다.
// npm run <script> 는 재귀적으로 펼친다.
function collectFromCommandPart(part, packageScripts, visitedScripts, out) {
  const trimmed = part.trim();
  if (!trimmed) return;

  const npmRunMatch = /^npm run ([\w:.-]+)$/.exec(trimmed);
  if (npmRunMatch) {
    const scriptName = npmRunMatch[1];
    expandNpmScript(scriptName, packageScripts, visitedScripts, out);
    return;
  }

  for (const arg of extractNodeTestArgs(trimmed)) {
    out.files.add(arg);
  }
}

function expandCommandString(command, packageScripts, visitedScripts, out) {
  for (const part of command.split("&&")) {
    collectFromCommandPart(part, packageScripts, visitedScripts, out);
  }
}

export function expandNpmScript(scriptName, packageScripts, visitedScripts, out) {
  if (visitedScripts.has(scriptName)) return;
  visitedScripts.add(scriptName);
  const command = packageScripts[scriptName];
  if (!command) {
    // package.json 에 없는 스크립트 이름 — 존재하지 않는 스크립트를 가리키는
    // 설정 오류다. 도달 불가 판정에 섞이지 않도록 별도로 기록해 findUnreachable
    // 쪽에서 진단할 수 있게 한다.
    out.missingScripts.add(scriptName);
    return;
  }
  expandCommandString(command, packageScripts, visitedScripts, out);
}

// ── 5) 동적 참조 특례 ──────────────────────────────────────────────────────────
async function addSupabaseFunctionsSpecialCase(out) {
  const { FUNCTIONS_DIR } = await import("./verify-supabase-functions.mjs");
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (TEST_FILE_RE.test(name)) out.files.add(toRepoRelative(full));
    }
  }
  walk(FUNCTIONS_DIR);
}

async function addGameBrowserSpecialCase(out) {
  const { tests } = await import("./verify-game-browser.mjs");
  for (const testFile of tests) {
    if (TEST_FILE_RE.test(testFile)) out.files.add(testFile);
  }
}

async function addMultiRoomGatesSpecialCase(packageScripts, visitedScripts, out) {
  const { multiRoomOfflineChecks } = await import("./verify-multiroom.mjs");
  for (const check of multiRoomOfflineChecks()) {
    for (const gate of check.gates) {
      expandNpmScript(gate, packageScripts, visitedScripts, out);
    }
  }
}

// ── 2)+3)+4) STEPS + commandForStep 을 시작점으로 전체 그래프를 편다 ────────────
export async function computeReachableTestFiles(root = REPO_ROOT) {
  const { operationReadySteps, commandForStep } = await import("./verify-operation-ready.mjs");
  const packageScripts = loadPackageScripts(root);

  const out = { files: new Set(), missingScripts: new Set() };
  const visitedScripts = new Set();

  for (const step of operationReadySteps()) {
    const command = commandForStep(step);
    expandCommandString(command, packageScripts, visitedScripts, out);

    if (step === "verify:supabase-functions") {
      await addSupabaseFunctionsSpecialCase(out);
    }
    if (step === "verify:game-browser") {
      await addGameBrowserSpecialCase(out);
    }
    if (step === "verify:multiroom-offline") {
      await addMultiRoomGatesSpecialCase(packageScripts, visitedScripts, out);
    }
  }

  const reachable = new Set();
  for (const file of out.files) {
    reachable.add(normalize(mapDistTestPathToSource(file)));
  }
  return { reachable, missingScripts: out.missingScripts };
}

// 의도적 제외 — 지금은 비어 있다. 항목을 추가할 땐 반드시 { path, reason } 로
// 사유를 남긴다(조용한 제외 금지).
export const ALLOWLIST = [];

export async function findUnreachableTestFiles(root = REPO_ROOT) {
  const allTestFiles = listAllTestFiles(root);
  const { reachable } = await computeReachableTestFiles(root);
  const allowlisted = new Set(ALLOWLIST.map((entry) => normalize(entry.path)));
  return allTestFiles.filter((file) => !reachable.has(file) && !allowlisted.has(file));
}

async function main() {
  const unreachable = await findUnreachableTestFiles();
  if (unreachable.length > 0) {
    console.error(
      "다음 테스트 파일이 verify:all 실행 그래프에서 도달 불가능하다(고아 테스트) — " +
      "scripts/verify-operation-ready.mjs STEPS 또는 관련 package.json 스크립트에 배선하거나, " +
      "정말 의도적이면 scripts/verify-test-reachability.mjs 의 ALLOWLIST 에 사유와 함께 추가하라:"
    );
    for (const file of unreachable) console.error(`- ${file}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Test reachability check passed — 도달 가능한 테스트 파일 전부 배선 확인됨.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
