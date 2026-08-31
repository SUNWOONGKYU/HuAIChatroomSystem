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
//
// 2026-08-31 결함(5차 감사) 대응 — 두 독립 평가관이 각각 실증한 문제: 이 스크립트와
// eslint 양쪽 방어선이 전부 "따옴표로 감싼 리터럴 문자열" 형태만 정규식으로 잡았다.
// 다음은 전부 정규식을 뚫었다(프로브로 실증됨):
//   1) 템플릿 리터럴 동적 import: `import(`../../../packages/x/src/index.js`)`
//   2) 변수 경유 동적 import: `const p = "..."; import(p)`
//   3) 문자열 연결: `import("../../packages/" + "x/src/index.js")`
//   4) createRequire(...)("상대경로") / createRequire(...)("@hu-ai/x")
//   5) 재-export 체인: bot-service 가 정당히 의존하는 local-gateway 가 ai-adapters 를
//      re-export 하고, bot-service 는 그 re-export 만 import — 전이적 의존이라 아무도
//      직접 안 봄.
// 정규식 땜질은 다음 변형이 나오면 또 뚫린다는 게 두 평가관의 공통 지적이었다.
// 그래서 이 스크립트를 TypeScript 컴파일러 API(ts.createSourceFile + AST 순회) 기반으로
// 새로 짰다. 새 npm 의존성은 추가하지 않는다 — 이 저장소는 이미 typescript 를
// devDependency 로 갖고 있다(tsc 로 typecheck 하는 데 쓴다).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

// ── AST 인프라 ────────────────────────────────────────────────────────────
// 소스파일·상수 전파·export 테이블은 같은 파일이 여러 경로(직접 import, 재-export
// 체인의 중간 홉)에서 반복 조회되므로 실행 1회당 캐시(ctx)를 공유한다. 파일 64개
// 규모라 캐시 없이도 느리진 않겠지만, 재-export 체인 탐색이 사이클을 가질 수 있어
// (A가 B를 재-export하고 B가 다시 A를 재-export하는 등) 캐시 + visiting 가드가
// 정확성에도 필요하다.
function makeContext() {
  return {
    sourceFileCache: new Map(), // file -> ts.SourceFile
    fileEdgesCache: new Map(), // file -> { edges, dynamicSpecifiers, unresolvedDynamic }
    exportTableCache: new Map(), // file -> { namedExports, starReexportSpecifiers }
    originCache: new Map(), // "file\0name" -> Set<packageName>
    reachableCache: new Map() // "file\0hop" -> Set<packageName>
  };
}

function getSourceFile(file, ctx) {
  let sf = ctx.sourceFileCache.get(file);
  if (sf) return sf;
  const text = readFileSync(file, "utf8");
  sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  ctx.sourceFileCache.set(file, sf);
  return sf;
}

function packageOf(file, allPackages) {
  const owner = allPackages.find((p) => file === p.srcDir || file.startsWith(p.srcDir + path.sep));
  return owner ? owner.name : null;
}

// specifier 를 실제 .ts 파일로 resolve 한다. 상대경로("./x.js", "../y.js")와
// bare "@hu-ai/x"(+옵션 서브패스) 를 지원한다. node: 코어 모듈·외부 npm 패키지("playwright"
// 등)는 워크스페이스 밖이라 null 을 반환한다 — 재-export 체인 추적은 거기서 끊긴다(맞는
// 동작: 외부 패키지를 통해 내부 패키지로 돌아올 방법은 없다).
function resolveModuleFile(fromFile, specifier, allPackages) {
  if (specifier.startsWith(".")) {
    return resolveFileCandidates(path.resolve(path.dirname(fromFile), specifier));
  }
  const bareMatch = /^(@hu-ai\/[^/]+)(\/.*)?$/.exec(specifier);
  if (!bareMatch) return null; // node:x, 외부 npm 패키지 등 — 워크스페이스 밖
  const owner = allPackages.find((p) => p.name === bareMatch[1]);
  if (!owner) return null;
  const base = bareMatch[2] ? path.join(owner.dir, bareMatch[2]) : path.join(owner.srcDir, "index");
  return resolveFileCandidates(base);
}

function resolveFileCandidates(base) {
  const stripped = base.endsWith(".js") ? base.slice(0, -3) : base;
  const candidates = [`${stripped}.ts`, path.join(base, "index.ts"), base];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// ── 문자열 상수 전파 ──────────────────────────────────────────────────────
// 정적으로 확정 안 되는 경우(변수·문자열 연결)의 처리 방침: "같은 파일 안에서 선언된
// const 리터럴은 따라간다" — 3차 우회 표의 "변수 경유"·"문자열 연결" 두 케이스가
// 바로 이 정책으로 해결된다. 파일 단위 스코프만 본다(실제 렉시컬 스코프 분석은 안
// 한다) — 같은 이름의 const 가 서로 다른 스코프에 중복 선언되면 마지막 선언이
// 이긴다. 이 저장소 64개 소스 파일 중 그런 이름 충돌 사례는 없다(실측 확인). 완벽한
// 스코프 분석보다 "간단한 상수 전파 + 그래도 안 되면 실패" 쪽이 이번 요구사항의
// 명시 지침이다.
function collectConstStringDecls(sourceFile) {
  const map = new Map();
  function visit(node) {
    if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          map.set(decl.name.text, decl.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
  return map;
}

// createRequire(...) 의 결과를 변수에 담아두고 나중에 그 변수로 호출하는 형태
// (`const req = createRequire(import.meta.url); req("spec")`) 가 실무에서 가장 흔한
// createRequire 사용 패턴이다 — `createRequire(...)("spec")` 직접 체인 호출보다도 흔하다.
// 이걸 놓치면 4번째 우회(변수 경유 createRequire)를 못 잡는다. 변수 선언 형태(const/let/var)는
// 안 가리고 전부 추적한다 — require 대체용 변수를 재할당하는 코드는 상정하지 않는다.
function collectCreateRequireVarNames(sourceFile) {
  const names = new Set();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "createRequire") {
        names.add(node.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
  return names;
}

function evalStringExpression(node, constMap, visiting) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text; // StringLiteral + NoSubstitutionTemplateLiteral
  if (ts.isParenthesizedExpression(node)) return evalStringExpression(node.expression, constMap, visiting);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return evalStringExpression(node.expression, constMap, visiting);
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = evalStringExpression(span.expression, constMap, visiting);
      if (value === undefined) return undefined;
      out += value + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evalStringExpression(node.left, constMap, visiting);
    const right = evalStringExpression(node.right, constMap, visiting);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isIdentifier(node)) {
    const name = node.text;
    if (visiting.has(name)) return undefined; // 자기참조 순환 가드
    const init = constMap.get(name);
    if (init === undefined) return undefined;
    visiting.add(name);
    const value = evalStringExpression(init, constMap, visiting);
    visiting.delete(name);
    return value;
  }
  return undefined;
}

// ── 파일 단위 import/동적 import/require 스캔 ────────────────────────────
// import type 정책: 별도 취급하지 않는다 — 전체 선언(ImportDeclaration)이든 개별
// specifier(`import { type X }`)든 똑같이 일반 import 로 센다. 근거: (1) eslint 의
// no-restricted-imports 가 기본적으로 importKind 를 구분하지 않고 이미 똑같이 막고
// 있었다(이 스크립트만 예외를 두면 두 방어선이 어긋난다). (2) 타입 전용이라 런타임
// 비용은 0이어도, "이 패키지가 저 패키지의 타입을 안다"는 것 자체가 이미 아키텍처
// 결합이다 — 레이어를 나눈 이유(계층 간 지식 차단)를 타입 레벨에서는 봐줄 이유가 없다.
function collectFileEdges(file, ctx) {
  const cached = ctx.fileEdgesCache.get(file);
  if (cached) return cached;

  const sourceFile = getSourceFile(file, ctx);
  const constMap = collectConstStringDecls(sourceFile);
  const createRequireVarNames = collectCreateRequireVarNames(sourceFile);
  const edges = []; // { specifier, importedNames: string[] | "*" }
  const dynamicSpecifiers = []; // 정적으로 확정된 동적 import()/require() 인자 문자열
  const unresolvedDynamic = []; // 정적으로 확정 안 되는 동적 import()/require() — 실패 대상

  function lineOf(node) {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }
  function snippetOf(node) {
    return node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 160);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause) {
        edges.push({ specifier, importedNames: [] }); // 부작용-전용: import "spec";
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        edges.push({ specifier, importedNames: "*" }); // import * as ns from "spec"
      } else {
        const names = [];
        if (clause.name) names.push("default");
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
        }
        edges.push({ specifier, importedNames: names });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        edges.push({ specifier, importedNames: node.exportClause.elements.map((el) => (el.propertyName ?? el.name).text) });
      } else {
        edges.push({ specifier, importedNames: "*" }); // export * from / export * as ns from
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const value = evalStringExpression(node.moduleReference.expression, constMap, new Set());
      if (value !== undefined) dynamicSpecifiers.push(value);
      else unresolvedDynamic.push({ line: lineOf(node), snippet: snippetOf(node), kind: "import-equals-require" });
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      // 순수 ESM(type: module) 코드베이스라 "require" 라는 전역이 원래는 없다 — 여기
      // 등장한다면 십중팔구 createRequire 로 만든 변수다. 이름이 정확히 "require" 인
      // 경우와, createRequire(...) 로 초기화된 변수(위 collectCreateRequireVarNames)를
      // 통해 호출되는 경우 둘 다 잡는다.
      const isRequireCall =
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" || createRequireVarNames.has(node.expression.text));
      // createRequire(import.meta.url)("spec") 직접 체인 호출 — 변수에 담기지 않고
      // 바로 호출되는 형태도 잡는다.
      const isChainedCreateRequire =
        ts.isCallExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "createRequire";
      if (isDynamicImport || isRequireCall || isChainedCreateRequire) {
        const argNode = node.arguments[0];
        const value = evalStringExpression(argNode, constMap, new Set());
        if (value !== undefined) dynamicSpecifiers.push(value);
        else {
          unresolvedDynamic.push({
            line: lineOf(node),
            snippet: snippetOf(node),
            kind: isDynamicImport ? "dynamic-import" : "require"
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);

  const result = { edges, dynamicSpecifiers, unresolvedDynamic };
  ctx.fileEdgesCache.set(file, result);
  return result;
}

// ── export 테이블(재-export 체인 추적용) ─────────────────────────────────
// 각 파일이 내놓는 이름(namedExports)이 (a) 이 파일 자체에 선언됐는지, 아니면
// (b) 다른 모듈에서 들여온 것을 그대로/이름 바꿔 재-export 하는지를 기록한다.
// (b) 에는 두 문법이 있다 — `export { X } from "spec"`(export 문 자체가 출처를 명시)
// 와, `import { X } from "spec"; export { X };`(import 로 먼저 들여온 뒤 별개의
// bare export 문으로 내보냄) — 후자를 놓치면 "import 후 재-export"라는 아주 흔한
// 패턴이 재-export 체인 탐지에서 빠진다. 그래서 먼저 이 파일의 import 바인딩
// 전체(localImportBindings: 로컬 이름 -> {specifier, originalName})를 만들고,
// bare export 를 처리할 때 그 바인딩을 찾아 원출처로 치환한다.
const NAMESPACE_ORIGINAL_NAME = Symbol("namespace-reexport");

function hasModifier(node, kind) {
  return (node.modifiers ?? []).some((m) => m.kind === kind);
}

function collectBindingNames(nameNode) {
  if (ts.isIdentifier(nameNode)) return [nameNode.text];
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    const out = [];
    for (const el of nameNode.elements) {
      if (!ts.isOmittedExpression(el)) out.push(...collectBindingNames(el.name));
    }
    return out;
  }
  return [];
}

function buildFileExportTable(file, ctx) {
  const cached = ctx.exportTableCache.get(file);
  if (cached) return cached;

  const sourceFile = getSourceFile(file, ctx);
  const namedExports = new Map(); // exportedName -> { specifier: string|null, originalName: string|symbol }
  const starReexportSpecifiers = []; // export * from "spec" (default 는 제외 — 아래 origin 해석에서 처리)
  const localImportBindings = new Map(); // localName -> { specifier, originalName }

  function addLocal(name) {
    if (!namedExports.has(name)) namedExports.set(name, { specifier: null, originalName: name });
  }

  // 1차 순회: import 바인딩만 먼저 전부 모은다(뒤에 나오는 bare export 가 앞에서
  // import 한 이름을 참조할 수 있으니, 순서 무관하게 처리하려고 두 패스로 나눈다).
  function collectImports(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause) {
        if (clause.name) localImportBindings.set(clause.name.text, { specifier, originalName: "default" });
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            localImportBindings.set(clause.namedBindings.name.text, { specifier, originalName: NAMESPACE_ORIGINAL_NAME });
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              localImportBindings.set(el.name.text, { specifier, originalName: (el.propertyName ?? el.name).text });
            }
          }
        }
      }
    }
    ts.forEachChild(node, collectImports);
  }
  ts.forEachChild(sourceFile, collectImports);

  // 2차 순회: export 를 처리한다.
  function visit(node) {
    if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : null;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          const exportedName = el.name.text;
          if (specifier !== null) {
            // export { X } from "spec" / export { X as Y } from "spec"
            const originalName = (el.propertyName ?? el.name).text;
            namedExports.set(exportedName, { specifier, originalName });
          } else {
            // bare export { X } / export { X as Y } — 로컬 바인딩을 원출처까지 따라간다.
            const localName = (el.propertyName ?? el.name).text;
            const importBinding = localImportBindings.get(localName);
            namedExports.set(exportedName, importBinding ?? { specifier: null, originalName: localName });
          }
        }
      } else if (node.exportClause && ts.isNamespaceExport(node.exportClause) && specifier !== null) {
        // export * as ns from "spec" — ns 를 통해 spec 의 전체 네임스페이스에 접근 가능.
        namedExports.set(node.exportClause.name.text, { specifier, originalName: NAMESPACE_ORIGINAL_NAME });
      } else if (!node.exportClause && specifier !== null) {
        // export * from "spec" — named export 전부(단, default 는 제외)를 그대로 전달.
        starReexportSpecifiers.push(specifier);
      }
      return; // export 문 내부는 더 내려갈 게 없다.
    }
    if (ts.isExportAssignment(node)) {
      if (!node.isExportEquals) addLocal("default"); // export default <expr>;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      hasModifier(node, ts.SyntaxKind.ExportKeyword)
    ) {
      if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) addLocal("default");
      else if (node.name && ts.isIdentifier(node.name)) addLocal(node.name.text);
    } else if (ts.isVariableStatement(node) && hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      for (const decl of node.declarationList.declarations) collectBindingNames(decl.name).forEach(addLocal);
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);

  const result = { namedExports, starReexportSpecifiers };
  ctx.exportTableCache.set(file, result);
  return result;
}

// ── 재-export 체인을 따라 이름의 진짜 출처 패키지를 찾는다 ──────────────
// "A가 B를 통해 C에 도달"이 항상 위반은 아니라는 판단 기준: B가 import 해서
// package.json 에 정직하게 선언한 의존은(레이어 규칙상 허용이든 아니든) 이미 그
// 자체로 boundary 검사 대상이다. 여기서 추가로 잡아야 하는 건 "B가 C의 심볼을
// re-export 하고 A가 '그 심볼 이름'을 실제로 가져다 쓰는 경우"뿐이다 — 그래서
// 이름(name) 단위로 추적한다. A가 B에서 아무 이름이나 가져다 써도 되는 게 아니라,
// A가 실제로 import 한 그 이름이 B 안에서 로컬로 선언된 게 아니라 C 에서 재-export
// 된 것으로 확인될 때만 C 를 A 의 실제 의존 집합에 넣는다.
//
// export * from "spec" 는 spec 의 default export 는 전달하지 않는다(ES 모듈 스펙).
// isStarHop 이 true 인 재귀 호출(= export * 를 타고 들어온 경우)에서는 "default"
// 이름을 원출처 후보에서 제외해 이 규칙을 반영한다. export * as ns from "spec" 는
// 네임스페이스 객체 자체이므로 ns.default 접근이 가능하다 — 그래서 NAMESPACE_ORIGINAL_NAME
// 경로는 이 규칙의 영향을 받지 않는다(별도 분기).
function resolveExportOriginPackages(file, name, allPackages, ctx, visiting) {
  if (name === "default") {
    // default 는 star 전파 대상이 아니므로 아래 일반 로직과 분리해 명시적으로만 찾는다.
    const key = `${file} default`;
    const cachedResult = ctx.originCache.get(key);
    if (cachedResult) return cachedResult;
    if (visiting.has(key)) return new Set();
    visiting.add(key);
    const table = buildFileExportTable(file, ctx);
    const entry = table.namedExports.get("default");
    const result = resolveEntry(entry, file, allPackages, ctx, visiting);
    visiting.delete(key);
    ctx.originCache.set(key, result);
    return result;
  }

  const key = `${file} ${name}`;
  const cached = ctx.originCache.get(key);
  if (cached) return cached;
  if (visiting.has(key)) return new Set();
  visiting.add(key);

  const table = buildFileExportTable(file, ctx);
  let result;
  const entry = table.namedExports.get(name);
  if (entry) {
    result = resolveEntry(entry, file, allPackages, ctx, visiting);
  } else {
    result = new Set();
    for (const specifier of table.starReexportSpecifiers) {
      const targetFile = resolveModuleFile(file, specifier, allPackages);
      if (!targetFile) continue;
      for (const p of resolveExportOriginPackages(targetFile, name, allPackages, ctx, visiting)) result.add(p);
    }
  }
  visiting.delete(key);
  ctx.originCache.set(key, result);
  return result;
}

function resolveEntry(entry, file, allPackages, ctx, visiting) {
  if (!entry) return new Set();
  if (entry.specifier === null) {
    // 이 파일 자체에 선언된 이름(진짜 로컬 소유), 또는 원출처를 못 찾은 bare export.
    const pkg = packageOf(file, allPackages);
    return pkg ? new Set([pkg]) : new Set();
  }
  const targetFile = resolveModuleFile(file, entry.specifier, allPackages);
  if (!targetFile) return new Set(); // 외부 npm 패키지 등 워크스페이스 밖 — 추적 종료
  if (entry.originalName === NAMESPACE_ORIGINAL_NAME) {
    return allReachableOriginPackages(targetFile, allPackages, ctx, visiting, false);
  }
  const nested = resolveExportOriginPackages(targetFile, entry.originalName, allPackages, ctx, visiting);
  if (nested.size > 0) return nested;
  // targetFile 안에서 그 이름을 못 찾았다(예: .d.ts 전용 타입, 혹은 분석 한계) —
  // 그래도 "이 파일이 targetFile 을 거쳐 뭔가를 재-export 한다"는 사실 자체는
  // 확실하므로, 안전한 하한선으로 targetFile 이 속한 패키지를 origin 으로 본다.
  const pkg = packageOf(targetFile, allPackages);
  return pkg ? new Set([pkg]) : new Set();
}

// 네임스페이스 import(`import * as ns from "spec"`)로 들어오는 파일 하나가 실제로
// 노출하는 모든 이름의 원출처 패키지 합집합. isStarHop=true 로 재귀하면 그 홉부터는
// "export * from" 을 타고 온 것이므로 default 를 제외한다(위 주석 참고).
function allReachableOriginPackages(file, allPackages, ctx, visiting, isStarHop) {
  const key = `${file} * ${isStarHop ? 1 : 0}`;
  const cached = ctx.reachableCache.get(key);
  if (cached) return cached;
  if (visiting.has(key)) return new Set();
  visiting.add(key);

  const table = buildFileExportTable(file, ctx);
  const result = new Set();
  for (const name of table.namedExports.keys()) {
    if (isStarHop && name === "default") continue;
    for (const p of resolveExportOriginPackages(file, name, allPackages, ctx, visiting)) result.add(p);
  }
  for (const specifier of table.starReexportSpecifiers) {
    const targetFile = resolveModuleFile(file, specifier, allPackages);
    if (!targetFile) continue;
    for (const p of allReachableOriginPackages(targetFile, allPackages, ctx, visiting, true)) result.add(p);
  }

  visiting.delete(key);
  ctx.reachableCache.set(key, result);
  return result;
}

// packageDir 의 src/ 아래 모든 .ts 파일에서 다른 워크스페이스 패키지로 나가는 import
// (정적 import/export ... from, 동적 import(), require()/createRequire(...)(...),
// 상대경로, bare "@hu-ai/x" 모두 포함)를 찾아, 실제로 가리키는 패키지 이름 집합을 낸다.
// 자기 자신을 가리키는 경로는 제외한다. 재-export 체인을 통해 "이름 단위로" 도달하는
// 패키지도 포함한다(위 resolveExportOriginPackages 참고) — 이게 이번 5차 감사 대응의
// 핵심 추가분이다.
export function actualInternalDependencies(target, allPackages, ctx = makeContext()) {
  const names = new Set();
  for (const file of listTsFiles(target.srcDir)) {
    const { edges, dynamicSpecifiers } = collectFileEdges(file, ctx);

    // 직접 의존(specifier 하나가 어느 패키지를 가리키는지) — 정적 import/export 의
    // moduleSpecifier 뿐 아니라, 동적 import()/require() 가 상수 전파로 확정한
    // 문자열(dynamicSpecifiers)도 똑같이 취급한다. 동적 import 로 들여온 모듈의
    // 구조 분해 바인딩(`const {x} = await import(spec)`)은 ImportDeclaration 이 아니라
    // 일반 VariableDeclaration 이라 이름을 안전하게 추적할 근거가 약해, 재-export 체인
    // 추적(아래)은 정적 import/export 문(edges)에만 적용한다 — 직접 의존은 여기서
    // 이미 정확히 잡히므로 동적 import 로 끌어오는 패키지 자체를 놓치는 일은 없다.
    for (const specifier of [...edges.map((e) => e.specifier), ...dynamicSpecifiers]) {
      addDirectOwner(specifier, file, target, allPackages, names);
    }

    for (const edge of edges) {
      const targetFile = resolveModuleFile(file, edge.specifier, allPackages);
      if (!targetFile) continue;
      if (edge.importedNames === "*") {
        for (const p of allReachableOriginPackages(targetFile, allPackages, ctx, new Set(), false)) {
          if (p !== target.name) names.add(p);
        }
        continue;
      }
      for (const name of edge.importedNames) {
        for (const p of resolveExportOriginPackages(targetFile, name, allPackages, ctx, new Set())) {
          if (p !== target.name) names.add(p);
        }
      }
    }
  }
  return names;
}

function addDirectOwner(specifier, file, target, allPackages, names) {
  if (specifier.startsWith(".")) {
    // 실제 파일시스템 경로로 resolve 해서 그 경로가 어느 워크스페이스 패키지 폴더
    // 아래인지로 판정한다 — "../" 개수(상대경로 깊이)와 무관하게 항상 맞는다.
    const resolvedBase = path.resolve(path.dirname(file), specifier);
    const owner = allPackages.find(
      (candidate) =>
        candidate.name !== target.name &&
        (resolvedBase === candidate.dir || resolvedBase.startsWith(candidate.dir + path.sep))
    );
    if (owner) names.add(owner.name);
    return;
  }
  // bare import — "@hu-ai/<pkg>" 또는 "@hu-ai/<pkg>/<subpath>" 형태만 내부 워크스페이스
  // 패키지로 본다(node:x, 외부 npm 패키지 등은 대상 아님).
  const bareMatch = /^(@hu-ai\/[^/]+)/.exec(specifier);
  if (bareMatch) {
    const owner = allPackages.find((c) => c.name === bareMatch[1] && c.name !== target.name);
    if (owner) names.add(owner.name);
  }
}

export function declaredDependencies(packageJsonPath) {
  const json = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return new Set(Object.keys(json.dependencies ?? {}).filter((name) => name.startsWith("@hu-ai/")));
}

// 레이어 규칙 — eslint.config.js 의 6개 no-restricted-imports 블록과 같은 내용을
// 여기에도 둔다.
//
// 왜 중복해서 두는가: 이전 구현은 재-export 체인 위반을 "package.json 에 선언 안 한 걸
// 실제로 쓴다"는 declared/actual 대조에만 기대고 있었다. 그러면 누군가 그 전이 의존을
// package.json 에 그대로(부정직하게) 선언해버리면 declared==actual 이 맞아떨어져
// 통과한다 — eslint 는 파일 단위라 재-export 체인 저 너머를 못 보므로 그 경로는
// 아무도 못 잡는다. 레이어 규칙을 여기 두면 선언 여부와 무관하게 항상 실패한다.
//
// eslint 쪽과 어긋나면 두 방어선이 서로 다른 말을 하게 되므로, 아래
// verifyLayerTableMatchesEslintConfig 가 eslint.config.js 와의 정합을 검사한다.
const ALLOWED_INTERNAL_DEPENDENCIES = {
  "@hu-ai/contracts": [],
  "@hu-ai/workflow": [],
  "@hu-ai/telegram-ui": [],
  "@hu-ai/ai-adapters": ["@hu-ai/contracts"],
  "@hu-ai/orchestrator": ["@hu-ai/contracts", "@hu-ai/telegram-ui"],
  "@hu-ai/supabase-runtime": ["@hu-ai/contracts", "@hu-ai/orchestrator", "@hu-ai/telegram-ui", "@hu-ai/workflow"],
  "@hu-ai/bot-service": [
    "@hu-ai/contracts", "@hu-ai/local-gateway", "@hu-ai/orchestrator",
    "@hu-ai/supabase-runtime", "@hu-ai/telegram-ui", "@hu-ai/workflow"
  ],
  "@hu-ai/local-gateway": ["@hu-ai/ai-adapters", "@hu-ai/contracts", "@hu-ai/supabase-runtime"]
};

export function layerViolations(packageName, actualDependencies, layerTable = ALLOWED_INTERNAL_DEPENDENCIES) {
  const allowed = layerTable[packageName];
  // 레이어 표에 없는 패키지가 생기면 조용히 통과시키지 않는다 — 표를 갱신하라는 신호다.
  if (!allowed) return [`레이어 표에 없는 패키지다 — ALLOWED_INTERNAL_DEPENDENCIES 를 갱신하라`];
  return [...actualDependencies].filter((name) => !allowed.includes(name)).sort();
}

// layerTable 을 인자로 받는 이유: 레이어 표는 이 저장소의 실제 패키지 이름에 묶여
// 있어서, 임시 디렉터리에 가짜 패키지(leaf/middle/top 등)를 만들어 돌리는 픽스처
// 테스트에는 적용할 수 없다. 실제 저장소를 볼 때만 레이어를 강제하고, 다른 루트를
// 검사할 때는 호출자가 표를 직접 넘기지 않는 한 declared/actual 대조만 한다.
export function checkAllPackageBoundaries(
  repoRoot = REPO_ROOT,
  layerTable = repoRoot === REPO_ROOT ? ALLOWED_INTERNAL_DEPENDENCIES : null
) {
  const packages = discoverWorkspacePackages(repoRoot);
  const ctx = makeContext();
  return packages.map((target) => {
    const actual = actualInternalDependencies(target, packages, ctx);
    const declared = declaredDependencies(target.packageJsonPath);
    const missing = [...actual].filter((name) => !declared.has(name)).sort();
    const extra = [...declared].filter((name) => !actual.has(name)).sort();
    // 선언 여부와 무관하게 레이어를 어기면 실패한다.
    const layerBreaks = layerTable ? layerViolations(target.name, actual, layerTable) : [];
    return {
      name: target.name,
      actual: [...actual].sort(),
      declared: [...declared].sort(),
      missing,
      extra,
      layerBreaks,
      ok: missing.length === 0 && extra.length === 0 && layerBreaks.length === 0
    };
  });
}

// 정적으로 확정 안 되는 동적 import()/require() 인자가 있으면 "경고"가 아니라
// "실패"로 처리한다(요구사항 명시) — 이런 형태는 이 코드베이스에 존재할 이유가
// 없다는 판단이다: 이 저장소는 번들러 없이 dist/*.js 를 node 로 직접 실행하는
// 소규모 워크스페이스라, 모듈 경로가 런타임 조건에 따라 달라져야 할 합당한 이유가
// 없다(플러그인 로더·동적 로케일 스위칭 같은 패턴이 없다). 실제로 정적으로 확정
// 불가능한 동적 import 가 이 코드베이스에 존재하는지 이 함수로 매번 실측한다.
export function findUnresolvableDynamicSpecifiers(repoRoot = REPO_ROOT) {
  const packages = discoverWorkspacePackages(repoRoot);
  const ctx = makeContext();
  const found = [];
  for (const pkg of packages) {
    for (const file of listTsFiles(pkg.srcDir)) {
      const { unresolvedDynamic } = collectFileEdges(file, ctx);
      for (const item of unresolvedDynamic) found.push({ file, ...item });
    }
  }
  return found;
}

// 단독 실행: `node scripts/verify-package-boundaries.mjs` — 다른 verify-*.mjs 스크립트와
// 같은 관례(사람이 읽는 진단 출력 + 실패 시 exit 1).
// `file://${argv[1]}` 문자열 비교는 Windows 에서 argv[1] 이 백슬래시 경로라 항상
// 어긋난다 — fileURLToPath 로 둘 다 실제 경로로 바꿔서 비교한다.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  let failed = false;

  const unresolvable = findUnresolvableDynamicSpecifiers();
  for (const item of unresolvable) {
    failed = true;
    console.error(`FAIL 정적으로 확정 안 되는 동적 ${item.kind} — ${item.file}:${item.line}`);
    console.error(`  ${item.snippet}`);
  }

  const results = checkAllPackageBoundaries();
  for (const result of results) {
    if (result.ok) {
      console.log(`OK   ${result.name}  (dependencies: ${result.declared.join(", ") || "없음"})`);
      continue;
    }
    failed = true;
    console.error(`FAIL ${result.name}`);
    if (result.missing.length > 0) console.error(`  선언 누락(실제 import 하는데 package.json dependencies 에 없음): ${result.missing.join(", ")}`);
    if (result.layerBreaks.length > 0) console.error(`  레이어 위반(선언 여부와 무관하게 금지된 의존): ${result.layerBreaks.join(", ")}`);
    if (result.extra.length > 0) console.error(`  죽은 선언(package.json dependencies 에는 있는데 실제로 import 안 함): ${result.extra.join(", ")}`);
  }
  if (failed) process.exit(1);
  console.log("Package boundary verification passed.");
}
