// verify-operation-env.mjs 는 apps/local-gateway/src/runtime.ts 의 lease 부등식
// (leaseMs > maxRuntimeMs * ceil(limit/concurrency))을 복제해서 쓴다 — 그 복제 이유는
// verify-operation-env.mjs 코드 안 주석에 있다(요약: verify-operation-env.mjs 와
// service-startup-preflight.mjs/telegram-connection-sequence.mjs 는 빌드 *전에* 먼저
// env 만 빠르게 확인하는 프리플라이트 도구라, dist import 를 강제하면 그 존재 이유가
// 거꾸로 된다).
//
// 복제는 드리프트 위험이 있다 — 누가 runtime.ts 의 공식이나 기본값을 바꾸면, 그 사람이
// verify-operation-env.mjs 를 볼 이유가 없다. 드리프트가 나면 게이트는 통과시키는데
// 런타임은 거부하거나(부팅 실패), 반대로 게이트는 막는데 런타임은 허용해서(중복 CLI
// 실행 — 이 부등식이 원래 막으려던 사고) 이 게이트 자체가 무의미해진다.
//
// 그래서 이 파일은 실제로 빌드된 dist/apps/local-gateway/src/runtime.js 의
// parseLocalGatewayRuntimeConfig() 를 직접 불러서, verify-operation-env.mjs 의 복제
// 로직과 같은 시나리오 집합을 나란히 돌려 결과가 일치하는지 확인한다. 이 파일만 빌드
// 의존적이다(package.json 의 verify:lease-formula-drift 가 `npm run build &&` 를
// 앞세운다) — verify-operation-env.mjs 자체는 여전히 빌드 없이 돈다.
import assert from "node:assert/strict";
import test from "node:test";
import { validateOperationEnv } from "./verify-operation-env.mjs";
import { parseLocalGatewayRuntimeConfig } from "../dist/apps/local-gateway/src/runtime.js";

const BASE_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  LOCAL_GATEWAY_ALLOWED_ROOTS: "C:\\repo",
  LOCAL_GATEWAY_ALLOWED_ADAPTERS: "codex,claude_code"
};

// 팀장이 수동으로 돌려 확인한 그 8개 시나리오를 그대로 코드로 옮긴다 — 라이브값,
// 템플릿값, concurrency=1, 경계값(> 이지 >= 아님), 기본값 사용 2개(통과/경계 실패),
// 홀수 나눗셈(ceil(7/2)=4) 2개(통과/경계 실패).
const SCENARIOS = [
  {
    label: "live-verified values (LIMIT/CONCURRENCY defaulted)",
    env: { LOCAL_GATEWAY_MAX_RUNTIME_MS: "300000", LOCAL_GATEWAY_LEASE_MS: "660000" },
    expectOk: true
  },
  {
    label: ".env.operation.example template values",
    env: {
      LOCAL_GATEWAY_LIMIT: "5",
      LOCAL_GATEWAY_CONCURRENCY: "3",
      LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000",
      LOCAL_GATEWAY_LEASE_MS: "1860000"
    },
    expectOk: true
  },
  {
    label: "concurrency lowered to 1 without raising LEASE_MS to match",
    env: {
      LOCAL_GATEWAY_LIMIT: "5",
      LOCAL_GATEWAY_CONCURRENCY: "1",
      LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000",
      LOCAL_GATEWAY_LEASE_MS: "1860000"
    },
    expectOk: false
  },
  {
    label: "exact boundary value (inequality is strict >, not >=)",
    env: {
      LOCAL_GATEWAY_LIMIT: "5",
      LOCAL_GATEWAY_CONCURRENCY: "3",
      LOCAL_GATEWAY_MAX_RUNTIME_MS: "900000",
      LOCAL_GATEWAY_LEASE_MS: "1800000"
    },
    expectOk: false
  },
  {
    label: "LIMIT/CONCURRENCY/MAX_RUNTIME_MS unset, LEASE_MS above the default-derived threshold",
    env: { LOCAL_GATEWAY_LEASE_MS: "3700000" },
    expectOk: true
  },
  {
    label: "LIMIT/CONCURRENCY/MAX_RUNTIME_MS unset, LEASE_MS exactly at the default-derived boundary",
    env: { LOCAL_GATEWAY_LEASE_MS: "3600000" },
    expectOk: false
  },
  {
    label: "odd division: limit=7, concurrency=2 (ceil(7/2)=4), lease just above threshold",
    env: {
      LOCAL_GATEWAY_LIMIT: "7",
      LOCAL_GATEWAY_CONCURRENCY: "2",
      LOCAL_GATEWAY_MAX_RUNTIME_MS: "450000",
      LOCAL_GATEWAY_LEASE_MS: "1800001"
    },
    expectOk: true
  },
  {
    label: "odd division: limit=7, concurrency=2 (ceil(7/2)=4), lease exactly at threshold",
    env: {
      LOCAL_GATEWAY_LIMIT: "7",
      LOCAL_GATEWAY_CONCURRENCY: "2",
      LOCAL_GATEWAY_MAX_RUNTIME_MS: "450000",
      LOCAL_GATEWAY_LEASE_MS: "1800000"
    },
    expectOk: false
  },
  // 이 시나리오가 별도로 필요한 이유: 위의 "기본값 사용" 경계 케이스는 LIMIT=5(기본)에서
  // ceil(5/3)=2 와 ceil(5/4)=2 가 우연히 같아서, concurrency 기본값이 3→4 로만 드리프트
  // 나면 못 잡는다(실제로 회귀 증명 중 concurrency:4 로 바꿔봤을 때 8개 중 아무것도
  // 안 잡혀서 발견했다 — maxRuntimeMs 드리프트로 바꿔서 잡았다). LIMIT=4 를 명시하면
  // ceil(4/3)=2 vs ceil(4/4)=1 로 갈려서, concurrency 기본값 자체의 드리프트도 이 표가
  // 잡아낸다.
  {
    label: "concurrency-default-sensitive boundary: LIMIT=4 (explicit), CONCURRENCY unset (default 3, ceil(4/3)=2)",
    env: { LOCAL_GATEWAY_LIMIT: "4", LOCAL_GATEWAY_LEASE_MS: "3600000" },
    expectOk: false
  }
];

for (const scenario of SCENARIOS) {
  test(`lease formula drift: ${scenario.label}`, () => {
    const env = { ...BASE_ENV, ...scenario.env };

    let runtimeOk = true;
    let runtimeError;
    try {
      parseLocalGatewayRuntimeConfig(env);
    } catch (err) {
      runtimeOk = false;
      runtimeError = err instanceof Error ? err.message : String(err);
    }

    const gateErrors = validateOperationEnv(env, "local-gateway");
    const leaseError = gateErrors.find((error) => error.startsWith("invalid-env:LOCAL_GATEWAY_LEASE_MS:must-exceed"));
    const gateOk = leaseError === undefined;

    // 한쪽만 pass/fail 이면 실패시킨다 — 에러 메시지에 어느 쪽이 뭐라고 답했는지 담는다.
    assert.equal(
      runtimeOk,
      gateOk,
      `runtime.ts(parseLocalGatewayRuntimeConfig) says ${runtimeOk ? "OK" : `THROWS: ${runtimeError}`}, ` +
        `but verify-operation-env.mjs(validateOperationEnv) says ${gateOk ? "OK" : `REJECTS: ${leaseError}`} — ` +
        `the two lease-formula implementations have drifted apart.`
    );
    // 시나리오 자체가 기대한 방향과도 맞는지 확인한다(둘 다 일치했는데 둘 다 틀렸다면
    // 드리프트는 안 잡히지만 이 시나리오 표가 잘못된 것이므로 별도로 잡아야 한다).
    assert.equal(runtimeOk, scenario.expectOk, `scenario "${scenario.label}" expected runtime ok=${scenario.expectOk} but got ${runtimeOk}`);
  });
}
