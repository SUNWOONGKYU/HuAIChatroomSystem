export function maskTelegramSensitiveText(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer <redacted>")
    .replace(/(apikey|authorization)(["':\s]+)([A-Za-z0-9._-]+)/gi, "$1$2<redacted>")
    .replace(/(service_role|service-role|serviceRoleKey)(["':\s=]+)([A-Za-z0-9._-]+)/gi, "$1$2<redacted>");
}

export function safeTelegramTraceUri(uri: string): string {
  return maskTelegramSensitiveText(uri).replace(/([?&])(token|key|signature|secret|apikey|authorization)=[^&\s]+/gi, "$1$2=<redacted>");
}

const INTERNAL_OUTPUT_FALLBACK = "내부 실행 정보는 Telegram에 표시하지 않습니다. 운영 기록에서 확인해 주세요.";

export function sanitizeTelegramVisibleText(text: string): string {
  const masked = maskTelegramSensitiveText(text);
  const visible: string[] = [];
  let internalFence = false;
  for (const line of masked.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^```(?:json|log|text)?\s*$/i.test(trimmed)) {
      internalFence = !internalFence;
      continue;
    }
    if (!internalFence && !isInternalTelegramLine(trimmed)) visible.push(line);
  }
  const result = visible.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return result || INTERNAL_OUTPUT_FALLBACK;
}

function isInternalTelegramLine(line: string): boolean {
  if (!line) return false;
  if (looksLikeJson(line)) return true;
  return (
    /^[}\]],?\s*$/.test(line) ||
    /^"[^"\r\n]+"\s*:/.test(line) ||
    /^at\s+\S+(?:\s+\(|\s).+?:\d+:\d+\)?$/i.test(line) ||
    /^(?:\d{4}-\d{2}-\d{2}[T\s]\S+\s+)?(?:DEBUG|INFO|WARN|ERROR|TRACE)\b[\s:]/i.test(line) ||
    /^(?:stdout|stderr|stack|traceback|payload|rawOutput|hook(?:\s+output)?)\s*[:=]/i.test(line) ||
    /^(?:Session(?:Start|End)|PreToolUse|PostToolUse)\s+hook\b/i.test(line) ||
    /^Node\.js v\d+/i.test(line)
  );
}

function looksLikeJson(line: string): boolean {
  if (!/^[{[]/.test(line)) return false;
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}
