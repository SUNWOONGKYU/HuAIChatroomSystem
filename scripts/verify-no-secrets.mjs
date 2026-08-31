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
//
// 결함(6차 감사) 대응 — 아래 telegram-chat-id-bare-value 의 숫자열 문자클래스에 \n 을
// 허용하도록 넓히면서(줄바꿈 분할 우회 대응), 이 예외 목록도 같이 \n 허용을 넓히지
// 않으면 새 구멍이 생긴다: placeholder 값 자체가 줄바꿈으로 쪼개지면(예:
// `"-1001234\n567890"`) 옛 예외 패턴(문자 사이 \n 을 안 받음)이 더 이상 안 걸려
// 부정형 lookahead 가 뚫리고, 정작 이 저장소가 실제로 쓰는 placeholder 를 줄바꿈
// 분할 상태로 오탐하게 된다(직접 재현해 확인함). 각 문자/반복 사이에 선택적 \n 을
// 끼워 넣어 같은 관용을 예외 쪽에도 준다 — 의미(오름차순 10자리 / 0 이 9개 이상)는
// 그대로다.
// 9 가 아홉 개 이상 이어지는 값도 같은 부류로 제외한다 — 0 반복과 마찬가지로 사람이
// 지어낸 자리표시자다(복구 리허설용 테스트 방이 -1009999999999 를 쓰면서 걸렸다).
// 실제 텔레그램 chat id 가 이런 반복 패턴으로 배정될 확률은 사실상 0이다.
const CHAT_ID_PLACEHOLDER_EXCLUSION =
  "1\\n?2\\n?3\\n?4\\n?5\\n?6\\n?7\\n?8\\n?9\\n?0" +
  "|0(?:\\n?0){8,}(?:\\n?\\d)?" +
  "|9(?:\\n?9){8,}(?:\\n?\\d)?";

export const patterns = [
  // 결함(4차 감사) 대응 — 원래 접미부 문자클래스 [A-Za-z0-9_-] 는 개행(\n)을 포함하지
  // 않아, 토큰을 줄바꿈으로 쪼개면(`123456789:ABC...\ndefGh...`) 매치가 끊겨 통과했다
  // (4차 평가관 실증 — scripts/verify-no-secrets.test.mjs 재현 테스트 참고). 콜론 뒤
  // 접미부 문자클래스에만 \n 을 추가해 개행을 사이에 두고 쪼갠 토큰도 하나로 이어붙여
  // 잡는다. 콜론 앞 숫자열(\d{5,})은 그대로 둔다 — 실측된 우회는 접미부 분할이었고,
  // 숫자열까지 개행 허용을 넓히면 "버전 12345\n:뒤에 20자 이상 식별자가 오는 무관한
  // 코드"까지 오탐할 위험이 커진다(콜론 뒤 분할보다 훨씬 흔한 코드 패턴).
  { name: "telegram-bot-token", regex: /\b\d{5,}:[A-Za-z0-9_\n-]{20,}\b/ },
  // 결함(6차 감사) 대응 — 5차에 telegram-bot-token 만 줄바꿈 분할에 고쳤고 이 패턴은
  // 그대로 남아 6차에도 재현됐다(6차 평가관 실증). 위와 같은 원리로 접두사
  // (service_role_)뒤 식별자 문자클래스에만 \n 을 추가한다 — 접두사 자체는 그대로 둔다
  // (접두사까지 줄바꿈을 허용하면 "service_role_" 문자열이 우연히 줄 끝에 걸리는 무관한
  // 코드까지 오탐할 위험이 커진다).
  { name: "service-role-key", regex: /\bservice_role_[A-Za-z0-9_\n-]{16,}\b/ },
  { name: "private-key-block", regex: /BEGIN (RSA|OPENSSH|PRIVATE) KEY/ },
  // 특정 PC 에만 있는 경로. 코드·템플릿에 박히면 다른 PC 에서 조용히 없는 파일을 가리킨다.
  // 이 패턴만은 테스트 파일에도 적용한다(findSecretHits 의
  // PATTERNS_ALSO_APPLIED_TO_TEST_FILES) — 절대경로는 픽스처로 쓸 이유가 없다.
  // 패턴 문자열을 조각으로 조립하는 이유: 이 패턴을 리터럴로 그대로 쓰면 스캐너가
  // 자기 소스를 스캔할 때 자기 자신에게 걸린다(테스트 파일에도 이 패턴을 적용하게
  // 바꾼 뒤 실제로 그렇게 됐다). 조각으로 나누면 탐지 동작은 같고 자기 매칭만 피한다.
  {
    name: "machine-absolute-path",
    regex: new RegExp(
      `[A-Za-z]:\\\\{1,2}Users\\\\{1,2}[A-Za-z0-9._-]+\\\\{1,2}` +
        `|[A-Za-z]:\\\\{1,2}${"Dev"}\\\\{1,2}${"HuAI"}${"ChatroomSystem"}`
    )
  },
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
  // 결함(6차 감사) 대응 — 키/값 사이(\s*)는 이미 개행을 허용하지만, 값 자체의 숫자열
  // (\d{4,})은 개행을 안 받아 그 안쪽을 쪼개면(예: `"-1004\n567890123`) 매치가 끊겨
  // 통과했다(6차 평가관 실증). 숫자열 문자클래스에만 \n 을 추가한다.
  {
    name: "telegram-chat-id-dump",
    regex: /\\?"telegram(?:ChatId|_chat_id)\\?"\s*:\s*\\?"-?[0-9\n]{4,}/
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
  // 결함(6차 감사) 대응 — "-100" 뒤 숫자열(\d{10,})도 개행을 안 받아 그 안쪽을 쪼개면
  // (예: `-1009\n99999999`) 매치가 끊겨 통과했다(6차 평가관 실증). 숫자열 문자클래스에만
  // \n 을 추가한다 — "-100" 접두사와 placeholder 예외(부정형 lookahead)는 그대로 둔다.
  {
    name: "telegram-chat-id-bare-value",
    regex: new RegExp(`(?<!\\d)-100(?!(?:${CHAT_ID_PLACEHOLDER_EXCLUSION})\\b)[0-9\\n]{10,}\\b`)
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
  // 테스트 파일도 스캔 대상에 넣는다 — 어떤 패턴을 적용할지는 findSecretHits() 가
  // 파일 종류를 보고 고른다(PATTERNS_ALSO_APPLIED_TO_TEST_FILES 참고). 예전처럼 여기서
  // 통째로 걸러내면 절대경로 같은 진짜 결함까지 같이 숨는다.
  return true;
}

// 확장자 블랙리스트에 없는 바이너리(예: 확장자가 아예 없는 바이너리, 목록에 없는
// 포맷)를 걸러내는 보조 안전망.
//
// 결함(5차 감사) 대응 — 예전에는 "첫 512바이트에 널바이트가 하나라도 있으면
// 바이너리"로 판정했다. 5차 평가관이 실증했듯 이건 그 자체가 공격 표면이었다 —
// 첫 512바이트 안에 널바이트 하나만 심으면(나머지는 정상 텍스트), 뒤에 진짜
// telegram bot token 이 있어도 shouldScanContent() 가 조용히 건너뛰고
// "Secret scan passed"(exit 0)로 끝났다. 널바이트 "존재 여부"가 아니라 샘플 안
// 제어문자(널 포함) "비율"로 판단하도록 바꾼다 — 진짜 바이너리는 샘플의 상당
// 비율이 제어문자지만, "정상 텍스트 파일에 널바이트 1개 심기" 공격은 비율이
// 미미하다(1/512 ≈ 0.2%). 임계값 30% 는 텍스트 인코딩(UTF-8 한글 포함, 탭/개행/
// 캐리지리턴 제외)에서는 사실상 발생하지 않는 수준이면서, 진짜 바이너리는 넉넉히
// 넘긴다.
const BINARY_SAMPLE_BYTES = 512;
const BINARY_CONTROL_BYTE_RATIO_THRESHOLD = 0.3;

function readSampleBytes(path, size = BINARY_SAMPLE_BYTES) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(size);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    // 못 읽으면 다음 단계(readFileSync)에서 어차피 실패하거나 빈 내용으로 처리된다 —
    // 여기서는 null 을 돌려주고 looksBinary() 가 "바이너리 아님"으로 처리한다
    // (과소 스캔보다 과다 스캔이 안전한 방향).
    return null;
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

// 탭(0x09)/개행(0x0A)/캐리지리턴(0x0D)은 텍스트 파일에도 흔하므로 제어문자 집계에서
// 뺀다. 나머지 0x00~0x1F 제어문자와 널바이트(0x00)만 센다.
export function controlByteRatio(buffer) {
  if (!buffer || buffer.length === 0) return 0;
  let controlCount = 0;
  for (const byte of buffer) {
    if (byte === 0x00 || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      controlCount += 1;
    }
  }
  return controlCount / buffer.length;
}

export function looksBinary(path) {
  const sample = readSampleBytes(path);
  if (sample === null) return false;
  return controlByteRatio(sample) >= BINARY_CONTROL_BYTE_RATIO_THRESHOLD;
}

// 결함(5차 감사) 대응(추가 방어선) — "바이너리 아님"으로 판정돼 실제로 스캔되는
// 파일이라도, 안에 낀 널바이트를 그대로 두면 그게 하필 시크릿 토큰 한가운데를
// 가를 경우 패턴의 문자클래스([A-Za-z0-9_-] 등)가 거기서 끊겨 놓칠 수 있다.
// 널바이트를 구분자로 보고 제거한 뒤(주변 텍스트는 그대로 붙여) 스캔에 넘긴다 —
// 정상 텍스트에는 애초에 널바이트가 없으므로 이 치환은 정상 파일에 아무 영향이
// 없다.
//
// 결함(6차 감사) 대응 — 널바이트(0x00)만 걷어내던 이전 버전은 널이 아닌 다른
// 제어문자(예: 0x01) 하나로 토큰을 쪼개도 그대로 뚫렸다(6차 평가관 실증 — 샘플
// 512바이트 중 1개(≈0.2%)라 looksBinary() 의 바이너리 판정 문턱(30%)에도 안
// 걸린다). 5차의 널바이트 취약점과 같은 근본 원인(문자클래스가 구분자에서 끊김)이
// 널 아닌 제어문자로 변형돼 재현된 것 — 그래서 널바이트 하나만이 아니라, 텍스트에
// 흔한 탭(0x09)/개행(0x0A)/캐리지리턴(0x0D)을 제외한 모든 제어문자(0x00~0x1F,
// 0x7F DEL)를 구분자로 보고 제거한다. 정상 텍스트(UTF-8 한글 포함)에는 이 범위의
// 문자가 애초에 없으므로 이 치환은 정상 파일에 아무 영향이 없다(아래 controlByteRatio
// 의 "탭/개행/캐리지리턴 제외" 판단 기준과 동일한 문자 집합).
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function stripControlCharacters(text) {
  return text.replace(CONTROL_CHAR_PATTERN, "");
}

// 테스트 파일에도 적용하는 패턴.
//
// 테스트는 시크릿처럼 생긴 픽스처(가짜 봇 토큰, placeholder chat id)를 일부러 쓰기 때문에
// 대부분의 패턴에서 제외한다. 그런데 "개발자 PC 절대경로"는 픽스처로 쓸 이유가 없는데도
// 그 제외에 같이 묻혀 있었다 — 실제로 local-gateway-consumer.test.ts 가 기대값에
// 개발자 PC 저장소 절대경로를 박아둔 탓에 다른 경로에 체크아웃하면 verify:all 이
// gate20 에서 통째로 멈추고 있었는데, 이 저장소가 커밋 118d0d8 에서 "절대경로 제거"라고
// 잡았다던 바로 그 결함이 test 예외 뒤에 숨어 5라운드 내내 안 걸렸다(6차 감사 발견).
const PATTERNS_ALSO_APPLIED_TO_TEST_FILES = new Set(["machine-absolute-path"]);

function isTestFile(file) {
  return EXCLUDE_PATH_PATTERNS.some((exclude) => exclude.test(file));
}

export function findSecretHits(file, text, scanPatterns = patterns) {
  const applicable = isTestFile(file)
    ? scanPatterns.filter(({ name }) => PATTERNS_ALSO_APPLIED_TO_TEST_FILES.has(name))
    : scanPatterns;
  const hits = [];
  for (const { name, regex } of applicable) {
    const match = regex.exec(text);
    if (match) hits.push(`${file} [${name}] ${match[0].slice(0, 60)}`);
  }
  return hits;
}

// 결함(4차 감사) 대응 — 5MB 초과 파일은 이 배열에 기록만 되고 collectFilesToScan()
// 호출자는 이걸 몰라서 최종 결과가 그냥 "Secret scan passed"(exit 0)로 끝났다(4차
// 평가관이 6MB 파일에 진짜 값을 숨겨 재현). collectFilesToScan() 시작마다 비우고,
// main() 이 getSkippedFiles() 로 읽어 최종 판정에 반영한다.
//
// 결함(5차 감사) 대응 — 바이너리로 판정해 건너뛴 파일도 5MB 초과 스킵과 같은
// 급으로 취급한다(둘 다 "내용을 못 봤다"는 점에서 동일한 위험이다). 오버사이즈
// 전용이던 배열을 { path, reason } 목록으로 일반화해 바이너리 스킵도 같이
// 기록한다 — 이제 어느 스킵이든 있으면 main() 이 초록불로 끝내지 않는다.
let skippedFiles = [];

// 하위호환 + 기존 테스트가 기대하는 "오버사이즈만" 조회.
export function getOversizedSkips() {
  return skippedFiles.filter((entry) => entry.reason === "oversized").map((entry) => entry.path);
}

export function getSkippedFiles() {
  return skippedFiles.map((entry) => ({ ...entry }));
}

// isScannable(경로 판단) 을 통과한 파일이 실제로 내용을 읽어도 되는 크기·형태인지
// 판단한다. 상한 초과·바이너리 판정 둘 다 로그로 알리고 skippedFiles 에 기록한다
// (결함 1 지적사항 — 아래 main() 이 이 기록을 최종 종료 상태에 반영한다). 예전에는
// 바이너리로 판정된 파일은 조용히 넘겼는데(이미 확장자 블랙리스트가 대부분 걸러내
// 므로 여기 도달하는 바이너리는 드문 예외라는 전제였다), 5차 감사가 그 "조용히"가
// 바로 공격 표면이라는 걸 실증했다.
function shouldScanContent(path, stat) {
  if (stat.size > MAX_SCAN_BYTES) {
    console.error(`secret-scan-skip-oversized: ${path} (${stat.size} bytes > ${MAX_SCAN_BYTES})`);
    skippedFiles.push({ path, reason: "oversized" });
    return false;
  }
  if (looksBinary(path)) {
    console.error(`secret-scan-skip-binary: ${path} (제어문자 비율 임계값 초과 — 진짜 바이너리로 판단)`);
    skippedFiles.push({ path, reason: "binary" });
    return false;
  }
  return true;
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

// 결함 2(3차 라운드) 대응 — roots(apps/packages/supabase/scripts) 바깥, 저장소 루트에
// 떨어지는 파일은 한때 스캔 대상이 아니었다. 실제로 outbox_all.json/tax_outbox2.json 에
// 진짜 telegram chat_id·승인/작업 전문이 들어 있었는데 이 스캔은 초록불이었다(둘 다
// .gitignore 로도 막았지만, 강제로 add 되는 경우까지 대비해 스캔도 넓힌다).
//
// 결함(4차 감사) 대응 — 위 수정은 "루트 직속" 추적 파일만 봤다(경로에 "/"나 "\\" 가
// 없는 것만). roots 바깥이면서 저장소 루트도 아닌 서브디렉터리(docs/, .github/,
// _archive/, assets/ 등)는 git 이 추적하는 파일이어도 한 번도 스캔 대상이 아니었다 —
// 커밋되고 나면 CI 포함 영구히 안 본다(4차 평가관이 collectFilesToScan() 실제 출력으로
// 확인). 이제 "루트 직속"이라는 제약을 없애고 git 이 추적하는 저장소 전체 파일을 본다.
// roots 재귀 스캔(추적 여부 무관, 로컬 미스테이징 파일까지 보는 안전망)과 겹치는
// 부분은 files.includes 로 중복 제거한다.
export function collectFilesToScan() {
  skippedFiles = [];
  const files = [];
  for (const root of roots) collect(root, files);

  // 루트의 배포 템플릿도 본다. 라이브에서 .env.operation.example 에 개발자 PC 의 절대경로가
  // 기본값으로 들어간 채 나갔는데, 확장자가 .example 이라 이 스캔이 아예 안 봤다.
  const rootTemplates = readdirSync(".").filter((name) => /^\.env.*\.example$/.test(name));
  for (const template of rootTemplates) files.push(template);

  const trackedFiles = gitFiles(["ls-files", "--"]);
  const stagedFiles = gitFiles(["diff", "--cached", "--name-only", "--diff-filter=ACM"]);
  for (const path of new Set([...trackedFiles, ...stagedFiles])) {
    if (!existsSync(path) || !isScannable(path) || files.includes(path)) continue;
    if (shouldScanContent(path, statSync(path))) files.push(path);
  }

  return files;
}

// 결함(4차 감사) 대응 — 5MB 초과 파일은 secret-scan-skip-oversized 로그만 남기고 스캔은
// exit 0("Secret scan passed")로 끝났다 — 로그를 안 보는 사람 입장에선 사실상 무음
// 스킵이다(4차 평가관이 6MB 지점에 진짜 값을 숨긴 파일로 재현). 정책: 스킵된 파일이
// 하나라도 있으면 초록불로 끝내지 않는다 — "과소 스캔보다 과다 스캔이 안전한 방향"
// (looksBinary() 주석과 같은 원칙)이므로, 못 본 내용이 있다는 사실 자체를 실패로 친다.
// 실제 시크릿이 발견된 경우(exit 1)와 종료 상태를 구분해 CI 로그에서 원인을 바로
// 알 수 있게 한다 — 실제 시크릿 없이 스킵(오버사이즈든 바이너리든)만 있으면 exit 2
// (결함(5차 감사) 대응 — 바이너리 스킵도 이제 여기 합류한다).
function main() {
  const files = collectFilesToScan();
  const skipped = getSkippedFiles();
  const hits = [];
  for (const file of files) {
    // 결함(5·6차 감사) 대응 — 널바이트를 포함한 제어문자가 (바이너리로 판정될
    // 만큼은 아니게) 섞여 있어도 무시하지 않는다. 구분자로 보고 제거한 뒤 나머지
    // 텍스트를 그대로 스캔한다.
    const text = stripControlCharacters(readFileSync(file, "utf8"));
    hits.push(...findSecretHits(file, text));
  }

  if (hits.length > 0) {
    console.error("Potential secret material found:");
    for (const hit of [...new Set(hits)]) console.error(`- ${hit}`);
    process.exit(1);
  }

  if (skipped.length > 0) {
    const oversized = skipped.filter((entry) => entry.reason === "oversized");
    const binary = skipped.filter((entry) => entry.reason === "binary");
    console.error(
      `Secret scan skipped ${skipped.length} file(s) — 내용을 못 봤다. ` +
      "축소하거나, 정말 필요하면 좁은 예외를 만들고 근거를 남겨라:"
    );
    if (oversized.length > 0) {
      console.error(`- oversized (> ${MAX_SCAN_BYTES} bytes):`);
      for (const { path } of oversized) console.error(`  - ${path}`);
    }
    if (binary.length > 0) {
      console.error(`- binary (제어문자 비율 임계값 초과):`);
      for (const { path } of binary) console.error(`  - ${path}`);
    }
    process.exit(2);
  }

  console.log("Secret scan passed.");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
