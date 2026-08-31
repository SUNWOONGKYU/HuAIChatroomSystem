// 협업 운영센터(index.html) 본체를 실제 브라우저에서 클릭해 검증한다.
//
// quiz-gate.test.mjs·reason-input.test.mjs 는 함수 정의를 파일에서 뽑아 `new Function()` 으로
// 돌리는 단위 테스트라 "버튼을 눌렀을 때 실제로 그 함수가 불리는가"는 보지 못한다.
// 여기서는 Chromium 을 띄워 Telegram WebApp 객체와 miniapp-* 함수 응답을 흉내 낸 뒤,
// 방장이 하는 여정을 그대로 밟는다 — 탭 전환 → 카드 열기 → 보완 요청(사유 입력) →
// 승인(퀴즈 게이트 통과 후 제출) → 새로고침 → 닫기. 서버에 실제로 무엇이 POST 되는지까지 본다.
//
// 운영 함수·운영 DB·실제 Telegram 은 전혀 건드리지 않는다. 모든 요청은 page.route 가 받는다.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startBrowserGameFixture } from "./browser-test-fixture.mjs";

const ROOM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DECIDABLE_TASK = "11111111-1111-4111-8111-111111111111";
const RUNNING_TASK = "22222222-2222-4222-8222-222222222222";

// 결함(6차 감사) 대응 — 다른 브라우저 테스트(breakout-game 등)의 고정 대기 flakiness 와
// 같은 종류가 여기 6)단계에도 있었다: window.__tasksLoads 를 참조하는 waitForFunction 은
// 그 전역이 이 페이지에 존재한 적이 없어 조건이 늘 참으로 즉시 통과하는 장식이었고,
// 실제로는 뒤이은 고정 300ms 대기 하나로 새로고침 fetch 가 끝나길 "바라는" 구조였다.
// server.tasksLoads(라우트 핸들러가 Node 쪽에서 직접 증가시키는 값)를 실제로 폴링해
// fetch 완료를 확인한다 — Playwright API 로 브라우저 쪽 조건을 폴링하는 다른 곳들과
// 다르게, 이건 Node 프로세스 안의 값이라 page.evaluate 없이 바로 확인할 수 있다.
async function waitForNodeCondition(predicate, description, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timeout(${timeoutMs}ms): ${description} 기다리다 실패했다`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const fixture = await startBrowserGameFixture({ envName: "OPERATION_CENTER_URL", fileName: "index.html" });
const origin = new URL(fixture.url).origin;
const functionsBase = origin + "/fn";
const pageUrl = fixture.url + "?fn=" + encodeURIComponent(functionsBase);

// 서버 흉내. 상태를 가진다 — 퀴즈 통과 여부와 결정 이력은 방장의 클릭에 따라 바뀐다.
const server = {
  quizPassed: false,
  decisions: [],
  quizSubmissions: [],
  tasksLoads: 0,
  tasks() {
    return {
      room: { purpose: "테스트 방" },
      generatedAt: new Date().toISOString(),
      tasks: [
        {
          taskId: DECIDABLE_TASK, title: "결제 실패율 조사", status: "completion_approval_pending", statusLabel: "완료 승인 대기",
          bucket: "needs_decision", decidable: !this.decisions.some((d) => d.taskId === DECIDABLE_TASK && d.action === "final_approve"),
          purpose: "원인 파악", scope: "재시도 로직", completionCriteria: "원인 특정",
          assignee: { role: "codex_leader", adapter_type: "codex" }, artifacts: [{ name: "report.md", url: origin + "/artifact" }, { name: "local-only.txt" }]
        },
        {
          taskId: RUNNING_TASK, title: "로그 수집기 작성", status: "in_progress", statusLabel: "진행 중",
          bucket: "in_progress", decidable: false, purpose: "로그", scope: "수집", completionCriteria: "동작", artifacts: []
        }
      ]
    };
  }
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();

// index.html 은 Telegram 공식 telegram-web-app.js 를 외부에서 불러온다. 그 스크립트는 로드되면
// window.Telegram 을 자기 것으로 덮어써서, 아래 addInitScript 로 심은 stub(start_param·initData)이
// 통째로 사라진다 — 실제로 그래서 이 테스트가 "방이 지정되지 않았습니다" 화면에서 멈췄다.
// 여기서 비워서 응답하면 stub 이 살아남고, 테스트가 네트워크 없이도 돈다.
await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
  route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));

// Telegram WebApp 객체. initData 는 서명 검증 대상이지만 그건 서버(page.route)가 흉내 내므로
// 여기선 존재만 하면 된다. start_param 으로 방을 지정하는 실제 진입 경로를 그대로 쓴다.
await page.addInitScript(({ roomId }) => {
  window.__haptics = [];
  window.Telegram = {
    WebApp: {
      initData: "query_id=test&user=%7B%22id%22%3A5001%7D&auth_date=1&hash=deadbeef",
      initDataUnsafe: { start_param: roomId },
      themeParams: {},
      ready() {}, expand() {}, onEvent() {},
      HapticFeedback: { notificationOccurred(kind) { window.__haptics.push(kind); } }
    }
  };
}, { roomId: ROOM_ID });

await page.route("**/fn/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.replace(/^\/fn/, "");
  const auth = request.headers()["authorization"] || "";
  assert.match(auth, /^tma /, "모든 함수 호출에 Telegram initData 인증 헤더가 실려야 한다");
  const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  if (path === "/miniapp-tasks" && request.method() === "GET") {
    assert.equal(url.searchParams.get("roomId"), ROOM_ID);
    server.tasksLoads += 1;
    return json(200, server.tasks());
  }
  if (path === "/miniapp-proposals" && request.method() === "GET") return json(200, { proposals: [], viewerRole: "owner" });
  if (path === "/miniapp-quiz" && request.method() === "GET") {
    assert.equal(url.searchParams.get("taskId"), DECIDABLE_TASK);
    return json(200, server.quizPassed
      ? { hasQuiz: true, passed: true }
      : { hasQuiz: true, passed: false, questions: [{ q: "무엇이 바뀌었나?", choices: ["재시도 로직", "UI 색상"] }, { q: "완료 조건은?", choices: ["원인 특정", "배포"] }] });
  }
  if (path === "/miniapp-quiz" && request.method() === "POST") {
    const body = request.postDataJSON();
    server.quizSubmissions.push(body);
    server.quizPassed = Array.isArray(body.answers) && body.answers[0] === 0 && body.answers[1] === 0;
    return json(200, server.quizPassed ? { passed: true, correctCount: 2 } : { passed: false, correctCount: 1, summary: "재시도 로직이 바뀌었습니다." });
  }
  if (path === "/miniapp-approve" && request.method() === "POST") {
    const body = request.postDataJSON();
    server.decisions.push(body);
    return json(200, { ok: true, note: body.action === "final_approve" ? "완료 승인이 기록되었습니다." : undefined });
  }
  return json(404, { error: "unknown-route:" + path });
});

await page.goto(pageUrl);

// 1) 첫 화면: 탭이 그려지고 "승인 필요" 칼럼에 결정 대상 카드가 있다.
await page.waitForSelector("#tabs .tab", { timeout: 5000 });
assert.equal(await page.locator("#room-title").textContent(), "테스트 방");
const tabs = page.locator("#tabs .tab");
assert.equal(await tabs.count(), 5, "상태 버킷 5개가 탭으로 나와야 한다");
assert.equal(await tabs.nth(0).getAttribute("aria-selected"), "true");
assert.equal(await page.locator("#board .task-card").count(), 1);
assert.match(await page.locator("#board .task-card .title").first().textContent(), /결제 실패율 조사/);
assert.equal(await page.locator("#board .task-card .pill.decidable").count(), 1, "결정 필요 배지가 보여야 한다");
assert.equal(await page.locator("#proposals-section").isHidden(), true, "제안이 없으면 제안 섹션은 숨긴다");

// 2) 탭 전환: "진행 중" 탭을 실제로 눌러 다른 카드가 나오는지.
await tabs.nth(1).tap();
assert.equal(await tabs.nth(1).getAttribute("aria-selected"), "true");
assert.match(await page.locator("#board .task-card .title").first().textContent(), /로그 수집기 작성/);
await tabs.nth(0).tap();

// 3) 카드 열기: 상세 시트가 열리고 결과물 링크는 url 있는 것만 <a href> 다.
await page.locator("#board .task-card").first().tap();
await page.waitForSelector("#overlay.open", { timeout: 3000 });
assert.equal(await page.locator("#detail-title").textContent(), "결제 실패율 조사");
assert.equal(await page.locator("#detail-artifacts a[href]").count(), 1, "주소가 있는 결과물만 링크");
assert.equal(await page.locator("#detail-artifacts li.not-openable").count(), 1, "주소 없는 결과물은 링크가 아니어야 한다");
const actionButtons = page.locator("#action-row button");
assert.deepEqual(await actionButtons.allTextContents(), ["승인", "보완 요청"]);

// 4) 보완 요청: 사유 없이는 못 보내고, 사유를 적으면 request_revision 이 사유와 함께 POST 된다.
await actionButtons.nth(1).tap();
await page.waitForSelector("#reason-section:not([hidden])", { timeout: 3000 });
assert.equal(await page.locator("#reason-send-btn").isDisabled(), true, "사유가 비어 있으면 보내기는 비활성");
await page.locator("#reason-input").fill("재시도 간격을 지수 백오프로 바꿔 주세요");
assert.equal(await page.locator("#reason-send-btn").isDisabled(), false);
await page.locator("#reason-send-btn").tap();
await page.waitForFunction(() => document.querySelector("#decision-note")?.textContent?.includes("보완 요청을 전달했습니다"), null, { timeout: 3000 });
assert.equal(server.decisions.length, 1);
assert.equal(server.decisions[0].taskId, DECIDABLE_TASK);
assert.equal(server.decisions[0].action, "request_revision");
assert.equal(server.decisions[0].reason, "재시도 간격을 지수 백오프로 바꿔 주세요");
assert.match(String(server.decisions[0].idempotencyKey), /.+/, "재전송 방지 키가 실려야 한다");
// 성공 후 시트는 스스로 닫힌다.
await page.waitForSelector("#overlay.open", { state: "hidden", timeout: 3000 });

// 5) 승인: 퀴즈 게이트. 처음엔 퀴즈가 뜨고, 틀리면 다시, 맞히면 승인이 제출된다.
await page.locator("#board .task-card").first().tap();
await page.waitForSelector("#overlay.open", { timeout: 3000 });
await page.locator("#action-row button", { hasText: "승인" }).tap();
await page.waitForSelector("#quiz-section:not([hidden])", { timeout: 3000 });
assert.equal(await page.locator("#quiz-questions .quiz-question").count(), 2);
assert.equal(server.decisions.length, 1, "퀴즈를 통과하기 전에는 승인이 서버로 가면 안 된다");

// 문항을 다 안 고르면 제출이 막힌다.
await page.locator("#quiz-submit-btn").tap();
assert.match(await page.locator("#quiz-feedback").textContent(), /모든 문항에 답해주세요/);

// 하나 틀리게 답하면 오답 안내가 나오고 여전히 승인은 안 나간다.
await page.locator('input[name="quiz-q0"][value="0"]').check();
await page.locator('input[name="quiz-q1"][value="1"]').check();
await page.locator("#quiz-submit-btn").tap();
await page.waitForFunction(() => /문항 정답/.test(document.querySelector("#quiz-feedback")?.textContent || ""), null, { timeout: 3000 });
assert.equal(server.quizSubmissions.length, 1);
assert.equal(server.decisions.length, 1);

// 맞히면 퀴즈가 닫히고 액션 줄이 돌아온다. 다시 승인을 누르면 이번엔 제출된다.
await page.locator('input[name="quiz-q1"][value="0"]').check();
await page.locator("#quiz-submit-btn").tap();
await page.waitForSelector("#quiz-section[hidden]", { state: "attached", timeout: 3000 });
await page.waitForSelector("#action-row:not([hidden])", { timeout: 3000 });
await page.locator("#action-row button", { hasText: "승인" }).tap();
await page.waitForFunction(() => document.querySelector("#decision-note")?.textContent?.includes("완료 승인이 기록되었습니다"), null, { timeout: 3000 });
assert.equal(server.decisions.length, 2);
assert.equal(server.decisions[1].action, "final_approve");
assert.equal(server.decisions[1].taskId, DECIDABLE_TASK);
assert.notEqual(server.decisions[1].idempotencyKey, server.decisions[0].idempotencyKey, "액션마다 다른 재전송 키");
await page.waitForSelector("#overlay.open", { state: "hidden", timeout: 3000 });

// 6) 승인 뒤 다시 불러오면 그 작업은 더 이상 결정 대상이 아니다(배지 사라짐).
const loadsBefore = server.tasksLoads;
await page.locator("#refresh-btn").tap();
await waitForNodeCondition(() => server.tasksLoads > loadsBefore, "새로고침 버튼을 누른 뒤 /miniapp-tasks 재조회가 끝나기를");
await page.waitForFunction(
  () => document.querySelectorAll("#board .task-card .pill.decidable").length === 0,
  null,
  { timeout: 3000 }
);
assert.ok(server.tasksLoads > loadsBefore, "새로고침 버튼이 실제로 목록을 다시 불러와야 한다");
assert.equal(await page.locator("#board .task-card .pill.decidable").count(), 0, "승인한 작업에 결정 필요 배지가 남으면 안 된다");

// 7) 닫기 버튼과 바깥 탭으로 시트가 닫힌다.
await page.locator("#board .task-card").first().tap();
await page.waitForSelector("#overlay.open", { timeout: 3000 });
await page.locator("#close-detail-btn").tap();
await page.waitForSelector("#overlay.open", { state: "hidden", timeout: 3000 });

// 8) 정적 건전성: href 없는 <a>, 클릭 핸들러만 달린 <div> 는 없어야 한다.
const deadLinks = await page.locator("a:not([href])").count();
assert.equal(deadLinks, 0, "href 없는 링크는 고장으로 읽힌다");
const haptics = await page.evaluate(() => window.__haptics);
assert.ok(haptics.includes("success"), "결정 성공 시 햅틱 피드백이 호출돼야 한다");

console.log(JSON.stringify({
  result: "pass",
  page: "index.html",
  journey: ["tabs", "open-card", "request_revision(reason)", "quiz-gate(incomplete→wrong→correct)", "final_approve", "refresh", "close"],
  decisions: server.decisions.map((d) => d.action),
  quizSubmissions: server.quizSubmissions.length
}));

await context.close();
await browser.close();
await fixture.close();
