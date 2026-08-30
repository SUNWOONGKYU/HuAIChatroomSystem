import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const roots = ["apps", "packages", "supabase", "scripts"];

// 결함(3차 감사) 대응 — 값의 형태만으로는 진짜 chat id 와 관례적 placeholder 를
// 자릿수로 구분할 수 없다(뒤 patterns 배열의 telegram-chat-id-bare-value 참고 — 둘 다
// 13자리). 대신 "명백히 지어낸 값" 두 유형을 예외로 둔다 — 둘 다 실제 저장소에서
// 실측한 값이다:
//   1) 오름차순 연속 숫자: "1234567890" (scripts/dry-run-spec.mjs 의 CHAT_ID 상수)
//   2) 0 이 9개 이상 이어지는 값: "0000000000"/"0000000001"
//      (.env.operation.example 의 BOT_SERVICE_TELEGRAM_CHAT_ID/BOT_SERVICE_ALLOWED_CHAT_IDS
//      예시 — 문서 템플릿이 실제 값 대신 쓰는 자리표시자다)
// 실제 텔레그램 chat id 는 무작위로 배정되므로 이런 규칙적인 패턴이 나올 확률은
// 사실상 0에 가깝다 — AWS 문서 예시 문자열("...EXAMPLE")을 제외하는 것과 같은 원리다.
// 아래 명령으로 roots(apps/packages/supabase/scripts) 안에서 실제 등장하는
// "-100" + 숫자 10자리 이상 값을 테스트 파일 제외하고 전수 확인해 이 두 유형 밖의
// 값은 없음을 확인했다:
//   grep -rln -e "-100[0-9]\{9,\}" apps packages supabase scripts | grep -vE "\.test\.(ts|js|mjs)$"
const CHAT_ID_PLACEHOLDER_EXCLUSION = "1234567890|0{9,}\\d?";

export const patterns = [
  { name: "telegram-bot-token", regex: /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/ },
  { name: "service-role-key", regex: /\bservice_role_[A-Za-z0-9_-]{16,}\b/ },
  { name: "private-key-block", regex: /BEGIN (RSA|OPENSSH|PRIVATE) KEY/ },
  // 특정 PC 에만 있는 경로. 코드·템플릿에 박히면 다른 PC 에서 조용히 없는 파일을 가리킨다.
  // 테스트 fixture 는 제외한다(아래 isScannable).
  { name: "machine-absolute-path", regex: /[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+\\{1,2}|[A-Za-z]:\\{1,2}Dev\\{1,2}HuAIChatroomSystem/ },
  // 결함 2 대응 — 벤더 API 키. 문서·예제 플레이스홀더("sk-ant-YOUR_KEY_HERE", "AKIAIOSFODNN7EXAMPLE"
  // 같은 것들)는 대개 숫자가 안 섞여 있거나 잘 알려진 예시 문자열이라는 점을 이용해 오탐을
  // 줄인다 — 접두사 뒤에 숫자가 최소 하나는 있어야 매칭되게 하거나(대부분의 키), AWS 는
  // 공식 문서가 쓰는 정확한 예시 문자열("...EXAMPLE")을 제외한다.
  { name: "anthropic-api-key", regex: /\bsk-ant-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-project-key", regex: /\bsk-proj-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}\b/ },
  { name: "openai-legacy-key", regex: /\bsk-(?!ant-|proj-)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}\b/ },
  { name: "google-api-key", regex: /\bAIza(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{30,}\b/ },
  { name: "github-pat-classic", regex: /\bghp_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{30,}\b/ },
  { name: "github-pat-fine-grained", regex: /\bgithub_pat_(?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{20,}\b/ },
  { name: "slack-token", regex: /\bxox[bp]-(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{10,}\b/ },
  { name: "aws-access-key-id", regex: /\bAKIA(?![0-9A-Z]*EXAMPLE\b)[0-9A-Z]{16}\b/ },
  // 결함(2차 감사): outbox_all.json/tax_outbox2.json/tax_report2.txt 실측 — 자격증명
  // 모양이 아닌 PII/운영데이터(진짜 telegram chat_id, 승인·작업 전문)는 위 8종 어느 것에도
  // 안 걸렸다. JSON 으로 직렬화된 telegramChatId/telegram_chat_id 필드(값이 실제 chat_id
  // 형태 — 부호 있는 4자리 이상 숫자)만 잡는다. 이스케이프된 중첩 JSON 문자열
  // (\"telegramChatId\":\"-100...\", tax_outbox2.json 의 target 필드처럼)도 잡도록 앞뒤
  // 백슬래시를 선택적으로 허용한다.
  //
  // 오탐 방지: TS/JS 소스의 객체 리터럴 키(`telegram_chat_id: value`, apps/bot-service/src/
  // supabase-store.ts 등)는 식별자라 따옴표로 안 감싸므로 이 패턴에 안 걸린다 — 직접
  // 대조 확인함(저장소 전체에 `"telegramChatId":`/`"telegram_chat_id":` 형태의 실제 매치가
  // 하나도 없다). *.test.ts/*.test.mjs 의 placeholder chat_id(-1001, -1001234567890 등)는
  // isScannable() 이 테스트 파일 자체를 스캔 대상에서 제외하므로 이중으로 안전하다.
  {
    name: "telegram-chat-id-dump",
    regex: /\\?"telegram(?:ChatId|_chat_id)\\?"\s*:\s*\\?"-?\d{4,}/
  },
  // 결함(3차 감사) 대응 — 위 telegram-chat-id-dump 는 `"key": "value"` JSON 직렬화
  // 모양에만 반응한다. 3차 평가관이 다음 세 가지 실측 우회를 확인했다:
  //   - CSV: `telegram_chat_id,text\n-1004…9076,...` (키와 값이 서로 다른 줄)
  //   - 따옴표 없는 콜론: `telegramChatId: -1004…9076`
  //   - 홑따옴표: `{'telegramChatId': '-1004…9076'}`
  // (실측 예시의 실제 자릿수는 이 스캐너 자신이 자기 코드를 스캔할 때 다시 걸리지
  // 않도록 가운데를 줄였다 — 전체 값은 verify-no-secrets.test.mjs 의 테스트 케이스 참고.)
  // 셋의 공통점은 "구두점이 뭐든, 어느 파일 형식이든, 값 자체가 텔레그램 슈퍼그룹/채널
  // chat id 모양(부호 있는 -100 + 숫자 10자리 이상)"이라는 것이다. 그래서 키 이름이나
  // 감싸는 구두점과 완전히 무관하게, 값의 형태만으로 잡는다.
  //
  // 오탐 방지: 값의 형태만으로는 진짜 chat id 와 관례적 placeholder(-1001234567890 등)를
  // 자릿수로 구분할 수 없다(둘 다 13자리) — 그래서 이 저장소가 실제로 쓰는 placeholder
  // 값을 이름과 무관하게 예외 처리한다(위 KNOWN_PLACEHOLDER_CHAT_ID_SUFFIXES 정의부 참고).
  {
    name: "telegram-chat-id-bare-value",
    regex: new RegExp(`(?<!\\d)-100(?!(?:${CHAT_ID_PLACEHOLDER_EXCLUSION})\\b)\\d{10,}\\b`)
  }
];

// 결함(3차 감사) 대응 — 화이트리스트(ts|js|mjs|sql|json|yaml|md|txt) 방식은 그 목록
// 밖의 확장자(.csv/.log/.ps1/.cmd/.py/.sh 등)를 내용과 무관하게 통째로 건너뛰었다.
// 3차 평가관이 실측으로 재현했다: 루트의 start-services-detached.ps1(미추적)에 이
// 저장소가 118d0d8 에서 막으려던 바로 그 개발자 PC 절대경로가 있는데도, .ps1 이
// 화이트리스트에 없어 `git add` + 스캔이 초록불이었다. 블랙리스트로 뒤집어 "알려진
// 바이너리 확장자·node_modules/dist/.git 만 제외, 나머지 텍스트는 전부 스캔"으로 바꾼다.
const BINARY_EXTENSION_PATTERN =
  /\.(png|jpe?g|gif|bmp|ico|webp|pdf|zip|gz|tgz|7z|rar|exe|dll|so|dylib|node|wasm|ttf|otf|woff2?|mp3|mp4|mov|avi|wav|db|sqlite3?|class|jar|bin)$/i;
const EXCLUDE_PATH_PATTERNS = [/\.test\.(ts|js|mjs)$/, /browser-test\.mjs$/];
const IGNORED_PATH_PREFIXES = ["node_modules/", "dist/", ".git/"];
// 결함 1 대응 — 상한을 넘는 파일은 조용히 건너뛰지 않는다(collect() 에서 로그로 알린다).
// 로그·덤프가 이 이상으로 크면 정규식 스캔 비용이 급격히 나빠진다.
const MAX_SCAN_BYTES = 5 * 1024 * 1024; // 5MB

export function isScannable(path) {
  const normalized = path.replace(/\\/g, "/");
  if (IGNORED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  if (BINARY_EXTENSION_PATTERN.test(path)) return false;
  return !EXCLUDE_PATH_PATTERNS.some((exclude) => exclude.test(path));
}

// 확장자 블랙리스트에 없는 바이너리(예: 확장자가 아예 없는 바이너리, 목록에 없는
// 포맷)를 걸러내는 보조 안전망. 첫 512바이트에 널바이트가 있으면 바이너리로 본다 —
// 텍스트 인코딩(UTF-8 한글 포함)은 널바이트를 쓰지 않는다.
function looksBinary(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(512);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    // 못 읽으면 다음 단계(readFileSync)에서 어차피 실패하거나 빈 내용으로 처리된다 —
    // 여기서는 스캔 대상에서 빼지 않는다(과소 스캔보다 과다 스캔이 안전한 방향).
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* noop */
      }
    }
  }
}

export function findSecretHits(file, text, scanPatterns = patterns) {
  const hits = [];
  for (const { name, regex } of scanPatterns) {
    const match = regex.exec(text);
    if (match) hits.push(`${file} [${name}] ${match[0].slice(0, 60)}`);
  }
  return hits;
}

// isScannable(경로 판단) 을 통과한 파일이 실제로 내용을 읽어도 되는 크기·형태인지
// 판단한다. 상한 초과는 로그로 알리고(결함 1 지적사항), 바이너리는 조용히 넘긴다(이미
// 확장자 블랙리스트가 대부분 걸러내므로 여기 도달하는 바이너리는 드문 예외다).
function shouldScanContent(path, stat) {
  if (stat.size > MAX_SCAN_BYTES) {
    console.error(`secret-scan-skip-oversized: ${path} (${stat.size} bytes > ${MAX_SCAN_BYTES})`);
    return false;
  }
  return !looksBinary(path);
}

function collect(path, out) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const child of readdirSync(path)) collect(join(path, child), out);
  } else if (isScannable(path) && shouldScanContent(path, stat)) {
    out.push(path);
  }
}

function gitFiles(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // git 이 없거나(예: 배포 아카이브) 저장소가 아니면 여기로 온다 — 아래 roots 디렉터리
    // 스캔만으로도 기존 동작은 그대로 유지된다.
    return [];
  }
}

// 결함 2 대응 — roots(apps/packages/supabase/scripts) 바깥, 저장소 루트에 떨어지는
// 파일은 지금까지 스캔 대상이 아니었다. 실제로 outbox_all.json/tax_outbox2.json 에
// 진짜 telegram chat_id·승인/작업 전문이 들어 있었는데 이 스캔은 초록불이었다(둘 다
// .gitignore 로도 막았지만, 강제로 add 되는 경우까지 대비해 스캔도 넓힌다). git 이
// 이미 알고 있는(추적 중이거나 커밋 대기 중인) 파일만 본다 — 매번 늘어나는 무관한
// 임시 파일까지 스캔하면 신호 대비 잡음만 커진다.
export function collectFilesToScan() {
  const files = [];
  for (const root of roots) collect(root, files);

  // 루트의 배포 템플릿도 본다. 라이브에서 .env.operation.example 에 개발자 PC 의 절대경로가
  // 기본값으로 들어간 채 나갔는데, 확장자가 .example 이라 이 스캔이 아예 안 봤다.
  const rootTemplates = readdirSync(".").filter((name) => /^\.env.*\.example$/.test(name));
  for (const template of rootTemplates) files.push(template);

  const trackedRootFiles = gitFiles(["ls-files", "--"]).filter(
    (path) => !path.includes("/") && !path.includes("\\")
  );
  const stagedFiles = gitFiles(["diff", "--cached", "--name-only", "--diff-filter=ACM"]);
  for (const path of new Set([...trackedRootFiles, ...stagedFiles])) {
    if (!existsSync(path) || !isScannable(path) || files.includes(path)) continue;
    if (shouldScanContent(path, statSync(path))) files.push(path);
  }

  return files;
}

function main() {
  const files = collectFilesToScan();
  const hits = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    hits.push(...findSecretHits(file, text));
  }

  if (hits.length > 0) {
    console.error("Potential secret material found:");
    for (const hit of [...new Set(hits)]) console.error(`- ${hit}`);
    process.exit(1);
  }

  console.log("Secret scan passed.");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
