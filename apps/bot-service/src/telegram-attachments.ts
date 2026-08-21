// 텔레그램 메시지에 붙은 사진/문서를 실제로 내려받아 로컬 파일로 저장한다.
//
// 왜 필요한가: 기존에는 첨부가 있어도 "첨부: photo" 라는 글자만 작업 지시문에 실렸다.
// AI 실행기(Claude Code/Codex CLI)는 파일 경로가 있어야 Read 로 실제 내용을 볼 수 있는데,
// 그 경로 자체가 어디에도 없었다 — 그래서 사진을 보내도 AI 는 존재만 알고 내용은 몰랐다.
//
// 저장 위치는 프로젝트 루트가 아니라 별도 폴더(기본 C:\tmp\huai-telegram-attachments)다.
// local-gateway 의 allowedProjectRoots 는 CLI 실행 cwd 를 검사할 뿐 파일 읽기 자체를
// 막지 않으므로, 프로젝트 밖 절대경로를 프롬프트에 실어도 Read 로 열 수 있다.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TelegramAttachmentRef = {
  fileId: string;
  kind: "photo" | "document";
  suggestedName?: string;
};

// Telegram photo 배열은 작은 해상도부터 큰 해상도 순으로 온다 — 마지막이 원본에 가장 가깝다.
export function extractAttachmentRef(message: Record<string, unknown> | undefined): TelegramAttachmentRef | undefined {
  if (!message) return undefined;

  const photos = message.photo as Array<{ file_id?: unknown }> | undefined;
  if (Array.isArray(photos) && photos.length > 0) {
    const largest = photos[photos.length - 1];
    if (typeof largest?.file_id === "string") {
      return { fileId: largest.file_id, kind: "photo" };
    }
  }

  const document = message.document as { file_id?: unknown; file_name?: unknown } | undefined;
  if (typeof document?.file_id === "string") {
    return {
      fileId: document.file_id,
      kind: "document",
      suggestedName: typeof document.file_name === "string" ? document.file_name : undefined
    };
  }

  return undefined;
}

export async function downloadTelegramAttachment(input: {
  token: string;
  fileId: string;
  destDir: string;
  fileNameHint?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;

  const metaResponse = await fetchImpl(
    `https://api.telegram.org/bot${input.token}/getFile?file_id=${encodeURIComponent(input.fileId)}`,
    { signal: AbortSignal.timeout(20_000) }
  );
  const meta = await metaResponse.json().catch(() => ({ ok: false }));
  const remoteFilePath = meta?.result?.file_path;
  if (meta?.ok !== true || typeof remoteFilePath !== "string") {
    throw new Error(`telegram-get-file-failed:${meta?.description ?? metaResponse.status}`);
  }

  const fileResponse = await fetchImpl(`https://api.telegram.org/file/bot${input.token}/${remoteFilePath}`, {
    signal: AbortSignal.timeout(30_000)
  });
  if (!fileResponse.ok) throw new Error(`telegram-file-download-failed:${fileResponse.status}`);
  const bytes = new Uint8Array(await fileResponse.arrayBuffer());

  mkdirSync(input.destDir, { recursive: true });
  const finalPath = path.join(input.destDir, uniqueFileName(input.fileNameHint ?? path.basename(remoteFilePath)));
  writeFileSync(finalPath, bytes);
  return finalPath;
}

let sequence = 0;
function uniqueFileName(hint: string): string {
  sequence += 1;
  const safe = hint.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "attachment";
  const ext = path.extname(safe) || ".bin";
  const stem = safe.slice(0, safe.length - ext.length) || "attachment";
  return `${stem}_${Date.now()}_${sequence}${ext}`;
}
