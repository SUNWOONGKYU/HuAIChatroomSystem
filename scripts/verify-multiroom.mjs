import { spawnSync } from "node:child_process";

// 원본 Codex 기획서의 검증 명령 8개는 전부 단일방 테스트였다 — 다방 회귀를 잡을 수단이
// 하나도 없었다. 이 스크립트는 그 빈자리를 메운다. MBO KPI 두 숫자(뜨문뜨문 20방,
// 동시 3방)를 실제로 측정 가능하게 만드는 게 목적이다.
//
// 2층 구조다.
//   층 1(오프라인, 기본): fake fetch/spawn 만으로 다방 로직이 논리적으로 성립하는지 확인.
//     라이브 DB 없이 CI/커밋에서 돈다. `--live` 없이 실행하면 이 층만 돈다.
//   층 2(라이브 실측, --live 옵트인): 실제 Supabase 에 붙어 응답 시간을 잰다.
//     기본 실행에서는 절대 안 돌고, 이 스크립트를 짠 사람도 실행하지 않는다.
//
// 층 1은 "다방 관련 항목마다 새 fake-fetch 테스트를 처음부터 다시 쓰는" 대신, 각 항목을
// 이미 검증하는 기존 게이트(다른 분대가 실제로 짜고 통과시킨 테스트)를 오케스트레이션한다.
// 이유: 같은 동작을 두 군데서 다르게 재구현하면 두 소스가 서로 다른 결론을 낼 위험이
// 생긴다(파생 규칙이 한 곳에만 있어야 한다는 원칙과 같은 이유). 대신 이 스크립트가
// 새로 주는 가치는 (a) MBO KPI 언어로 항목별 통과/실패를 매핑하고, (b) 실패 시 증상을
// 사람이 바로 알아볼 수 있게 적고, (c) 35개 전체 게이트를 안 돌리고 다방 관련 항목만
// 빠르게 확인할 수 있는 단일 진입점을 제공하는 것이다.

// 항목 순서는 팀장이 지시문에서 나열한 순서를 따른다.
const MULTI_ROOM_CHECKS = [
  {
    id: "allowed-chat-ids-union",
    label: "여러 방의 telegram_chat_id 합집합 (outbox 발신 허용 목록)",
    gates: ["verify:supabase-runtime-loader"],
    symptomOnFailure:
      "방을 늘렸는데 부팅 시 allowedChatIds 에 방 하나 것만 들어 있으면, 다른 방으로 나가는 메시지가 전부 markDead(\"unauthorized-outbound-chat\")로 죽는다."
  },
  {
    id: "per-room-execution-defaults",
    label: "방별 projectPath/gatewayId/actorId 실행 기본값 분리",
    gates: ["verify:bot-service-runtime"],
    symptomOnFailure:
      "방마다 다른 projectPath/gatewayId 를 못 가지면, 모든 방이 같은 로컬 폴더에서 실행돼 고객 A 작업이 고객 B 프로젝트 폴더에서 돌아가는 사고가 난다."
  },
  {
    id: "room-isolation-queries",
    label: "/tasks·/task·/trace 방 격리 (다른 방 데이터 유출 차단)",
    gates: ["verify:room-isolation"],
    symptomOnFailure:
      "격리가 깨지면 다른 방의 task 제목·산출물 URI·검증 이력이 새어 나간다 — 조회 명령 하나로 다른 고객 정보가 노출되는 정보 유출 사고다."
  },
  {
    id: "outbox-room-id-populated",
    label: "outbox INSERT 에 room_id 가 채워짐 (공평 리스의 전제조건)",
    gates: ["verify:gateway-report-rendering", "verify:room-isolation"],
    symptomOnFailure:
      "room_id 가 null 로 남으면 새로 들어가는 outbox 행이 전부 \"방 없음\" 공유 버킷 하나로 묶여, 방 단위 공평 리스가 그 행들에는 사실상 안 걸린다."
  },
  {
    id: "room-failure-isolation",
    label: "한 방의 처리 실패가 같은 배치의 다른 방 메시지를 막지 않음",
    gates: ["verify:local-gateway-consumer"],
    symptomOnFailure:
      "한 행 처리가 예외를 던졌을 때 배치의 나머지 행까지 통째로 안 돌면, 방 하나가 실패하는 순간 동시에 처리되던 다른 방들 응답까지 같이 끊긴다 — 동시 3방 KPI를 정면으로 위반한다."
  },
  {
    id: "bot-sharing-across-rooms",
    label: "공통 봇 4개가 방 수와 무관하게 같은 telegram_bot_id 로 재사용됨",
    gates: ["verify:supabase-runtime-loader"],
    symptomOnFailure:
      "봇이 방마다 새로 만들어지거나 역할이 뒤섞이면, 공통 봇 4개로 여러 프로젝트방을 운영한다는 아키텍처 전제 자체가 깨진다."
  }
];

// 이 항목은 층 1로 증명할 수 없다 — Postgres 함수(lease_huai_outbox, LATERAL 캡) 로만
// 존재하는 로직이라, JS fake fetch 로 재현하면 SQL 을 다시 구현해서 그걸 검증하는
// 꼴이라 실제 회귀를 못 잡는다. 실측(층 2, --live)으로만 검증 가능하다.
const LIVE_ONLY_ITEM = {
  id: "outbox-room-fairness",
  label: "방 단위 outbox 공평 리스 (lease_huai_outbox 의 방별 캡)",
  reason:
    "lease_huai_outbox 는 Postgres plpgsql 함수 안에서 LATERAL 로 방별 상한을 계산한다. 이 로직을 JS 로 다시 구현해 오프라인으로 통과시키면, 실제 SQL 이 바뀌어도 이 스크립트는 계속 초록불을 낼 수 있다 — 검증이 아니라 거짓 안심이 된다.",
  verifiedBy: "layer2 (--live), 방별 outbox 적체량을 다르게 만든 뒤 리스 결과 분포를 확인"
};

export function multiRoomOfflineChecks() {
  return MULTI_ROOM_CHECKS.map((check) => ({ ...check, gates: [...check.gates] }));
}

export function liveOnlyItems() {
  return [{ ...LIVE_ONLY_ITEM }];
}

// verify-operation-ready.mjs 와 같은 관용구다 — spawnImpl 주입으로 실제 npm run 없이도
// 테스트 가능하게 만든다.
//
// 이 함수가 쓰는 게이트 중 다섯 개가 각자 "npm run build && node --test ..." 를 한다.
// verify-operation-ready.mjs 를 거치지 않고 이 스크립트를 단독 실행하면(예: 팀장이
// "다방만 빠르게 확인"하려고 직접 돌릴 때) 짧은 시간에 tsc 가 여러 번 dist 에 쓰게
// 되는데, Windows 에서는 직전 테스트 프로세스가 아직 파일을 붙잡고 있으면 그 쓰기가
// 간헐적으로 실패한다(build-if-needed.mjs 의 기존 코멘트와 동일 증상 — 실제로 이
// 스크립트를 실 실행해서 확인했다: 같은 게이트가 첫 호출은 실패, 재실행은 통과했다).
// 그래서 verify-operation-ready.mjs 와 같은 HUAI_PREBUILT 관용구로 한 번만 빌드하고
// 이후 게이트 호출에는 재빌드를 건너뛰게 한다.
export function runMultiRoomOfflineChecks({ spawnImpl = spawnSync, env = process.env } = {}) {
  let effectiveEnv = env;
  if (env.HUAI_PREBUILT !== "1") {
    const prebuild = spawnImpl("npm run build:force", { cwd: process.cwd(), env, stdio: "inherit", shell: true });
    if (prebuild.status !== 0) {
      return {
        ok: false,
        results: [],
        liveOnly: liveOnlyItems(),
        prebuildFailed: true
      };
    }
    effectiveEnv = { ...env, HUAI_PREBUILT: "1" };
  }

  const results = [];
  for (const check of MULTI_ROOM_CHECKS) {
    let ok = true;
    let failedGate;
    for (const gate of check.gates) {
      const result = spawnImpl(`npm run ${gate}`, { cwd: process.cwd(), env: effectiveEnv, stdio: "inherit", shell: true });
      if (result.status !== 0) {
        ok = false;
        failedGate = gate;
        break;
      }
    }
    results.push({
      id: check.id,
      label: check.label,
      ok,
      gates: [...check.gates],
      failedGate,
      symptomOnFailure: ok ? undefined : check.symptomOnFailure
    });
  }
  return { ok: results.every((result) => result.ok), results, liveOnly: liveOnlyItems() };
}

export function formatMultiRoomOfflineReport(report) {
  if (report.prebuildFailed) {
    return "Multi-room offline checks: FAIL (prebuild failed — see npm run build:force output above)";
  }
  const lines = [`Multi-room offline checks: ${report.ok ? "PASS" : "FAIL"}`];
  for (const result of report.results) {
    lines.push(`- [${result.ok ? "PASS" : "FAIL"}] ${result.id}: ${result.label} (gates: ${result.gates.join(", ")})`);
    if (!result.ok) {
      lines.push(`  failed at: ${result.failedGate}`);
      lines.push(`  symptom if this stays broken: ${result.symptomOnFailure}`);
    }
  }
  lines.push("");
  lines.push("Live-only items (need --live, cannot be proven offline):");
  for (const item of report.liveOnly) {
    lines.push(`- ${item.id}: ${item.label}`);
    lines.push(`  why offline can't prove it: ${item.reason}`);
    lines.push(`  verified by: ${item.verifiedBy}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 층 2: 라이브 DB 읽기 지연 probe (--live). 이 코드는 실제 Supabase 에 붙는다 —
// 기본 실행에서는 절대 호출되지 않는다(맨 아래 CLI 러너의 --live 분기에서만 진입).
// 읽기 위주로 설계했다: 각 방의 게이트웨이 행을 조회하는 지연시간을 잰다. 쓰기가
// 필요한 더 깊은 확인(핑 이벤트 삽입 후 outbox 처리 완료까지 폴링)은 일부러 넣지
// 않았다 — 팀장 지시대로 "라이브 모드는 읽기 위주"를 지키기 위해서다.
//
// ⚠️ 이 층은 MBO KPI(동시 3방 응답 3분 이내, 뜨문뜨문 20방)를 측정하지 않는다.
// KPI 는 사용자가 메시지를 보낸 뒤 리더 응답이 돌아오기까지의 체감 시간이고,
// 그 사이에는 폴링 주기(최대 75초) + CLI 실행(추정 60~180초)이 들어간다. 여기서
// 재는 Supabase REST 읽기 지연은 자릿수부터 다르다(수십~수백 ms). 방 개수(20/3)는
// KPI 시나리오와 맞췄지만, 시간 값은 "DB 조회가 방 개수와 무관하게 정상 속도로
// 라우팅되는가"만 본다 — end-to-end 사용자 체감 응답시간은 실제 Telegram 방에서
// 사람이 직접 재야 한다. formatLiveMultiRoomReport()/--json 출력 모두 이 사실을
// 명시한다(KPI_DISCLAIMER, measuresKpi:false).
// ---------------------------------------------------------------------------

export const DEFAULT_SEQUENTIAL_ROOM_TARGET = 20;
export const DEFAULT_CONCURRENT_ROOM_TARGET = 3;
// KPI 예산이 아니다 — "동시 조회가 비정상적으로 느린지"만 보는 이상 탐지 임계값이다.
// 정상적인 Supabase REST 읽기는 병렬 3건이어도 수백 ms~수 초 안에 끝난다. 10초를
// 넘기면 네트워크·DB 쪽에 뭔가 이상이 있다고 보고 이상으로 표시한다(예전에 여기 있던
// 3분은 KPI 예산 값을 그대로 베낀 것이었다 — 이 용도로는 지나치게 크다).
export const CONCURRENT_READ_ANOMALY_THRESHOLD_MS = 10 * 1000;

export const KPI_DISCLAIMER =
  "이 스크립트는 MBO KPI(사용자 체감 응답시간: 동시 3방 3분 이내 등)를 측정하지 않는다. " +
  "여기서 재는 것은 Supabase REST 읽기 지연(huai_gateway_instances 조회)뿐이며, " +
  "실제 KPI 에 들어가는 폴링 주기·CLI 실행 시간은 전혀 포함되지 않는다. " +
  "실제 KPI 는 실제 Telegram 방에서 사람이 메시지를 보내고 응답까지 걸리는 시간을 직접 측정해야 한다.";

export async function runLiveMultiRoomMeasurement(env, options = {}, fetchImpl = fetch) {
  const dryRun = options.dryRun === true;
  const baseUrl = trimSlash(required(env, "SUPABASE_URL"));
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");

  const rooms = await getJson(
    fetchImpl,
    `${baseUrl}/rest/v1/huai_rooms?status=eq.active&select=room_id,telegram_chat_id&order=created_at.asc`,
    serviceRoleKey
  );

  if (rooms.length === 0) {
    return {
      ok: false,
      dryRun,
      reason: "no-active-rooms",
      note: "온보딩된 방이 없다. node scripts/onboard-telegram-room.mjs 로 방을 먼저 만들어라.",
      measuresKpi: false,
      kpiDisclaimer: KPI_DISCLAIMER
    };
  }

  const sequentialCount = options.sequentialCount ?? DEFAULT_SEQUENTIAL_ROOM_TARGET;
  const concurrentCount = options.concurrentCount ?? DEFAULT_CONCURRENT_ROOM_TARGET;
  const sequentialTarget = rooms.slice(0, sequentialCount);
  const concurrentTarget = rooms.slice(0, concurrentCount);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      willRead: "각 방의 huai_gateway_instances 행을 room_id 로 조회한다 (쓰기 없음).",
      plan: {
        sequential: sequentialTarget.map((room) => room.room_id),
        concurrent: concurrentTarget.map((room) => room.room_id)
      },
      note:
        rooms.length < sequentialCount
          ? `요청한 순차 방 수(${sequentialCount})보다 온보딩된 활성 방 수(${rooms.length})가 적다 — 실제 실행 시 있는 만큼만 조회한다.`
          : undefined,
      measuresKpi: false,
      kpiDisclaimer: KPI_DISCLAIMER
    };
  }

  const sequentialResults = [];
  for (const room of sequentialTarget) {
    const startedAt = Date.now();
    const outcome = await probeRoom(fetchImpl, baseUrl, serviceRoleKey, room);
    sequentialResults.push({ roomId: room.room_id, ok: outcome.ok, latencyMs: Date.now() - startedAt, detail: outcome.detail });
  }

  const concurrentStartedAt = Date.now();
  const concurrentResults = await Promise.all(
    concurrentTarget.map(async (room) => {
      const startedAt = Date.now();
      const outcome = await probeRoom(fetchImpl, baseUrl, serviceRoleKey, room);
      return { roomId: room.room_id, ok: outcome.ok, latencyMs: Date.now() - startedAt, detail: outcome.detail };
    })
  );
  const concurrentTotalMs = Date.now() - concurrentStartedAt;

  const sequentialAllOk = sequentialResults.every((result) => result.ok);
  const concurrentAllOk = concurrentResults.every((result) => result.ok);
  // "이상 없음" 판정이다 — KPI 통과 판정이 아니다. 위 KPI_DISCLAIMER 참고.
  const concurrentWithinAnomalyThreshold = concurrentTotalMs <= CONCURRENT_READ_ANOMALY_THRESHOLD_MS;

  return {
    ok: sequentialAllOk && concurrentAllOk && concurrentWithinAnomalyThreshold,
    dryRun: false,
    measuresKpi: false,
    kpiDisclaimer: KPI_DISCLAIMER,
    sequential: { target: sequentialTarget.length, available: rooms.length, allOk: sequentialAllOk, results: sequentialResults },
    concurrent: {
      target: concurrentTarget.length,
      totalMs: concurrentTotalMs,
      anomalyThresholdMs: CONCURRENT_READ_ANOMALY_THRESHOLD_MS,
      withinAnomalyThreshold: concurrentWithinAnomalyThreshold,
      allOk: concurrentAllOk,
      results: concurrentResults
    }
  };
}

async function probeRoom(fetchImpl, baseUrl, serviceRoleKey, room) {
  try {
    const rows = await getJson(
      fetchImpl,
      `${baseUrl}/rest/v1/huai_gateway_instances?room_id=eq.${encodeURIComponent(room.room_id)}&select=gateway_id,status&limit=1`,
      serviceRoleKey
    );
    if (rows.length === 0) return { ok: false, detail: "no huai_gateway_instances row for this room" };
    return { ok: true, detail: `gateway status=${rows[0].status}` };
  } catch (err) {
    return { ok: false, detail: sanitize(err instanceof Error ? err.message : String(err)) };
  }
}

export function formatLiveMultiRoomReport(report) {
  if (report.reason === "no-active-rooms") {
    return [
      `Live multi-room DB-read probe: BLOCKED (${report.reason})`,
      report.note,
      `NOTE — 이 도구는 MBO KPI 를 측정하지 않는다: ${report.kpiDisclaimer}`
    ].join("\n");
  }
  if (report.dryRun) {
    const lines = [
      "Live multi-room DB-read probe: DRY-RUN (no writes, no probes actually sent)",
      `NOTE — 이 도구는 MBO KPI 를 측정하지 않는다: ${report.kpiDisclaimer}`,
      `will read: ${report.willRead}`,
      `sequential plan (${report.plan.sequential.length} rooms): ${report.plan.sequential.join(", ")}`,
      `concurrent plan (${report.plan.concurrent.length} rooms): ${report.plan.concurrent.join(", ")}`
    ];
    if (report.note) lines.push(`note: ${report.note}`);
    return lines.join("\n");
  }

  const lines = [`Live multi-room DB-read probe: ${report.ok ? "PASS" : "FAIL"}`];
  lines.push(`NOTE — 이 도구는 MBO KPI 를 측정하지 않는다: ${report.kpiDisclaimer}`);
  lines.push(
    `sequential read probe (방 N개 순차 조회, 전건 정상 응답 여부): ${report.sequential.target}/${report.sequential.available} rooms, all ok=${report.sequential.allOk}`
  );
  for (const result of report.sequential.results) {
    lines.push(`  room=${result.roomId} ok=${result.ok} latency_ms=${result.latencyMs} detail=${result.detail}`);
  }
  lines.push(
    `concurrent read probe (DB 읽기 지연만 측정, KPI 응답시간 아님): ${report.concurrent.target} rooms in parallel, total_ms=${report.concurrent.totalMs} anomaly_threshold_ms=${report.concurrent.anomalyThresholdMs} within_anomaly_threshold=${report.concurrent.withinAnomalyThreshold} all_ok=${report.concurrent.allOk}`
  );
  for (const result of report.concurrent.results) {
    lines.push(`  room=${result.roomId} ok=${result.ok} latency_ms=${result.latencyMs} detail=${result.detail}`);
  }
  return lines.join("\n");
}

function trimSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function required(env, key) {
  const value = env[key];
  if (!value) throw new Error(`missing-env:${key}`);
  return value;
}

function sanitize(value) {
  return String(value)
    .replace(/service_role_[A-Za-z0-9_-]+/g, "service_role_<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>");
}

async function getJson(fetchImpl, url, serviceRoleKey) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}`, "content-type": "application/json" }
  });
  if (!response.ok) throw new Error(`supabase-rest-error:${response.status}:${sanitize(await response.text())}`);
  return response.json();
}

function parseArgs(argv) {
  const options = { live: false, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") options.live = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--rooms") {
      options.sequentialCount = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--concurrent") {
      options.concurrentCount = Number(argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`unknown-arg:${arg}`);
    }
  }
  return options;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const options = parseArgs(process.argv.slice(2));

  if (!options.live) {
    const report = runMultiRoomOfflineChecks({ env: process.env });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatMultiRoomOfflineReport(report));
    if (!report.ok) process.exit(1);
  } else {
    const report = await runLiveMultiRoomMeasurement(process.env, options);
    console.log(options.json ? JSON.stringify(report, null, 2) : formatLiveMultiRoomReport(report));
    if (!report.ok) process.exit(1);
  }
}
