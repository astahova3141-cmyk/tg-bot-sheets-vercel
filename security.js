// security.js
import { kv } from "@vercel/kv";

/** Верификация секрета Telegram (setWebhook ...&secret_token=XXX) */
export function verifyTelegramSecret(req, expected) {
  if (!expected) return false;
  const got = req.headers["x-telegram-bot-api-secret-token"];
  return got === expected;
}

/** Дедупликация update_id на окно TTL (сек) */
export async function dedupeUpdate(updateId, ttlSec = 6 * 60 * 60) {
  if (updateId === undefined || updateId === null) return false;
  const key = `upd:${updateId}`;
  const seen = await kv.get(key);
  if (seen) return true;
  await kv.set(key, "1", { ex: ttlSec });
  return false;
}

/** Рейт-лимит по chatId: не чаще одного события в windowSec */
export async function rateLimit(chatId, windowSec = 3) {
  if (!chatId) return false;
  const key = `rate:${chatId}`;
  const last = await kv.get(key);
  const now = Date.now();
  if (last && now - parseInt(last, 10) < windowSec * 1000) return true;
  await kv.set(key, String(now), { ex: windowSec });
  return false;
}

/** Санитизация значений перед записью в Google Sheets */
export function sanitizeCell(v) {
  const s = (v ?? "").toString();
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/** Ограничение на голосовые (пример: по длительности) */
export function voiceAllowed(msg, maxSec = 60) {
  const d = msg?.voice?.duration || 0;
  return d <= maxSec;
}
