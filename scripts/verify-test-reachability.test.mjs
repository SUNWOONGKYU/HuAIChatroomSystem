import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  listAllTestFiles,
  mapDistTestPathToSource,
  expandNpmScript,
  computeReachableTestFiles,
  findUnreachableTestFiles,
  ALLOWLIST
} from "./verify-test-reachability.mjs";

// ── 단위 테스트: 그래프를 구성하는 조각들 ────────────────────────────────────────

test("mapDistTestPathToSource — dist/apps/**/*.test.js 를 apps/**/*.test.ts 로 되돌린다", () => {
  assert.equal(
    mapDistTestPathToSource("dist/apps/bot-service/test/outbox-consumer.test.js"),
    "apps/bot-service/test/outbox-consumer.test.ts"
  );
  assert.equal(
    mapDistTestPathToSource("dist/packages/workflow/test/state-machine.test.js"),
    "packages/workflow/test/state-machine.test.ts"
  );
});
test("mapDistTestPathToSource — dist/ 바깥 경로는 그대로 돌려준다", () => {
  assert.equal(mapDistTestPathToSource("scripts/restore-room-backup.test.mjs"), "scripts/restore-room-backup.test.mjs");
});

test("expandNpmScript — npm run 체인(&&)을 재귀적으로 펼쳐 --test 파일 인자를 모은다", () => {
  const packageScripts = {
    "verify:a": "npm run verify:b && node --test scripts/a.test.mjs",
    "verify:b": "node --test scripts/b.test.mjs scripts/c.test.mjs"
  };
  const out = { files: new Set(), missingScripts: new Set() };
  expandNpmScript("verify:a", packageScripts, new Set(), out);
  assert.deepEqual(
    [...out.files].sort(),
    ["scripts/a.test.mjs", "scripts/b.test.mjs", "scripts/c.test.mjs"]
  );
});
test("expandNpmScript — 존재하지 않는 스크립트 이름은 missingScripts 에 기록하고 조용히 무시하지 않는다", () => {
  const out = { files: new Set(), missingScripts: new Set() };
  expandNpmScript("verify:does-not-exist", {}, new Set(), out);
  assert.ok(out.missingScripts.has("verify:does-not-exist"));
});
test("expandNpmScript — 사이클이 있어도 무한 루프에 빠지지 않는다", () => {
  const packageScripts = {
    "verify:a": "npm run verify:b",
    "verify:b": "npm run verify:a && node --test scripts/only.test.mjs"
  };
  const out = { files: new Set(), missingScripts: new Set() };
  expandNpmScript("verify:a", packageScripts, new Set(), out);
  assert.deepEqual([...out.files], ["scripts/only.test.mjs"]);
});
test("expandNpmScript — node --test 없는 조각(예: npm run build)은 파일을 추가하지 않는다", () => {
  const packageScripts = { "verify:x": "npm run build && node --test scripts/x.test.mjs", build: "node scripts/build-if-needed.mjs" };
  const out = { files: new Set(), missingScripts: new Set() };
  expandNpmScript("verify:x", packageScripts, new Set(), out);
  assert.deepEqual([...out.files], ["scripts/x.test.mjs"]);
});

// ── 동적 참조 3종 특례가 실제로 필요한지(=제거하면 진짜로 도달 불가가 되는지) ──────
// 아래는 되돌림 실증이다 — 이 특례들이 장식이 아니라 실제로 결과에 영향을 준다는
// 것을 증명한다. 특례 자체를 끄는 게 아니라, "특례 없이 커버되는 파일 집합에 이미
// 포함돼 있는가"를 직접 검사하는 방식으로 증명한다(스크립트 자체를 몽키패치하지
// 않고, computeReachableTestFiles() 의 실제 출력에 특례로만 들어올 수 있는 파일이
// 있는지 확인한다).
test("실제 repo: supabase/functions 디렉터리 특례가 없으면 도달 불가능했을 파일이 지금은 도달 가능하다", async () => {
  const { reachable } = await computeReachableTestFiles();
  // package.json 어디에도 "membership.test.ts" 를 개별 파일명으로 나열한 곳이 없다 —
  // verify:supabase-functions 의 디렉터리 재귀 워크 특례로만 들어올 수 있다.
  assert.ok(reachable.has("supabase/functions/_shared/membership.test.ts"));
  assert.ok(reachable.has("supabase/functions/miniapp-tasks/room-isolation.test.ts"));
});
test("실제 repo: verify-game-browser.mjs 의 tests 배열 특례가 없으면 도달 불가능했을 파일이 지금은 도달 가능하다", async () => {
  const { reachable } = await computeReachableTestFiles();
  // package.json 의 "verify:game-browser" 스크립트는 "node scripts/verify-game-browser.mjs"
  // 뿐이라(--test 없음) 일반 파싱으로는 안 잡힌다 — tests 배열 특례로만 들어온다.
  assert.ok(reachable.has("supabase/miniapp-web/_task-artifacts/treasure-collector-runner.test.mjs"));
});
test("실제 repo: verify-multiroom.mjs 의 동적 gates 특례가 없으면 도달 불가능했을 파일이 지금은 도달 가능하다", async () => {
  const { reachable } = await computeReachableTestFiles();
  // "verify:supabase-runtime-loader" 는 package.json 어디에서도 다른 gate 가
  // `npm run verify:supabase-runtime-loader` 로 참조하지 않는다 — MULTI_ROOM_CHECKS
  // 의 런타임 gates 배열(스크립트 텍스트가 아니라 JS 배열)로만 도달한다.
  assert.ok(reachable.has("apps/bot-service/test/supabase-runtime-loader.test.ts"));
});

// ── 재현: 고아 테스트를 실제로 잡는지 ─────────────────────────────────────────
// 아무 곳에도 배선하지 않은 테스트 파일을 저장소 안(scripts/)에 실제로 만들어,
// findUnreachableTestFiles() 가 정확히 그 파일을 지목하는지 확인한다. 이 테스트가
// 통과한다는 것은 "메타 테스트 자체가 고아를 실제로 검출한다"는 뜻이다 — 그래프
// 구성이 지나치게 관대해서(무엇이든 도달 가능으로 치는) 아무것도 못 잡는 상태가
// 아님을 보증한다.
test("재현 — 아무 데도 배선하지 않은 테스트 파일을 만들면 도달 불가능으로 잡힌다", async () => {
  const fixtureRelPath = "scripts/__orphan-reachability-fixture.test.mjs";
  const fixtureAbsPath = path.join(REPO_ROOT, fixtureRelPath);
  writeFileSync(
    fixtureAbsPath,
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("orphan", () => { assert.equal(1, 1); });\n',
    "utf8"
  );
  try {
    const unreachable = await findUnreachableTestFiles();
    assert.ok(
      unreachable.includes(fixtureRelPath),
      `배선하지 않은 신규 테스트 파일이 unreachable 목록에 들어와야 한다 — 실제 목록: ${JSON.stringify(unreachable)}`
    );
  } finally {
    rmSync(fixtureAbsPath, { force: true });
  }
});

test("listAllTestFiles 는 node_modules/dist/.git 을 건너뛴다", () => {
  const files = listAllTestFiles();
  assert.ok(!files.some((file) => file.startsWith("node_modules/")));
  assert.ok(!files.some((file) => file.startsWith("dist/")));
  assert.ok(!files.some((file) => file.startsWith(".git/")));
});
test("listAllTestFiles 는 browser-test.mjs 류(확장자가 .test.mjs 로 안 끝남)는 대상에서 뺀다", () => {
  const files = listAllTestFiles();
  assert.ok(!files.includes("supabase/miniapp-web/index.browser-test.mjs"));
  // 진짜 .test.mjs 파일은 포함돼야 한다(egg-crack-sound-game.browser-test.mjs 와 혼동 금지).
  assert.ok(files.includes("supabase/miniapp-web/egg-game.test.mjs"));
});

// ── 실제 repo 가드 ────────────────────────────────────────────────────────────
// 이 메타 테스트 자체의 존재 이유. 저장소의 모든 *.test.{ts,mjs,js} 파일이
// verify:all 실행 그래프에서 도달 가능한지 확인한다. 도달 불가능한 파일이 있으면
// 파일명을 지목하며 실패한다 — allowlist 에 없는 조용한 제외는 없다.
test("실제 repo: 모든 *.test.{ts,mjs,js} 파일이 verify:all 실행 그래프에서 도달 가능하다(고아 테스트 없음)", async () => {
  const unreachable = await findUnreachableTestFiles();
  assert.deepEqual(
    unreachable,
    [],
    `다음 테스트 파일이 도달 불가능하다(배선하거나 ALLOWLIST 에 사유와 함께 추가하라): ${JSON.stringify(unreachable, null, 2)}`
  );
});

test("실제 repo: package.json 에 존재하지 않는 스크립트를 참조하는 곳이 없다", async () => {
  const { missingScripts } = await computeReachableTestFiles();
  assert.deepEqual([...missingScripts], []);
});

test("ALLOWLIST 항목은 { path, reason } 형태만 허용한다(조용한 제외 금지)", () => {
  for (const entry of ALLOWLIST) {
    assert.equal(typeof entry.path, "string");
    assert.equal(typeof entry.reason, "string");
    assert.ok(entry.reason.length > 0, `${entry.path} 의 allowlist 사유가 비어 있으면 안 된다`);
  }
});
