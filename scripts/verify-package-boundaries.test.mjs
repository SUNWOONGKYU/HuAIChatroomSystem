import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverWorkspacePackages,
  actualInternalDependencies,
  declaredDependencies,
  checkAllPackageBoundaries
} from "./verify-package-boundaries.mjs";

// 결함 2(package.json 에 dependencies 필드 부재, 3차 라운드까지 연속 지적) 대응.
//
// 이 테스트는 두 켜다: ① 아래 픽스처 테스트들은 스캔 로직 자체를 검증한다(항상
// 통과해야 하는 단위 테스트, 실제 repo 상태와 무관). ② 맨 아래 "실제 repo" 테스트는
// package.json 의 dependencies 선언이 실제 import 그래프와 일치하는지 보는
// 살아있는 가드다 — package.json 8개에 dependencies 를 반영하기 전까지는 이 테스트가
// 실패하는 게 정상이다(선언이 아직 없으니까). 반영 후에는 통과해야 하고, 이후 누군가
// import 를 늘리거나 줄이는데 package.json 을 안 고치면 이 테스트가 잡는다.
// verify:all(scripts/verify-operation-ready.mjs STEPS)에는 아직 등록하지 않았다 —
// package.json 은 이번 라운드 범위 밖(소대장 소유)이라 반영 후에 등록해야 한다.

function makeFixtureWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "pkg-boundary-fixture-"));
  const pkg = (group, name) => {
    const dir = path.join(root, group, name);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    return dir;
  };

  const contractsDir = pkg("packages", "contracts");
  writeFileSync(path.join(contractsDir, "package.json"), JSON.stringify({ name: "@hu-ai/contracts" }));
  writeFileSync(path.join(contractsDir, "src", "index.ts"), "export const x = 1;\n");

  const uiDir = pkg("packages", "telegram-ui");
  writeFileSync(path.join(uiDir, "package.json"), JSON.stringify({ name: "@hu-ai/telegram-ui" }));
  writeFileSync(path.join(uiDir, "src", "index.ts"), "export const y = 1;\n");

  // orchestrator 는 contracts+telegram-ui 를 실제로 import 하지만 package.json 에는
  // contracts 만 선언한다 — "선언 누락" 케이스를 만든다.
  const orchestratorDir = pkg("packages", "orchestrator");
  writeFileSync(
    path.join(orchestratorDir, "package.json"),
    JSON.stringify({ name: "@hu-ai/orchestrator", dependencies: { "@hu-ai/contracts": "*" } })
  );
  mkdirSync(path.join(orchestratorDir, "src", "subdir"), { recursive: true });
  writeFileSync(
    path.join(orchestratorDir, "src", "index.ts"),
    'import { x } from "../../contracts/src/index.js";\nexport { x };\n'
  );
  // 하위 폴더에서 나가는 import — "../" 개수가 다르다. 깊이와 무관하게 잡혀야 한다
  // (eslint no-restricted-imports 가 바로 이 지점에서 깨졌던 결함과 같은 종류).
  writeFileSync(
    path.join(orchestratorDir, "src", "subdir", "probe.ts"),
    'import { y } from "../../../telegram-ui/src/index.js";\nexport { y };\n'
  );

  // ai-adapters 는 실제로는 아무것도 import 안 하는데 package.json 에 contracts 를
  // 선언해 뒀다 — "죽은 선언" 케이스를 만든다.
  const aiAdaptersDir = pkg("packages", "ai-adapters");
  writeFileSync(
    path.join(aiAdaptersDir, "package.json"),
    JSON.stringify({ name: "@hu-ai/ai-adapters", dependencies: { "@hu-ai/contracts": "*" } })
  );
  writeFileSync(path.join(aiAdaptersDir, "src", "index.ts"), "export const z = 1;\n");

  return root;
}

test("discoverWorkspacePackages 는 packages/*, apps/* 아래 package.json 있는 폴더를 전부 찾는다", () => {
  const root = makeFixtureWorkspace();
  try {
    const found = discoverWorkspacePackages(root).map((p) => p.name).sort();
    assert.deepEqual(found, ["@hu-ai/ai-adapters", "@hu-ai/contracts", "@hu-ai/orchestrator", "@hu-ai/telegram-ui"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actualInternalDependencies 는 하위 폴더에서 나가는 import 도 깊이와 무관하게 잡는다", () => {
  const root = makeFixtureWorkspace();
  try {
    const packages = discoverWorkspacePackages(root);
    const orchestrator = packages.find((p) => p.name === "@hu-ai/orchestrator");
    const actual = actualInternalDependencies(orchestrator, packages);
    assert.deepEqual([...actual].sort(), ["@hu-ai/contracts", "@hu-ai/telegram-ui"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declaredDependencies 는 package.json 의 @hu-ai/* dependencies 만 추린다", () => {
  const root = makeFixtureWorkspace();
  try {
    const packages = discoverWorkspacePackages(root);
    const orchestrator = packages.find((p) => p.name === "@hu-ai/orchestrator");
    assert.deepEqual([...declaredDependencies(orchestrator.packageJsonPath)], ["@hu-ai/contracts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkAllPackageBoundaries 는 선언 누락과 죽은 선언을 각각 구분해 낸다", () => {
  const root = makeFixtureWorkspace();
  try {
    const results = checkAllPackageBoundaries(root);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    assert.equal(byName["@hu-ai/contracts"].ok, true);

    // orchestrator: telegram-ui 를 실제로 쓰는데 선언이 없다 → missing 에 잡힌다.
    assert.equal(byName["@hu-ai/orchestrator"].ok, false);
    assert.deepEqual(byName["@hu-ai/orchestrator"].missing, ["@hu-ai/telegram-ui"]);
    assert.deepEqual(byName["@hu-ai/orchestrator"].extra, []);

    // ai-adapters: 아무것도 안 쓰는데 contracts 를 선언해 뒀다 → extra 에 잡힌다.
    assert.equal(byName["@hu-ai/ai-adapters"].ok, false);
    assert.deepEqual(byName["@hu-ai/ai-adapters"].missing, []);
    assert.deepEqual(byName["@hu-ai/ai-adapters"].extra, ["@hu-ai/contracts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 결함(4차 감사) 대응 — 4차 평가관이 프로브로 실증한 세 가지 우회를 회귀 테스트로 고정한다.
function makeBypassFixtureWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "pkg-boundary-bypass-fixture-"));
  const pkg = (group, name) => {
    const dir = path.join(root, group, name);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    return dir;
  };

  const contractsDir = pkg("packages", "contracts");
  writeFileSync(path.join(contractsDir, "package.json"), JSON.stringify({ name: "@hu-ai/contracts" }));
  writeFileSync(path.join(contractsDir, "src", "index.ts"), "export const x = 1;\n");

  const aiAdaptersDir = pkg("packages", "ai-adapters");
  writeFileSync(path.join(aiAdaptersDir, "package.json"), JSON.stringify({ name: "@hu-ai/ai-adapters" }));
  writeFileSync(path.join(aiAdaptersDir, "src", "index.ts"), "export const z = 1;\n");

  // package.json 에는 아무 dependencies 도 선언하지 않는다 — 세 우회 모두 "선언 누락"
  // 으로 잡혀야 한다.
  const orchestratorDir = pkg("packages", "orchestrator");
  writeFileSync(
    path.join(orchestratorDir, "package.json"),
    JSON.stringify({ name: "@hu-ai/orchestrator", dependencies: {} })
  );
  return { root, orchestratorDir };
}

test("동적 import(\"...\") 로 나가는 상대경로 import 도 탐지한다 — 4차 감사 우회 재현", () => {
  const { root, orchestratorDir } = makeBypassFixtureWorkspace();
  try {
    writeFileSync(
      path.join(orchestratorDir, "src", "index.ts"),
      'export async function probe() {\n  const mod = await import("../../ai-adapters/src/index.js");\n  return mod;\n}\n'
    );
    const packages = discoverWorkspacePackages(root);
    const orchestrator = packages.find((p) => p.name === "@hu-ai/orchestrator");
    const actual = actualInternalDependencies(orchestrator, packages);
    assert.ok(actual.has("@hu-ai/ai-adapters"), "동적 import 로 나가는 의존이 탐지돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bare import(\"@hu-ai/x\") 도 탐지한다 — 4차 감사 우회 재현", () => {
  const { root, orchestratorDir } = makeBypassFixtureWorkspace();
  try {
    writeFileSync(path.join(orchestratorDir, "src", "index.ts"), 'import { z } from "@hu-ai/ai-adapters";\nexport { z };\n');
    const packages = discoverWorkspacePackages(root);
    const orchestrator = packages.find((p) => p.name === "@hu-ai/orchestrator");
    const actual = actualInternalDependencies(orchestrator, packages);
    assert.ok(actual.has("@hu-ai/ai-adapters"), "bare import 로 나가는 의존이 탐지돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("from/괄호 없는 부작용-전용 bare import(\"@hu-ai/x\";)도 탐지한다", () => {
  const { root, orchestratorDir } = makeBypassFixtureWorkspace();
  try {
    writeFileSync(path.join(orchestratorDir, "src", "index.ts"), 'import "@hu-ai/ai-adapters";\n');
    const packages = discoverWorkspacePackages(root);
    const orchestrator = packages.find((p) => p.name === "@hu-ai/orchestrator");
    const actual = actualInternalDependencies(orchestrator, packages);
    assert.ok(actual.has("@hu-ai/ai-adapters"), "부작용-전용 bare import 도 탐지돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("외부 npm 패키지·node: bare import 는 내부 의존으로 오탐하지 않는다", () => {
  const { root, orchestratorDir } = makeBypassFixtureWorkspace();
  try {
    writeFileSync(
      path.join(orchestratorDir, "src", "index.ts"),
      'import { readFileSync } from "node:fs";\nimport something from "some-external-package";\nexport { readFileSync, something };\n'
    );
    const packages = discoverWorkspacePackages(root);
    const orchestrator = packages.find((p) => p.name === "@hu-ai/orchestrator");
    const actual = actualInternalDependencies(orchestrator, packages);
    assert.deepEqual([...actual], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 실제 repo 가드 ──────────────────────────────────────────────────────────
// 2026-08-31 시점: package.json 8개 모두 dependencies 필드가 없어 이 테스트는
// 실패한다(정상 — 선언 자체가 없으니까). 소대장이 보고서의 8개 before/after JSON 을
// 반영하면 이 테스트가 통과해야 하고, 그 뒤로는 verify:all(scripts/verify-operation-ready.mjs
// STEPS 배열) 에 등록해 이 대조가 다시 죽은 설정이 되지 않게 한다.
test("실제 repo: 8개 workspace package.json 의 dependencies 가 실제 import 그래프와 일치한다", () => {
  const results = checkAllPackageBoundaries();
  const failures = results.filter((r) => !r.ok);
  assert.deepEqual(
    failures.map((r) => ({ name: r.name, missing: r.missing, extra: r.extra })),
    [],
    "package.json dependencies 가 실제 import 그래프와 어긋난다 — 위 목록 참고"
  );
});
