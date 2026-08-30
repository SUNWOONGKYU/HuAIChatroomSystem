import assert from "node:assert/strict";
import test from "node:test";
import {
  rewriteRelativeTsImports,
  collectFunctionSourceFiles,
  buildAmbientDeclarations,
  buildScratchTsconfig,
  detectDeno
} from "./verify-supabase-functions.mjs";

// 실제 통짜 실행(tsc 컴파일 + node --test)은 verify:operation-ready 의 gate 하나로 이미
// 돈다(그래서 이 테스트가 다시 스크래치 컴파일까지 반복하진 않는다 — 중복 비용을 피한다).
// 여기서는 순수 함수 단위(어댑터의 핵심 규칙)만 잘게 검증한다.

test("상대 임포트의 .ts 확장자만 뗀다 — Deno 컨벤션에서 Node 컨벤션으로", () => {
  const source = 'import { x } from "./types.ts";\nimport { y } from "../a/b.ts";\n';
  const rewritten = rewriteRelativeTsImports(source);
  assert.equal(rewritten, 'import { x } from "./types";\nimport { y } from "../a/b";\n');
});

test("내장 모듈·원격 임포트는 손대지 않는다(상대경로가 아니므로)", () => {
  const source =
    'import test from "node:test";\n' +
    'import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";\n';
  assert.equal(rewriteRelativeTsImports(source), source);
});

test("확장자 없는 상대 임포트는 그대로 둔다(이미 Node 컨벤션)", () => {
  const source = 'import { assertRoomReadAccess } from "./membership";\n';
  assert.equal(rewriteRelativeTsImports(source), source);
});

test("supabase/functions 트리에서 index.ts 를 제외한 모든 .ts 를 모은다", () => {
  const files = collectFunctionSourceFiles();
  assert.ok(files.length > 0, "테스트 대상 소스 파일을 하나도 못 찾았다");
  assert.ok(
    files.every((file) => file.endsWith(".ts") && !file.endsWith("\\index.ts") && !file.endsWith("/index.ts")),
    "index.ts 가 섞여 있다 — Deno.serve 최상위 실행 때문에 Node 로 옮길 수 없다"
  );
  // 알려진 핵심 테스트 파일들이 실제로 포함되는지 — 이 목록이 비면 "고아 테스트"가 되돌아온다.
  const relPaths = files.map((file) => file.replace(/\\/g, "/"));
  for (const expected of [
    "_shared/membership.test.ts",
    "_shared/telegram-init-data.test.ts",
    "miniapp-tasks/room-isolation.test.ts",
    "miniapp-proposals/room-isolation.test.ts"
  ]) {
    assert.ok(
      relPaths.some((path) => path.endsWith(expected)),
      `${expected} 가 수집 대상에서 빠졌다`
    );
  }
});

test("ambient 선언이 Deno.env.get 과 esm.sh 타입 참조를 둘 다 메운다", () => {
  const declarations = buildAmbientDeclarations();
  assert.match(declarations["deno.d.ts"], /declare const Deno/);
  assert.match(declarations["deno.d.ts"], /env:\s*\{\s*get\(/);
  assert.match(declarations["esm-supabase-js.d.ts"], /declare module "https:\/\/esm\.sh\/@supabase\/supabase-js@2"/);
});

test("스크래치 tsconfig 는 strict:true 다 — 꺼지면 판별 유니온 좁히기가 깨진다(직접 재현해 확인함)", () => {
  const tsconfig = buildScratchTsconfig("C:/repo");
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.module, "commonjs");
  assert.deepEqual(tsconfig.include, ["src/**/*.ts"]);
});

test("스크래치 tsconfig 의 typeRoots 는 실제 리포의 node_modules/@types 를 절대경로로 가리킨다", () => {
  const tsconfig = buildScratchTsconfig("C:/repo");
  assert.equal(tsconfig.compilerOptions.typeRoots[0], "C:/repo/node_modules/@types");
});

test("detectDeno 는 미설치 환경에서 예외 없이 undefined 를 돌려준다", () => {
  // 이 저장소의 CI/로컬 실행 환경에 Deno 가 있는지 여부와 무관하게, 호출 자체가 절대
  // throw 하지 않아야 한다 — 조용한 크래시가 곧 "검증 없음"이 되는 걸 막는다.
  assert.doesNotThrow(() => detectDeno());
});
