// 보관한 하루치 대화를 요약해 방의 장기 기억으로 남긴다.
//
// 왜 아카이브와 따로인가: 아카이브는 지우기 전에 반드시 있어야 하는 무손실 사본이고,
// 이건 읽히기 위한 손실 압축이다. LLM 은 조용히 실패할 수 있으므로, 이 단계가 실패해도
// 아카이브·정리 판단에는 아무 영향이 없어야 한다. 그래서 스크립트도 파이프라인도 분리했다.
//
// 왜 파일이 아니라 DB 에 넣는가: 읽는 쪽이 bot-service 다. 그쪽은 작업 PC 의 파일이 아니라
// DB 를 본다. 파일로만 두면 만들어 놓고 아무도 안 읽는 요약이 된다.
//
// 모델은 구독 CLI 를 쓴다(claude -p). 추가 비용이 없고, 이 기계에 이미 로그인돼 있다.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MODEL = "claude-sonnet-4-6";
// 하루치 대화가 아무리 길어도 이 정도면 그날의 줄거리는 담긴다. 통째로 넣으면 비용·시간이
// 커지고 오래된 잡담이 최근 결정을 밀어낸다(세션 증류 워커도 같은 이유로 잘라 넣는다).
const MAX_INPUT_CHARS = 24_000;

export function buildDistillPrompt(roomName, date, transcript) {
  return [
    `아래는 텔레그램 협업방 "${roomName}" 의 ${date} 하루치 기록이다.`,
    "방장(사람)이 AI들에게 일을 시키고, AI가 실행·감사한 흔적이다.",
    "",
    "다음 두 덩어리로만 답하라. 다른 말은 쓰지 마라.",
    "",
    "## 요약",
    "- 방장이 무엇을 지시했나",
    "- 무엇이 실행됐고 결과는 무엇인가(성공/실패 모두)",
    "- 무슨 결정이 내려졌나(그리고 왜)",
    "- 미해결로 남은 것",
    "각 줄은 나중에 다른 AI가 읽고 맥락을 되찾을 수 있을 만큼 구체적으로. 날짜·이름·파일명을 남겨라.",
    "",
    "## 반복 지적",
    "그날 감사·검증에서 지적된 것 중 되풀이될 만한 것만 줄머리표로. 없으면 '없음'.",
    "",
    "기록:",
    transcript.slice(-MAX_INPUT_CHARS)
  ].join("\n");
}

// 모델 출력에서 두 덩어리를 가른다. 형식이 어긋나면 통째로 요약에 넣는다 —
// 요약이 없는 것보다 형식이 덜 맞는 요약이 낫다.
export function splitDistillOutput(text) {
  const findings = text.split(/^##\s*반복 지적\s*$/m)[1];
  const summary = text.split(/^##\s*반복 지적\s*$/m)[0].replace(/^##\s*요약\s*$/m, "").trim();
  const trimmedFindings = (findings ?? "").trim();
  return {
    summary: summary || text.trim(),
    recurringFindings: trimmedFindings && trimmedFindings !== "없음" ? trimmedFindings : undefined
  };
}

function runClaude(prompt, model, timeoutMs = 300_000) {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", prompt, "--model", model, "--dangerously-skip-permissions"], {
      shell: true,
      windowsHide: true,
      // 이 세션이 또 훅을 돌려 자기 자신을 요약하지 않게 한다(세션 증류 워커와 같은 장치).
      env: { ...process.env, CLAUDE_WIKI_CHILD: "1" }
    });
    let out = "";
    const killer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => { clearTimeout(killer); resolve({ ok: false, text: out }); });
    child.on("close", (code) => { clearTimeout(killer); resolve({ ok: code === 0, text: out }); });
  });
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("missing-env:SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const base = url.replace(/\/+$/, "");
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  const model = process.env.HUAI_MEMORY_MODEL ?? DEFAULT_MODEL;
  const localDir = process.env.HUAI_ARCHIVE_LOCAL_DIR ?? path.join("sessions", "rooms");
  const apply = process.argv.includes("--apply");

  const rest = async (query) => {
    const response = await fetch(`${base}/rest/v1${query}`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`rest-failed:${response.status}`);
    return await response.json();
  };

  const rooms = await rest("/huai_rooms?status=eq.active&select=room_id,purpose");
  let done = 0;
  let skipped = 0;

  for (const room of rooms) {
    // 아카이브된 날만 대상으로 한다. 원본이 없으면 요약할 것도 없다.
    const manifests = await rest(
      `/huai_archive_manifest?room_id=eq.${room.room_id}&source=eq.telegram_updates&select=archive_date,object_path&order=archive_date.desc&limit=14`
    );
    const memories = await rest(`/huai_room_memory?room_id=eq.${room.room_id}&select=memory_date`);
    const remembered = new Set(memories.map((row) => row.memory_date));

    for (const manifest of manifests) {
      if (remembered.has(manifest.archive_date)) continue;

      const folder = String(room.purpose ?? room.room_id).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
      const file = path.join(localDir, folder, manifest.archive_date, "telegram_updates.jsonl");
      let transcript = "";
      try {
        transcript = await readFile(file, "utf8");
      } catch {
        // 로컬 사본이 없으면 Storage 에서 받아온다 — 다른 기계에서 돌려도 되게.
        const object = await fetch(`${base}/storage/v1/object/huai-archive/${manifest.object_path}`, { headers });
        if (!object.ok) { skipped += 1; continue; }
        transcript = await object.text();
      }
      if (!transcript.trim()) { skipped += 1; continue; }

      if (!apply) {
        console.log(`would-distill room=${folder} date=${manifest.archive_date} chars=${transcript.length}`);
        done += 1;
        continue;
      }

      const result = await runClaude(buildDistillPrompt(room.purpose ?? room.room_id, manifest.archive_date, transcript), model);
      if (!result.ok || !result.text.trim()) {
        // 요약 실패는 아카이브·정리에 영향을 주지 않는다. 다음 실행에서 다시 시도된다.
        console.error(`distill-failed room=${folder} date=${manifest.archive_date}`);
        skipped += 1;
        continue;
      }

      const parsed = splitDistillOutput(result.text);
      const response = await fetch(`${base}/rest/v1/huai_room_memory?on_conflict=room_id,memory_date`, {
        method: "POST",
        headers: { ...headers, prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          room_id: room.room_id,
          memory_date: manifest.archive_date,
          summary: parsed.summary,
          recurring_findings: parsed.recurringFindings ?? null,
          model
        })
      });
      if (!response.ok) {
        console.error(`memory-write-failed room=${folder} date=${manifest.archive_date} status=${response.status}`);
        skipped += 1;
        continue;
      }
      console.log(`distilled room=${folder} date=${manifest.archive_date} summary=${parsed.summary.length}자`);
      done += 1;
    }
  }

  console.log(`done apply=${apply} distilled=${done} skipped=${skipped}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  await main();
}
