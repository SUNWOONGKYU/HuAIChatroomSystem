// supabase/functions/**(Deno Edge Function) 회귀 테스트 11개를 실제로 실행한다.
//
// 배경(품질 인프라 감사에서 발견): 이 디렉터리의 테스트 파일들이 어떤 npm 스크립트에도
// 안 걸려 있었다 — 미니앱 인증(HMAC initData 검증)·권한(membership)·방 격리
// (room-isolation) 같은 보안 핵심 경로가 회귀해도 자동으로는 안 잡히는 상태였다.
//
// 실행 방식(Deno 없이 Node 로): 이 디렉터리의 테스트 파일들은 이미 node:test/node:assert
// 만 참조하도록 작성돼 있다 — Deno.* 는 프로덕션 코드(membership.ts, miniapp-auth.ts) 쪽에서만
// 쓰이고, 그마저도 테스트가 필요하면 자체적으로 globalThis.Deno 셈을 주입해 우회한다
// (membership.test.ts 의 fakeSupabase() 참고). _shared/proposal-payload.test.ts 상단
// 주석이 이미 수동 절차(스크래치 디렉터리 복사 → 상대 import 의 ".ts" 확장자 제거 →
// tsc 컴파일 → node --test)를 문서화해 뒀다 — 이 스크립트는 그 절차를 그대로 자동화한다.
// Deno CLI가 로컬에 없어도 이 경로로 전부 "실제 실행"된다 — 조용한 스킵이 아니다.
//
// Deno 가 설치돼 있어도 추가로 `deno test`는 돌리지 않는다 — index.ts 들이
// "https://esm.sh/@supabase/supabase-js@2" 원격 임포트를 실제로 내려받아야 해서 CI·오프라인
// 환경에서 네트워크 의존성이 생겨 흔들릴 수 있다. 이 Node 어댑터가 이미 같은 로직(handler.ts/
// _shared/*.ts, Deno.serve 배선이 없는 순수 부분)을 실행 검증하므로 충분하다.
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, "..");
export const FUNCTIONS_DIR = path.join(REPO_ROOT, "supabase", "functions");

// 상대 임포트("./x.ts", "../a/b.ts")만 ".ts" 를 뗀다 — Deno 컨벤션 → Node 컨벤션. "node:test"
// 같은 내장 모듈, "https://esm.sh/..." 원격 임포트는 상대경로가 아니므로 손대지 않는다
// (뒤쪽은 ambient .d.ts 로 따로 처리한다 — buildAmbientDeclarations 참고).
export function rewriteRelativeTsImports(source) {
  return source.replace(/from "(\.\.?\/[^"]+)\.ts"/g, 'from "$1"');
}

// index.ts 는 제외한다 — Deno.serve(...)가 모듈 로드 시점에 실행되고 "https://esm.sh/..."
// 런타임 임포트(타입 전용이 아님)까지 갖고 있어 Node 로 옮길 수 없다. 테스트는 index.ts 를
// 직접 import 하지 않는다(handler.ts/deps.ts 를 통해 순수 로직만 검증한다) — 그래서 제외해도
// 커버리지 손실이 없다.
export function collectFunctionSourceFiles(functionsDir = FUNCTIONS_DIR) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (name.endsWith(".ts") && name !== "index.ts") files.push(full);
    }
  };
  walk(functionsDir);
  return files;
}

// membership.ts/miniapp-auth.ts 가 참조하는 Deno.env.get 최소 타입과, membership.ts 가
// 타입 전용으로 임포트하는 "https://esm.sh/@supabase/supabase-js@2" 를 로컬에서 해석 가능하게
// 만드는 ambient 선언. 실제 소스 파일은 건드리지 않는다 — 이 스크래치 컴파일에만 적용된다.
export function buildAmbientDeclarations() {
  return {
    "deno.d.ts": 'declare const Deno: {\n  env: { get(key: string): string | undefined };\n};\n',
    "esm-supabase-js.d.ts":
      'declare module "https://esm.sh/@supabase/supabase-js@2" {\n  export type SupabaseClient = any;\n}\n'
  };
}

// strict:true 가 필수다 — 이게 꺼지면(비-strict) 판별 유니온(discriminated union) 좁히기가
// 일부 버전에서 깨져(TS2339) 정상 코드가 컴파일 에러로 뜬다(직접 재현해 확인함). typeRoots 를
// 리포 루트의 node_modules/@types 로 명시해야 스크래치 디렉터리에 node_modules 가 없어도
// node:test/node:assert 타입을 찾는다.
export function buildScratchTsconfig(repoRoot = REPO_ROOT) {
  return {
    compilerOptions: {
      module: "commonjs",
      target: "ES2022",
      moduleResolution: "node",
      outDir: "dist",
      rootDir: "src",
      esModuleInterop: true,
      skipLibCheck: true,
      strict: true,
      typeRoots: [path.join(repoRoot, "node_modules", "@types").replace(/\\/g, "/")]
    },
    include: ["src/**/*.ts"]
  };
}

export function detectDeno() {
  try {
    const out = execFileSync("deno", ["--version"], { encoding: "utf8" });
    return out.split("\n")[0].trim();
  } catch {
    return undefined;
  }
}

async function stageScratchCopy(scratchDir) {
  const srcDir = path.join(scratchDir, "src");
  await mkdir(srcDir, { recursive: true });

  for (const file of collectFunctionSourceFiles()) {
    const rel = path.relative(REPO_ROOT, file);
    const dest = path.join(srcDir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    const text = await readFile(file, "utf8");
    await writeFile(dest, rewriteRelativeTsImports(text), "utf8");
  }

  const ambientDir = path.join(srcDir, "_ambient");
  await mkdir(ambientDir, { recursive: true });
  for (const [name, content] of Object.entries(buildAmbientDeclarations())) {
    await writeFile(path.join(ambientDir, name), content, "utf8");
  }

  const tsconfigPath = path.join(scratchDir, "tsconfig.json");
  await writeFile(tsconfigPath, JSON.stringify(buildScratchTsconfig(), null, 2), "utf8");
  return tsconfigPath;
}

// 삭제 실패해도(결함 4 와 같은 종류의 Windows 파일 잠금) 조용히 삼키지 않는다 — 재시도 후
// 그래도 안 되면 사유를 로그로 남긴다.
async function cleanupScratchDir(scratchDir) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await rm(scratchDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 3) {
        console.error(
          JSON.stringify({
            type: "verify-supabase-functions-cleanup-failed",
            scratchDir,
            attempt,
            error: String(error).slice(0, 200)
          })
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

export async function runSupabaseFunctionsTests() {
  const denoVersion = detectDeno();
  if (denoVersion) {
    console.log(
      `[verify:supabase-functions] Deno 감지됨(${denoVersion}) — 원격 임포트 네트워크 의존을 피하려고 그래도 Node 어댑터로 실행한다(이 파일 상단 주석 참고).`
    );
  } else {
    console.log(
      "[verify:supabase-functions] Deno 미설치 — Node 어댑터로 실행한다(node:test 기반, 기존에 문서화된 수동 절차를 자동화함). 조용한 스킵이 아니라 실제로 테스트를 돌린다."
    );
  }

  const scratchDir = await mkdtemp(path.join(tmpdir(), "huai-supabase-functions-"));
  try {
    const tsconfigPath = await stageScratchCopy(scratchDir);

    // Windows 에서 .bin/tsc.cmd 는 셸 래퍼라 shell:true 없이는 spawnSync 가 EINVAL 로
    // 죽는다(artifact-publisher.ts 의 vercel.cmd 와 같은 종류의 문제 — 직접 재현해 확인함).
    const tscBin = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    const compile = spawnSync(tscBin, ["-p", tsconfigPath], {
      cwd: scratchDir,
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true
    });
    if (compile.error || compile.status !== 0) {
      console.error("[verify:supabase-functions] tsc 컴파일 실패 — 어댑터 문제가 아니라 실제 타입 오류일 수 있다:");
      if (compile.stdout) console.error(compile.stdout);
      if (compile.stderr) console.error(compile.stderr);
      return { ok: false, exitCode: 1 };
    }

    const distDir = path.join(scratchDir, "dist");
    const testEnv = {
      ...process.env,
      // board/handler.test.ts 의 실제 index.html 대조 서브테스트가 스크래치 복사본 밖의
      // 원본 파일을 찾을 수 있게 절대경로를 준다 — 안 주면 그 서브테스트만 스스로 skip 한다.
      MINIAPP_INDEX_HTML_PATH: path.join(REPO_ROOT, "supabase", "miniapp-web", "index.html")
    };
    const run = spawnSync(process.execPath, ["--test", distDir], { cwd: scratchDir, encoding: "utf8", env: testEnv });
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.error || run.status !== 0) {
      return { ok: false, exitCode: run.status ?? 1 };
    }

    console.log("[verify:supabase-functions] supabase/functions 회귀 테스트 전체 통과 (Node 어댑터 경로).");
    return { ok: true, exitCode: 0 };
  } finally {
    await cleanupScratchDir(scratchDir);
  }
}

async function main() {
  const result = await runSupabaseFunctionsTests();
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
