// 결함(4차 감사) 대응 — supabase/schema.sql 이 마이그레이션 누적 상태와 다시 드리프트되는
// 것을 막는다. 4차 평가관 실측: 20260829090000(FK 인덱스 5개), 20260829100000/20260831000000
// (huai_gateway_instances CHECK 제약 2건), 20260816160000(huai_tasks_room_thread_idx) 가
// supabase/migrations/ 에는 있는데 supabase/schema.sql 에는 반영되지 않아, 이 파일만 보고
// 새 환경을 세팅하면 인덱스·제약이 빠진 채로 만들어졌다.
//
// 완전한 SQL 파서는 아니다 — supabase/migrations/*.sql 전체를 파일명(=타임스탬프) 순서로
// 이어붙인 뒤, 아래 다섯 가지 형태만 순서대로 훑어 "이름 붙은 인덱스/제약이 최종적으로
// 존재하는가"를 추적한다:
//   1) create table if not exists <table> ( ... constraint <name> ... );  → 테이블 본문 안의
//      인라인 constraint 도 이름별로 추적한다(어느 테이블 소속인지 기억해 뒀다가 4번에 쓴다).
//   2) create (unique )?index if not exists <name> on <table>             → 추가
//   3) alter table <table> add constraint <name>                          → 추가
//   4) drop table if exists <table>                                       → 그 테이블 소속으로
//      기록된 모든 이름을 한꺼번에 제거(예: huai_room_memory 테이블 자체가 나중에
//      drop 되면서 그 위의 인덱스도 함께 사라진 사례를 정확히 반영한다)
//   5) drop index if exists <name> / alter table ... drop constraint if exists <name> → 제거
// 같은 파일 안에서 drop 후 add 로 같은 이름을 재정의하는 패턴(NOT VALID 로 추가하고
// 나중에 validate 하는 관용구가 자주 쓰는 형태)도 텍스트 등장 순서 그대로 처리되므로
// 정확히 "최종 존재"로 남는다.
//
// 최종적으로 남은 이름 집합이 supabase/schema.sql 텍스트 안에 (단어 경계로) 전부
// 등장하는지만 확인한다 — 정의가 정확히 같은 모양인지까지는 안 본다(그건 사람이
// 마이그레이션 diff 로 리뷰할 몫이다). "존재 자체를 깜빡 빠뜨리는" 이 결함 유형만 잡는다.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OP_RE =
  /create\s+table\s+if\s+not\s+exists\s+(?<ctTable>\w+)\s*\(([\s\S]*?)\n\);|create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+(?<idxName>\w+)\s+on\s+(?<idxTable>\w+)|alter\s+table\s+(?<atcTable>\w+)\s+add\s+constraint\s+(?<atcName>\w+)|drop\s+index\s+if\s+exists\s+(?<dropIdx>\w+)|alter\s+table\s+(?<dropConTable>\w+)\s+drop\s+constraint\s+if\s+exists\s+(?<dropCon>\w+)|drop\s+table\s+if\s+exists\s+(?<dropTable>\w+)/gi;
const INLINE_CONSTRAINT_RE = /\bconstraint\s+(\w+)/g;

// 결함(5차 감사) 대응 — OP_RE 는 `--` 줄 주석을 벗겨내지 않아, "롤백(수동, 실행되지
// 않음)" 섹션처럼 실행되지 않는 예시로 남겨둔 `-- drop index ...`/`-- drop table ...`
// 를 진짜 DROP 으로 파싱했다. 그 결과 위쪽에서 실제로 CREATE 된 인덱스/제약이 최종
// present 맵에서 조용히 지워졌다(5차 평가관이 expectedNamedObjects() 를 직접 호출해
// 계측 — huai_outbox_target_room_created_idx 등 3개가 추적 대상에서 빠짐). 파싱 전에
// SQL 주석(`--` 줄 주석, `/* */` 블록 주석)을 제거한다. 문자열 리터럴('...', ''로
// 이스케이프된 홑따옴표 포함)과 달러 인용 문자열($$...$$, $tag$...$tag$ — plpgsql
// 함수 본문에 쓰인다)은 그 안의 `--`/`/*`를 주석으로 오인해 지우면 안 되므로 원문
// 그대로 통과시킨다. 블록 주석은 내부 줄바꿈 개수만큼 빈 줄로 치환해, 주석 뒤에 오는
// `\n\);`(테이블 본문 종료) 같은 줄바꿈 의존 패턴이 깨지지 않게 한다.
export function stripSqlComments(sql) {
  let result = "";
  let i = 0;
  const n = sql.length;
  const dollarTagStart = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const newlineIdx = sql.indexOf("\n", i);
      if (newlineIdx === -1) {
        i = n;
      } else {
        result += "\n";
        i = newlineIdx + 1;
      }
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        i = n;
      } else {
        const inner = sql.slice(i + 2, end);
        result += "\n".repeat((inner.match(/\n/g) || []).length);
        i = end + 2;
      }
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      result += sql.slice(i, j);
      i = j;
      continue;
    }
    if (sql[i] === "$") {
      const tagMatch = dollarTagStart.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const closeIdx = sql.indexOf(tag, i + tag.length);
        const end = closeIdx === -1 ? n : closeIdx + tag.length;
        result += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    result += sql[i];
    i += 1;
  }
  return result;
}

// 마이그레이션 전체를 파일명(타임스탬프) 순서로 이어붙여, 최종적으로 존재해야 하는
// (이름 → 소속 테이블) 맵을 낸다.
export function expectedNamedObjects(migrationsDir = path.join(REPO_ROOT, "supabase", "migrations")) {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  let combined = "";
  for (const file of files) combined += stripSqlComments(readFileSync(path.join(migrationsDir, file), "utf8")) + "\n";

  const present = new Map(); // name -> table
  let match;
  while ((match = OP_RE.exec(combined))) {
    const groups = match.groups;
    if (groups.ctTable) {
      const body = match[2] ?? "";
      let inlineMatch;
      INLINE_CONSTRAINT_RE.lastIndex = 0;
      while ((inlineMatch = INLINE_CONSTRAINT_RE.exec(body))) present.set(inlineMatch[1], groups.ctTable);
    } else if (groups.idxName) {
      present.set(groups.idxName, groups.idxTable);
    } else if (groups.atcName) {
      present.set(groups.atcName, groups.atcTable);
    } else if (groups.dropIdx) {
      present.delete(groups.dropIdx);
    } else if (groups.dropCon) {
      present.delete(groups.dropCon);
    } else if (groups.dropTable) {
      for (const [name, table] of present) if (table === groups.dropTable) present.delete(name);
    }
  }
  return present;
}

// expectedNamedObjects() 의 이름들이 schema.sql 텍스트에 (단어 경계로) 등장하는지 대조해,
// 빠진 이름 목록을 { name, table } 형태로 돌려준다. 빈 배열이면 드리프트 없음.
export function findSchemaDrift(
  schemaPath = path.join(REPO_ROOT, "supabase", "schema.sql"),
  migrationsDir = path.join(REPO_ROOT, "supabase", "migrations")
) {
  const schemaText = readFileSync(schemaPath, "utf8");
  const expected = expectedNamedObjects(migrationsDir);
  const missing = [];
  for (const [name, table] of expected) {
    const wordBoundaryPattern = new RegExp("\\b" + name + "\\b");
    if (!wordBoundaryPattern.test(schemaText)) missing.push({ name, table });
  }
  return missing;
}

function main() {
  const missing = findSchemaDrift();
  if (missing.length > 0) {
    console.error("supabase/schema.sql 이 마이그레이션과 어긋난다 — 아래 인덱스/제약이 migrations 에는 있는데 schema.sql 에는 없다:");
    for (const { name, table } of missing) console.error(`- ${name} (테이블: ${table})`);
    process.exit(1);
  }
  console.log("Schema migration sync check passed.");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main();
}
