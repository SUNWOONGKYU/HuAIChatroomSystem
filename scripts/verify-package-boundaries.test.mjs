import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverWorkspacePackages,
  actualInternalDependencies,
  declaredDependencies,
  checkAllPackageBoundaries,
  findUnresolvableDynamicSpecifiers,
  layerViolations,
  verifyLayerTableMatchesEslintConfig,
  ALLOWED_INTERNAL_DEPENDENCIES
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

// ── 결함(6차 감사) 대응 — 경로 판정(packageOf/addDirectOwner) 이 순수 문자열 비교라
// 놓치던 두 가지: symlink 실경로, Windows 대소문자 변형 경로. 6차 평가관 A 가 실증한
// 그대로 재현한다.
test("node_modules/@hu-ai/<pkg> 심볼릭 링크 실경로를 거친 상대경로 import 도 소유 판정에 잡힌다", () => {
  const { root, orchestratorDir } = makeBypassFixtureWorkspace();
  try {
    const scopeDir = path.join(root, "node_modules", "@hu-ai");
    mkdirSync(scopeDir, { recursive: true });
    // npm workspaces 가 실제로 만드는 것과 같은 형태 — node_modules/@hu-ai/<pkg> 가
    // packages/<pkg> 를 가리키는 심볼릭 링크(디렉터리).
    symlinkSync(path.join(root, "packages", "ai-adapters"), path.join(scopeDir, "ai-adapters"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(
      path.join(orchestratorDir, "src", "index.ts"),
      'import { z } from "../../../node_modules/@hu-ai/ai-adapters/src/index.js";\nexport { z };\n'
    );
    const packages = discoverWorkspacePackages(root);
    const orchestrator = packages.find((p) => p.name === "@hu-ai/orchestrator");
    const actual = actualInternalDependencies(orchestrator, packages);
    assert.ok(actual.has("@hu-ai/ai-adapters"), "node_modules 심볼릭 링크 실경로를 거친 의존도 탐지돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "Windows 대소문자 변형 경로(대문자로 바꿔 쓴 패키지 디렉터리명)도 소유 판정에 잡힌다",
  { skip: process.platform !== "win32" ? "Windows 전용 — 파일시스템이 대소문자를 구분하지 않는 플랫폼에서만 의미가 있다" : false },
  () => {
    const { root, orchestratorDir } = makeBypassFixtureWorkspace();
    try {
      // 실제 디렉터리는 "ai-adapters"(소문자)인데 import 는 대소문자를 바꿔 쓴다.
      writeFileSync(
        path.join(orchestratorDir, "src", "index.ts"),
        'import { z } from "../../Ai-Adapters/src/index.js";\nexport { z };\n'
      );
      const packages = discoverWorkspacePackages(root);
      const orchestrator = packages.find((p) => p.name === "@hu-ai/orchestrator");
      const actual = actualInternalDependencies(orchestrator, packages);
      assert.ok(actual.has("@hu-ai/ai-adapters"), "Windows 에서 대소문자만 다른 경로도 같은 파일을 가리키므로 탐지돼야 한다");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
);

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

// ── 5차 감사 대응 — AST 전환 회귀 테스트 ────────────────────────────────
// 두 독립 평가관이 프로브로 실증한 6가지 우회(정규식 기반 구현이 전부 놓쳤던 형태)를
// 픽스처로 재현한다. 실제 저장소를 오염시키지 않도록 임시 디렉터리에만 만든다.
function makeAstBypassFixtureWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "pkg-boundary-ast-bypass-fixture-"));
  const pkg = (group, name) => {
    const dir = path.join(root, group, name);
    mkdirSync(path.join(dir, "src"), { recursive: true });
    return dir;
  };
  const leafDir = pkg("packages", "leaf");
  writeFileSync(path.join(leafDir, "package.json"), JSON.stringify({ name: "@hu-ai/leaf" }));
  writeFileSync(path.join(leafDir, "src", "index.ts"), "export function thing(): number {\n  return 1;\n}\n");

  const consumerDir = pkg("packages", "consumer");
  writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ name: "@hu-ai/consumer", dependencies: {} }));

  return { root, leafDir, consumerDir };
}

test("우회 1/6 — 템플릿 리터럴 동적 import 도 탐지한다", () => {
  const { root, consumerDir } = makeAstBypassFixtureWorkspace();
  try {
    writeFileSync(
      path.join(consumerDir, "src", "index.ts"),
      "export async function probe() {\n  const mod = await import(`../../leaf/src/index.js`);\n  return mod;\n}\n"
    );
    const packages = discoverWorkspacePackages(root);
    const consumer = packages.find((p) => p.name === "@hu-ai/consumer");
    const actual = actualInternalDependencies(consumer, packages);
    assert.ok(actual.has("@hu-ai/leaf"), "템플릿 리터럴 동적 import 로 나가는 의존이 탐지돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("우회 2/6 — 변수 경유 동적 import 도 탐지한다", () => {
  const { root, consumerDir } = makeAstBypassFixtureWorkspace();
  try {
    writeFileSync(
      path.join(consumerDir, "src", "index.ts"),
      'export async function probe() {\n  const p = "../../leaf/src/index.js";\n  const mod = await import(p);\n  return mod;\n}\n'
    );
    const packages = discoverWorkspacePackages(root);
    const consumer = packages.find((p) => p.name === "@hu-ai/consumer");
    const actual = actualInternalDependencies(consumer, packages);
    assert.ok(actual.has("@hu-ai/leaf"), "변수 경유 동적 import 로 나가는 의존이 탐지돼야 한다(같은 파일 안 const 상수 전파)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("우회 3/6 — 문자열 연결 동적 import 도 탐지한다", () => {
  const { root, consumerDir } = makeAstBypassFixtureWorkspace();
  try {
    writeFileSync(
      path.join(consumerDir, "src", "index.ts"),
      'export async function probe() {\n  const mod = await import("../../" + "leaf/src/index.js");\n  return mod;\n}\n'
    );
    const packages = discoverWorkspacePackages(root);
    const consumer = packages.find((p) => p.name === "@hu-ai/consumer");
    const actual = actualInternalDependencies(consumer, packages);
    assert.ok(actual.has("@hu-ai/leaf"), "문자열 연결로 만든 동적 import 경로도 탐지돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("우회 4/6 — createRequire(...) 결과를 변수에 담아 호출해도 탐지한다", () => {
  const { root, consumerDir } = makeAstBypassFixtureWorkspace();
  try {
    writeFileSync(
      path.join(consumerDir, "src", "index.ts"),
      'import { createRequire } from "node:module";\n' +
        "export function probe() {\n" +
        "  const req = createRequire(import.meta.url);\n" +
        '  return req("../../leaf/src/index.js");\n' +
        "}\n"
    );
    const packages = discoverWorkspacePackages(root);
    const consumer = packages.find((p) => p.name === "@hu-ai/consumer");
    const actual = actualInternalDependencies(consumer, packages);
    assert.ok(actual.has("@hu-ai/leaf"), "createRequire 변수 경유 require 호출도 탐지돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("우회 5/6 — createRequire(...)(\"@hu-ai/x\") 직접 체인 호출도 탐지한다", () => {
  const { root, consumerDir } = makeAstBypassFixtureWorkspace();
  try {
    writeFileSync(
      path.join(consumerDir, "src", "index.ts"),
      'import { createRequire } from "node:module";\n' +
        "export function probe() {\n" +
        '  return createRequire(import.meta.url)("@hu-ai/leaf");\n' +
        "}\n"
    );
    const packages = discoverWorkspacePackages(root);
    const consumer = packages.find((p) => p.name === "@hu-ai/consumer");
    const actual = actualInternalDependencies(consumer, packages);
    assert.ok(actual.has("@hu-ai/leaf"), "createRequire(...)(...) 직접 체인 호출도 탐지돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("우회 6/6 — 재-export 체인(전이적 의존)을 이름 단위로 추적한다", () => {
  const { root, leafDir, consumerDir } = makeAstBypassFixtureWorkspace();
  const middleDir = path.join(root, "packages", "middle");
  mkdirSync(path.join(middleDir, "src"), { recursive: true });
  try {
    writeFileSync(path.join(middleDir, "package.json"), JSON.stringify({ name: "@hu-ai/middle", dependencies: { "@hu-ai/leaf": "*" } }));
    // middle 은 leaf 를 정직하게 선언하고 실제로 재-export 한다 — middle 자체는 위반이 아니다.
    writeFileSync(path.join(middleDir, "src", "index.ts"), 'export { thing } from "../../leaf/src/index.js";\n');
    // consumer 는 middle 만 import 한다(leaf 를 직접 import 하지 않는다) — 그런데 middle 이
    // re-export 하는 leaf 의 심볼(thing)을 실제로 가져다 쓴다. package.json 에는 middle 만
    // 선언돼 있고 leaf 는 없다 — "missing" 으로 잡혀야 한다.
    writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ name: "@hu-ai/consumer", dependencies: { "@hu-ai/middle": "*" } }));
    writeFileSync(path.join(consumerDir, "src", "index.ts"), 'import { thing } from "../../middle/src/index.js";\nexport { thing };\n');

    const packages = discoverWorkspacePackages(root);
    const consumer = packages.find((p) => p.name === "@hu-ai/consumer");
    const actual = actualInternalDependencies(consumer, packages);
    assert.ok(actual.has("@hu-ai/leaf"), "middle 을 거쳐 재-export 된 leaf 의 심볼을 실제로 쓰면 leaf 가 actual 의존에 잡혀야 한다");

    const results = checkAllPackageBoundaries(root);
    const consumerResult = results.find((r) => r.name === "@hu-ai/consumer");
    assert.equal(consumerResult.ok, false);
    assert.deepEqual(consumerResult.missing, ["@hu-ai/leaf"]);

    const middleResult = results.find((r) => r.name === "@hu-ai/middle");
    assert.equal(middleResult.ok, true, "middle 자신은 leaf 를 정직하게 선언했으니 위반이 아니다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import 후 bare export(`import {x} from 'spec'; export {x};`)로 재-export 해도 원출처까지 추적한다", () => {
  const { root, leafDir, consumerDir } = makeAstBypassFixtureWorkspace();
  const middleDir = path.join(root, "packages", "middle");
  mkdirSync(path.join(middleDir, "src"), { recursive: true });
  try {
    writeFileSync(path.join(middleDir, "package.json"), JSON.stringify({ name: "@hu-ai/middle", dependencies: { "@hu-ai/leaf": "*" } }));
    // "export ... from" 문법이 아니라, 먼저 import 하고 별개의 bare export 문으로
    // 내보내는 형태 — 실무에서 더 흔한 재-export 관용구다.
    writeFileSync(
      path.join(middleDir, "src", "index.ts"),
      'import { thing } from "../../leaf/src/index.js";\nexport { thing };\n'
    );
    writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ name: "@hu-ai/consumer", dependencies: { "@hu-ai/middle": "*" } }));
    writeFileSync(path.join(consumerDir, "src", "index.ts"), 'import { thing } from "../../middle/src/index.js";\nexport { thing };\n');

    const packages = discoverWorkspacePackages(root);
    const consumer = packages.find((p) => p.name === "@hu-ai/consumer");
    const actual = actualInternalDependencies(consumer, packages);
    assert.ok(actual.has("@hu-ai/leaf"), "import 후 bare export 로 만든 재-export 체인도 원출처(leaf)까지 추적돼야 한다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 결함(6차 감사) 대응 — export * as ns from(네임스페이스 재-export) 체인 추적은
// resolveEntry()/buildFileExportTable() 에 이미 구현돼 있었지만(NAMESPACE_ORIGINAL_NAME
// 분기), 이 코드베이스 실제 파일 중에는 이 패턴을 쓰는 곳이 없어서 자동 테스트가
// 없었다(당시 담당자가 "미검증"이라고 정직하게 보고했다). 6차 평가관 C 가 수동으로
// 재현해 잡히는 걸 확인했으니, 이제 픽스처로 고정한다.
test("export * as ns from(네임스페이스 재-export) 체인도 이름 단위로 원출처까지 추적한다", () => {
  const { root, leafDir, consumerDir } = makeAstBypassFixtureWorkspace();
  const middleDir = path.join(root, "packages", "middle");
  mkdirSync(path.join(middleDir, "src"), { recursive: true });
  try {
    writeFileSync(path.join(middleDir, "package.json"), JSON.stringify({ name: "@hu-ai/middle", dependencies: { "@hu-ai/leaf": "*" } }));
    // middle 은 leaf 전체를 "ns" 라는 이름 하나의 네임스페이스로 재-export 한다.
    writeFileSync(path.join(middleDir, "src", "index.ts"), 'export * as ns from "../../leaf/src/index.js";\n');
    // consumer 는 middle 만 import 한다(leaf 를 직접 import 하지 않는다) — 그런데
    // middle 이 재-export 하는 네임스페이스(ns)를 실제로 가져다 쓴다. package.json 에는
    // middle 만 선언돼 있고 leaf 는 없다 — "missing" 으로 잡혀야 한다.
    writeFileSync(path.join(consumerDir, "package.json"), JSON.stringify({ name: "@hu-ai/consumer", dependencies: { "@hu-ai/middle": "*" } }));
    writeFileSync(
      path.join(consumerDir, "src", "index.ts"),
      'import { ns } from "../../middle/src/index.js";\nexport const value = ns.thing();\n'
    );

    const packages = discoverWorkspacePackages(root);
    const consumer = packages.find((p) => p.name === "@hu-ai/consumer");
    const actual = actualInternalDependencies(consumer, packages);
    assert.ok(actual.has("@hu-ai/leaf"), "export * as ns from 을 거친 네임스페이스 재-export 도 원출처(leaf)까지 추적돼야 한다");

    const results = checkAllPackageBoundaries(root);
    const consumerResult = results.find((r) => r.name === "@hu-ai/consumer");
    assert.equal(consumerResult.ok, false);
    assert.deepEqual(consumerResult.missing, ["@hu-ai/leaf"]);

    const middleResult = results.find((r) => r.name === "@hu-ai/middle");
    assert.equal(middleResult.ok, true, "middle 자신은 leaf 를 정직하게 선언했으니 위반이 아니다");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findUnresolvableDynamicSpecifiers 는 정적으로 확정 안 되는 동적 import 를 실패 대상으로 보고한다", () => {
  const { root, consumerDir } = makeAstBypassFixtureWorkspace();
  try {
    // 함수 호출 결과(runtime 에만 결정되는 값)를 그대로 import() 에 넘기는 형태 —
    // 상수 전파로도 확정 불가능해야 한다.
    writeFileSync(
      path.join(consumerDir, "src", "index.ts"),
      "function pickPath(): string {\n  return Math.random() > 0.5 ? \"a\" : \"b\";\n}\n" +
        "export async function probe() {\n  return import(pickPath());\n}\n"
    );
    const unresolvable = findUnresolvableDynamicSpecifiers(root);
    assert.equal(unresolvable.length, 1);
    assert.equal(unresolvable[0].kind, "dynamic-import");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findUnresolvableDynamicSpecifiers 는 확정되는 동적 import/require 는 보고하지 않는다", () => {
  const { root, consumerDir } = makeAstBypassFixtureWorkspace();
  try {
    writeFileSync(
      path.join(consumerDir, "src", "index.ts"),
      'export async function probe() {\n  await import("../../leaf/src/index.js");\n  const p = "../../leaf/src/index.js";\n  await import(p);\n}\n'
    );
    const unresolvable = findUnresolvableDynamicSpecifiers(root);
    assert.deepEqual(unresolvable, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 실제 repo 가드 ──────────────────────────────────────────────────────────
test("실제 repo: 정적으로 확정 안 되는 동적 import()/require() 가 없다", () => {
  const unresolvable = findUnresolvableDynamicSpecifiers();
  assert.deepEqual(
    unresolvable.map((u) => `${u.file}:${u.line}`),
    [],
    "정적으로 확정 안 되는 동적 import/require 가 있다 — 위 목록 참고(경고가 아니라 실패 대상)"
  );
});

// 레이어 규칙은 package.json 선언 여부와 무관하게 강제돼야 한다.
//
// 배경: 이전 구현은 재-export 체인 위반을 declared/actual 대조로만 잡았다. 그래서
// 전이 의존을 package.json 에 그대로 선언해버리면 declared==actual 이 맞아떨어져
// 통과했다(eslint 는 파일 단위라 체인 저 너머를 못 보므로 아무도 못 잡는 경로였다).
test("layerViolations: 선언했든 안 했든 레이어를 어기면 잡는다", () => {
  // bot-service 는 ai-adapters 를 쓰면 안 된다(local-gateway 전용).
  assert.deepEqual(
    layerViolations("@hu-ai/bot-service", new Set(["@hu-ai/ai-adapters", "@hu-ai/contracts"])),
    ["@hu-ai/ai-adapters"]
  );
  // 허용된 조합은 통과.
  assert.deepEqual(
    layerViolations("@hu-ai/bot-service", new Set(["@hu-ai/contracts", "@hu-ai/local-gateway"])),
    []
  );
  // 최하위 레이어는 내부 의존 자체가 없어야 한다.
  assert.deepEqual(layerViolations("@hu-ai/contracts", new Set(["@hu-ai/telegram-ui"])), ["@hu-ai/telegram-ui"]);
  assert.deepEqual(layerViolations("@hu-ai/contracts", new Set()), []);
  // orchestrator 는 contracts/telegram-ui 만.
  assert.deepEqual(
    layerViolations("@hu-ai/orchestrator", new Set(["@hu-ai/supabase-runtime"])),
    ["@hu-ai/supabase-runtime"]
  );
});

test("layerViolations: 표에 없는 패키지는 조용히 통과시키지 않는다", () => {
  // 새 패키지가 생겼는데 표를 안 고치면, 그 패키지가 무엇을 import 하든 통과해버리는
  // 조용한 구멍이 된다. 표를 갱신하라는 신호를 내야 한다.
  const result = layerViolations("@hu-ai/브랜뉴", new Set());
  assert.equal(result.length, 1);
  assert.match(result[0], /레이어 표에 없는 패키지/);
});

test("실제 repo: 레이어 위반 0건", () => {
  for (const result of checkAllPackageBoundaries()) {
    assert.deepEqual(result.layerBreaks, [], `${result.name} 에 레이어 위반이 있다`);
  }
});

// 결함(6차 감사) 대응 — verify-package-boundaries.mjs 주석은 "아래
// verifyLayerTableMatchesEslintConfig 가 eslint.config.js 와의 정합을 검사한다"고
// 적어놨는데 그 함수가 저장소에 없었다(6차 평가관 발견, 있지도 않은 안전망을
// 문서화한 상태). 이제 실제로 구현했으니, ① 실제 repo 에서 통과하는지, ②
// 일부러 어긋나게 만들면 실제로 실패하는지 둘 다 실증한다.
test("실제 repo: ALLOWED_INTERNAL_DEPENDENCIES 가 eslint.config.js 의 no-restricted-imports 와 일치한다", async () => {
  const mismatches = await verifyLayerTableMatchesEslintConfig();
  assert.deepEqual(mismatches, [], "레이어 표와 eslint.config.js 가 어긋난다 — 위 목록 참고");
});

test("verifyLayerTableMatchesEslintConfig: 레이어 표를 일부러 느슨하게 바꾸면 어긋남을 잡는다", async () => {
  // ai-adapters 는 실제로 contracts 만 허용인데, 표에서 그 허용을 빼(전부 금지로
  // 조작) eslint.config.js 와 어긋나게 만든다.
  const loosened = { ...ALLOWED_INTERNAL_DEPENDENCIES, "@hu-ai/ai-adapters": [] };
  const mismatches = await verifyLayerTableMatchesEslintConfig(loosened);
  assert.equal(mismatches.length, 1);
  assert.match(mismatches[0], /@hu-ai\/ai-adapters/);
});

test("verifyLayerTableMatchesEslintConfig: 표에 있는 패키지가 eslint.config.js 블록에 없으면 잡는다", async () => {
  const withGhostPackage = { ...ALLOWED_INTERNAL_DEPENDENCIES, "@hu-ai/브랜뉴": [] };
  const mismatches = await verifyLayerTableMatchesEslintConfig(withGhostPackage);
  assert.ok(
    mismatches.some((m) => m.includes("@hu-ai/브랜뉴") && m.includes("블록이 없다")),
    "eslint.config.js 에 대응 블록이 없는 패키지를 잡아야 한다"
  );
});
