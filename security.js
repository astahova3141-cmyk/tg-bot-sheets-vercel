// security.js (ESM). Без внешних пакетов.
// Набор утилит: проверка секрета Telegram, дедуп, рейт-лимит, санитайзер, лимит на voice.

const seenUpdates = new Map();   // update_id -> ts
const lastSeen    = new Map();   // chatId -> ts

// Чистим выжившие записи раз в N секунд
function gc(map, ttlMs) {
  const now = Date.now();
  for (const [k, ts] of map.entries()) if (now - ts > ttlMs) map.delete(k);
}

// 1) Проверка секрета вебхука Telegram
export function verifyTelegramSecret(req, expected) {
  if (!expected) return true; // если секрет не задан — пропускаем (на свой риск)
  const got = req.headers["x-telegram-bot-api-secret-token"];
  return typeof got === "string" && got === expected;
}

// 2) Дедупликация по update_id (TTL 10 минут)
export async function dedupeUpdate(updateId) {
  if (updateId === undefined || updateId === null) return false;
  gc(seenUpdates, 10 * 60 * 1000);
  if (seenUpdates.has(updateId)) return true;
  seenUpdates.set(updateId, Date.now());
  return false;
}

// 3) Рейт-лимит по chatId (интервал seconds)
export async function rateLimit(chatId, seconds = 2) {
  if (!chatId) return false;
  gc(lastSeen, 5 * 60 * 1000);
  const now = Date.now();
  const prev = lastSeen.get(chatId) || 0;
  if (now - prev < seconds * 1000) return true;
  lastSeen.set(chatId, now);
  return false;
}

// 4) Санитайзер для ячеек (убираем управления, длинные строки режем)
export function sanitizeCell(v, maxLen = 5000) {
  let s = String(v ?? "");
  s = s.replace(/[\u0000-\u001F\u007F]/g, " "); // control chars
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// 5) Лимит длительности голосовых
export function voiceAllowed(msg, maxSec = 60) {
  const d = Number(msg?.voice?.duration || 0);
  return d > 0 && d <= maxSec;
}
