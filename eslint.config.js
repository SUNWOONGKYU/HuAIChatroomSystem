// ESLint flat config (ESLint 9+).
//
// 범위는 최소로 잡는다 — 27,000줄 넘는 기존 코드에 처음 도입하는 lint라
// 룰을 많이 켜면 수천 건이 쏟아져서 신호가 묻힌다. 그래서 사람 눈으로
// 놓치기 쉬운 비동기 버그(floating promise, misused promise, 빈 async)와
// 안 쓰는 변수만 타입 정보를 활용해 잡는다. 포맷팅·스타일 룰은 켜지 않는다.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const typedLanguageOptions = {
  parser: tsParser,
  parserOptions: {
    // tsconfig 파일명이 표준(tsconfig.json)이 아니라 projectService 자동
    // 탐색이 실패한다 — 이 저장소가 실제 쓰는 tsconfig.check.json 을 명시한다.
    project: ["./tsconfig.check.json"],
    tsconfigRootDir: import.meta.dirname
  }
};
const typedPlugins = { "@typescript-eslint": tsPlugin };

// 깊이 무관 패턴을 만드는 헬퍼: 패키지명 목록을 받아 "path 어디서든 그 패키지의
// src/ 로 들어가는 import" 를 잡는 no-restricted-imports 패턴 배열을 만든다.
// `regex` 옵션(group 리터럴 glob 대신)을 쓰기 때문에 "../" 개수(=하위 폴더 깊이)와
// 무관하게, 그리고 "packages/" 프리픽스 유무와도 무관하게 항상 잡힌다.
function forbiddenPackagePatterns(packageNames, contextLabel) {
  return packageNames.map((name) => ({
    regex: `(^|/)${name}(/|$)`,
    message: `${contextLabel} 는 ${name} 을 import 할 수 없다(계층 위반).`
  }));
}

// 결함(4차 감사) 대응 — 위 정규식은 원래 `${name}/(src/|$)` 였다: 이름 뒤에 반드시
// "/" 가 붙어야 매치되는데, bare import("@hu-ai/ai-adapters", 서브패스 없음)는 이름
// 뒤에 "/" 가 안 붙으므로 조용히 통과했다(4차 평가관이 직접 프로브로 실증). `${name}(/|$)`
// 로 바꿔 "이름 뒤에 / 가 오거나, 이름으로 문자열이 끝나거나" 둘 다 잡는다 — 상대경로
// "../../ai-adapters/src/..." 와 bare "@hu-ai/ai-adapters"(서브패스 있든 없든) 모두 커버한다.
//
// no-restricted-imports(ESLint 코어, node_modules/eslint/lib/rules/no-restricted-imports.js
// 확인함)는 ImportDeclaration 리스너만 등록하고 ImportExpression(동적 import(...))은 아예
// 안 본다 — 4차 평가관이 `await import("../../../ai-adapters/src/index.js")` 로 실증했다.
// no-restricted-syntax + esquery 셀렉터(ImportExpression > Literal)로 별도 방어선을 편다.
//
// esquery 의 정규식 리터럴 문법은 "/" 를 델리미터로 쓰기 때문에, 델리미터 바깥에서
// "/" 를 리터럴로 쓰면(이스케이프해도) 파싱 에러가 난다(node_modules/esquery 로 직접
// 테스트해 확인함) — 그래서 `(^|/)` 대신 문자클래스로 감싼 `(^|[/])` 형태를 쓴다
// (문자클래스 안의 "/" 는 델리미터로 해석되지 않는다).
function forbiddenDynamicImportSelectors(packageNames, contextLabel) {
  return packageNames.map((name) => ({
    selector: `ImportExpression > Literal[value=/(^|[/])${name}([/]|$)/]`,
    message: `${contextLabel} 는 ${name} 을 동적 import 할 수 없다(계층 위반).`
  }));
}

// 결함(5차 감사) 대응 — 위 forbiddenDynamicImportSelectors 는 "리터럴 문자열 인자"만
// 본다(esquery 셀렉터가 AST 노드 타입/값으로 매치하는 구조라 그 이상은 표현이 안 된다).
// 두 평가관이 독립적으로 실증한 우회 4종이 전부 이 한계를 뚫는다:
//   - 템플릿 리터럴: import(`../../ai-adapters/src/index.js`)
//   - 변수 경유: const p = "..."; import(p)
//   - 문자열 연결: import("../../" + "ai-adapters/src/index.js")
//   - createRequire(...)("...") / const req = createRequire(...); req("...")
// scripts/verify-package-boundaries.mjs(AST + 상수 전파)는 이 네 형태가 실제로 어느
// 패키지를 가리키는지까지 정확히 추적하지만, eslint 규칙은 셀렉터 매칭 수준이라 같은
// 정밀도를 esquery만으로 낼 수 없다. 대신 더 단순하고 강한 정책을 쓴다 — "동적
// import()/require()/createRequire(...)(...) 의 인자는 리터럴 문자열이어야 한다.
// 그 외 형태는 전부 금지"(대상 패키지가 허용이든 금지든 상관없이). 이 저장소는
// 번들러 없는 소규모 워크스페이스라 모듈 경로가 런타임에 동적으로 결정돼야 할 합당한
// 이유가 없다(boundary 스크립트의 findUnresolvableDynamicSpecifiers 와 같은 판단
// 근거) — 그러니 "리터럴이 아니면 무조건 금지"가 과잉이 아니라 이 코드베이스에 맞는
// 정책이다. eslint 코어 룰로는 이 판정이 안 되므로(no-restricted-syntax 는 매치만
// 하지 "인자가 리터럴이 아니면"이라는 부정 조건에 값비교 없이 도달 못 함) 로컬
// 커스텀 룰(아래 localRulesPlugin)로 만든다 — 새 npm 의존성은 추가하지 않는다.
function isStringLiteralNode(node) {
  return !!node && node.type === "Literal" && typeof node.value === "string";
}

// no-restricted-imports/forbiddenDynamicImportSelectors 는 ImportDeclaration 과
// ImportExpression 만 본다 — require(...)/createRequire(...)(...) 로 "리터럴 문자열"을
// 넘겨 금지 패키지를 불러오는 경로는 기존 두 방어선 어디에도 안 걸린다(실측 확인 —
// probe4/probe5 가 리터럴 인자를 쓰면서 기존 설정을 그대로 통과했다). 그래서 이
// 커스텀 룰이 두 가지를 함께 본다: ① 인자가 리터럴이 아니면 항상 금지(대상이
// 허용이든 금지든 무관 — 위 주석의 "리터럴이 아니면 무조건 금지" 정책), ② 인자가
// 리터럴인데 이 레이어에서 금지된 패키지를 가리키면 금지(레이어 위반) — no-restricted-imports
// 의 patterns 옵션과 완전히 같은 {regex, message} 형태를 그대로 받아써서 설정 중복을
// 없앤다(호출부에서 forbiddenPackagePatterns(...) 결과를 그대로 넘긴다).
const noNonLiteralDynamicModuleLoadRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "동적 import()/require()/createRequire(...)(...) 의 인자는 리터럴 문자열이어야 하고, " +
        "그 리터럴이 이 레이어에서 금지된 패키지를 가리키면 안 된다."
    },
    schema: [
      {
        type: "array",
        items: {
          type: "object",
          properties: { regex: { type: "string" }, message: { type: "string" } },
          required: ["regex", "message"]
        }
      }
    ]
  },
  create(context) {
    const forbidden = (context.options[0] ?? []).map((f) => ({ re: new RegExp(f.regex), message: f.message }));
    // createRequire(...) 결과를 담은 변수를 추적해서 `const req = createRequire(x); req("...")`
    // 형태(가장 흔한 createRequire 사용 패턴)도 잡는다. 소스 순서상 선언이 사용보다
    // 앞에 오는 일반적인 경우만 다룬다.
    const createRequireVarNames = new Set();

    function checkNonLiteral(node, argNode, label) {
      if (!isStringLiteralNode(argNode)) {
        context.report({
          node,
          message: `${label} 의 인자는 리터럴 문자열이어야 한다(패키지 경계 우회 방지) — 템플릿 리터럴·변수·문자열 연결·비-리터럴 표현식은 금지된다.`
        });
        return true;
      }
      return false;
    }
    function checkForbiddenLiteralTarget(node, argNode, label) {
      const hit = forbidden.find((f) => f.re.test(argNode.value));
      if (hit) context.report({ node, message: `${label}: ${hit.message}` });
    }

    return {
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          node.init &&
          node.init.type === "CallExpression" &&
          node.init.callee.type === "Identifier" &&
          node.init.callee.name === "createRequire"
        ) {
          createRequireVarNames.add(node.id.name);
        }
      },
      ImportExpression(node) {
        // 리터럴인데 금지 대상인 경우는 이미 forbiddenDynamicImportSelectors
        // (no-restricted-syntax, ImportExpression > Literal 셀렉터)가 잡는다 — 여기서
        // 또 잡으면 같은 위반에 에러가 두 줄 뜬다. 여기는 "리터럴이 아니다" 만 본다.
        checkNonLiteral(node, node.source, "동적 import()");
      },
      CallExpression(node) {
        const callee = node.callee;
        const isRequireCall =
          callee.type === "Identifier" && (callee.name === "require" || createRequireVarNames.has(callee.name));
        const isChainedCreateRequire =
          callee.type === "CallExpression" && callee.callee.type === "Identifier" && callee.callee.name === "createRequire";
        const label = isRequireCall ? "require(...)" : isChainedCreateRequire ? "createRequire(...)(...)" : null;
        if (!label) return;
        const argNode = node.arguments[0];
        // require/createRequire 는 no-restricted-imports/no-restricted-syntax 어느 쪽도
        // 안 보는 완전한 사각지대라, 여기서 리터럴 여부와 금지 대상 여부를 둘 다 본다.
        if (!checkNonLiteral(node, argNode, label)) checkForbiddenLiteralTarget(node, argNode, label);
      }
    };
  }
};

// flat config 의 plugins 필드에 넣을 로컬 플러그인. npm 패키지가 아니라 이 파일
// 안에서 바로 정의한다(새 의존성 추가 금지 제약 때문에 별도 패키지로 안 뺀다).
const localRulesPlugin = { rules: { "no-nonliteral-dynamic-module-load": noNonLiteralDynamicModuleLoadRule } };

export default [
  {
    ignores: [
      "node_modules/**",
      "**/node_modules/**",
      "**/dist/**",
      "_archive/**",
      ".worktrees/**"
    ]
  },
  {
    // 안 쓰는 변수는 소스든 테스트든 실제 문제라 전체 .ts 에 켠다.
    files: ["apps/**/*.ts", "packages/**/*.ts"],
    languageOptions: typedLanguageOptions,
    plugins: typedPlugins,
    rules: {
      "@typescript-eslint/no-unused-vars": "error"
    }
  },
  {
    // 프로덕션 소스(src/)에만: node:test 의 최상위 `test(name, async fn)` 호출은
    // 반환된 Promise 를 의도적으로 await 하지 않는 게 정상 관용구다(러너가 등록된
    // 서브테스트를 알아서 추적한다). 이 저장소 test/*.test.ts 전 파일이 이 패턴을
    // 쓰기 때문에 test/ 에 이 룰을 켜면 실제로는 602건이 전부 이 관용구 하나에서만
    // 나온 오탐이 된다(직접 실행해 확인함). 그래서 실제 버그 신호가 있는 src/ 에만 켠다.
    files: ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    languageOptions: typedLanguageOptions,
    plugins: typedPlugins,
    // require-await 는 켜지 않는다 — 이 저장소에서 걸린 16건이 전부
    // 인터페이스 계약(OrchestratorPersistencePort / OutboxDispatcherStore /
    // TelegramBotTokenResolver / TelegramWebhookPorts / GatewayEventSink)이
    // Promise 반환을 요구하는 자리의 동기 구현이었다. async 를 떼면 반환 타입이
    // 바뀌어 호출부가 깨지므로 고칠 수 없는 위반이고, 참 양성률 0% 인 룰은
    // disable 주석만 늘려 신호를 흐린다.
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error"
    }
  },
  // ---- 패키지 경계 강제 ----
  // 지적 사항: "@hu-ai/*" 스코프명은 있지만 소스 어디에도 bare import 로 안 쓰이고
  // 전부 "../../../packages/x/src/..." 상대경로다 — 선언된 경계가 실제로는 0건 강제된다.
  //
  // 진짜 npm workspaces 런타임 전환(대안: tsconfig paths, npm workspaces bare import)을
  // 실측 시도했다:
  // - tsconfig "paths" 별칭: tsc(moduleResolution NodeNext)는 별칭을 상대경로로 재작성하지
  //   않고 리터럴로 그대로 emit 한다. 이 저장소는 번들러 없이 dist/*.js 를 node --test 로
  //   직접 실행하므로 typecheck 는 통과해도 런타임에서 100% "Cannot find package" 로 죽는다
  //   (컴파일 타임 전용이라 이 저장소엔 무의미 — 실제로 emit 파일 확인함).
  // - npm workspaces bare import(@hu-ai/x): node_modules/@hu-ai/* symlink 는 이미 존재하나
  //   (workspaces 필드는 이미 있음) packages/*/package.json 에 main/exports 항목이 없어
  //   bare import 는 즉시 ERR_MODULE_NOT_FOUND. main 필드에 "../../dist/..." 를 직접 넣어도
  //   symlink 경유 상대경로 계산이 어긋나 node_modules/dist/... 로 잘못 풀린다(실측 확인).
  //   패키지 폴더 "안"에 리다이렉트 shim 파일(예: entry.mjs 가 "../../dist/..." 를 re-export)을
  //   둬야 실제로 풀리는데, 이 전환은 package.json 8개 편집 + shim 파일 신설이 필요하고
  //   package.json 은 이번 작업 범위 밖(소대장 소유)이라 이번 라운드엔 적용하지 않고
  //   별도로 제안한다(보고 참조).
  // 그래서 상대경로 패턴 금지를 쓰되, `group`(리터럴 glob) 대신 `regex` 옵션을 쓴다.
  //
  // 2026-08-31 결함 수정: `group: ["../../ai-adapters/**"]` 는 "../../" 깊이를
  // 리터럴로 고정하기 때문에 하위 폴더에서 import 하면(예: "../../../ai-adapters/...")
  // 매치가 깨져서 조용히 통과한다(실제로 재현해 확인함 — 아래 실증 스크립트 참고).
  // `regex` 옵션(forbiddenPackagePatterns 헬퍼, 위에 정의)은 "../" 개수와 무관하게
  // import 문자열 안에 패키지 디렉터리 세그먼트(예: "ai-adapters/src/")가 등장하는지만
  // 본다 — 앞에 "../" 가 몇 개 붙든, "packages/" 프리픽스가 있든 없든 항상 잡힌다.
  // 새 npm 의존성 없이 eslint 10.9.1 내장 `no-restricted-imports` 의 `regex` 옵션만으로
  // 해결된다.
  //
  // 레이어(위→아래로 참조 가능, 역방향 금지):
  //   apps/*(3, 아래 전부 가능하나 실제 쓰는 것만 허용)
  //   → supabase-runtime(2, contracts+telegram-ui+orchestrator+workflow)
  //   → orchestrator(1, contracts+telegram-ui)
  //   → ai-adapters(0.5, contracts 만)
  //   → contracts / workflow / telegram-ui(0, 서로 의존 금지)
  //
  // orchestrator → telegram-ui 는 의도적으로 허용한다: telegram-ui 는 fetch/네트워크/
  // Telegram SDK 호출이 전혀 없는 순수 텍스트 템플릿 패키지(파일 2개: index.ts, sanitize.ts,
  // I/O 없음 확인함)라 "표현 계층 오염"이 아니라 supabase-runtime 도 이미 쓰는 공용 메시지
  // 렌더링 유틸 호출이다.
  {
    files: ["packages/contracts/src/**/*.ts", "packages/workflow/src/**/*.ts", "packages/telegram-ui/src/**/*.ts"],
    plugins: { local: localRulesPlugin },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: forbiddenPackagePatterns(
          ["contracts", "workflow", "telegram-ui", "orchestrator", "ai-adapters", "supabase-runtime"],
          "이 패키지는 최하위 레이어라 다른 패키지를"
        )
      }],
      "no-restricted-syntax": ["error", ...forbiddenDynamicImportSelectors(
        ["contracts", "workflow", "telegram-ui", "orchestrator", "ai-adapters", "supabase-runtime"],
        "이 패키지는 최하위 레이어라 다른 패키지를"
      )],
      "local/no-nonliteral-dynamic-module-load": ["error", forbiddenPackagePatterns(
        ["contracts", "workflow", "telegram-ui", "orchestrator", "ai-adapters", "supabase-runtime"],
        "이 패키지는 최하위 레이어라 다른 패키지를"
      )]
    }
  },
  {
    files: ["packages/ai-adapters/src/**/*.ts"],
    plugins: { local: localRulesPlugin },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: forbiddenPackagePatterns(
          ["workflow", "telegram-ui", "orchestrator", "supabase-runtime"],
          "ai-adapters 는 contracts 외 패키지를"
        )
      }],
      "no-restricted-syntax": ["error", ...forbiddenDynamicImportSelectors(
        ["workflow", "telegram-ui", "orchestrator", "supabase-runtime"],
        "ai-adapters 는 contracts 외 패키지를"
      )],
      "local/no-nonliteral-dynamic-module-load": ["error", forbiddenPackagePatterns(
        ["workflow", "telegram-ui", "orchestrator", "supabase-runtime"],
        "ai-adapters 는 contracts 외 패키지를"
      )]
    }
  },
  {
    files: ["packages/orchestrator/src/**/*.ts"],
    plugins: { local: localRulesPlugin },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: forbiddenPackagePatterns(
          ["workflow", "ai-adapters", "supabase-runtime"],
          "orchestrator 는 contracts/telegram-ui 외 패키지를"
        )
      }],
      "no-restricted-syntax": ["error", ...forbiddenDynamicImportSelectors(
        ["workflow", "ai-adapters", "supabase-runtime"],
        "orchestrator 는 contracts/telegram-ui 외 패키지를"
      )],
      "local/no-nonliteral-dynamic-module-load": ["error", forbiddenPackagePatterns(
        ["workflow", "ai-adapters", "supabase-runtime"],
        "orchestrator 는 contracts/telegram-ui 외 패키지를"
      )]
    }
  },
  {
    files: ["packages/supabase-runtime/src/**/*.ts"],
    plugins: { local: localRulesPlugin },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: forbiddenPackagePatterns(
          ["ai-adapters"],
          "supabase-runtime 은 contracts/telegram-ui/orchestrator/workflow 외 패키지를"
        )
      }],
      "no-restricted-syntax": ["error", ...forbiddenDynamicImportSelectors(
        ["ai-adapters"],
        "supabase-runtime 은 contracts/telegram-ui/orchestrator/workflow 외 패키지를"
      )],
      "local/no-nonliteral-dynamic-module-load": ["error", forbiddenPackagePatterns(
        ["ai-adapters"],
        "supabase-runtime 은 contracts/telegram-ui/orchestrator/workflow 외 패키지를"
      )]
    }
  },
  {
    files: ["apps/bot-service/src/**/*.ts"],
    plugins: { local: localRulesPlugin },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: forbiddenPackagePatterns(
          ["ai-adapters"],
          "bot-service 는 local-gateway 전용인 ai-adapters 를"
        )
      }],
      "no-restricted-syntax": ["error", ...forbiddenDynamicImportSelectors(
        ["ai-adapters"],
        "bot-service 는 local-gateway 전용인 ai-adapters 를"
      )],
      "local/no-nonliteral-dynamic-module-load": ["error", forbiddenPackagePatterns(
        ["ai-adapters"],
        "bot-service 는 local-gateway 전용인 ai-adapters 를"
      )]
    }
  },
  {
    files: ["apps/local-gateway/src/**/*.ts"],
    plugins: { local: localRulesPlugin },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: forbiddenPackagePatterns(
          ["telegram-ui", "orchestrator", "workflow"],
          "local-gateway 는 contracts/ai-adapters/supabase-runtime 외 패키지를"
        )
      }],
      "no-restricted-syntax": ["error", ...forbiddenDynamicImportSelectors(
        ["telegram-ui", "orchestrator", "workflow"],
        "local-gateway 는 contracts/ai-adapters/supabase-runtime 외 패키지를"
      )],
      "local/no-nonliteral-dynamic-module-load": ["error", forbiddenPackagePatterns(
        ["telegram-ui", "orchestrator", "workflow"],
        "local-gateway 는 contracts/ai-adapters/supabase-runtime 외 패키지를"
      )]
    }
  }
];
