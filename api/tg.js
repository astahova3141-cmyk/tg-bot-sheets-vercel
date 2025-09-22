// api/tg.js — Telegram → Google Sheets + Voice (Deepgram), Node 18+ on Vercel

import { google } from "googleapis";

// ==== ENV
const BOT_TOKEN        = process.env.BOT_TOKEN || "";
const SHEET_ID         = process.env.SHEET_ID || "";
const WORK_CHAT_ID     = process.env.WORK_CHAT_ID || "";
const BOT_BANNER_URL   = process.env.BOT_BANNER_URL || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";

const TGBOT = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : "";

// ==== Telegram helpers
async function tgSend(chat_id, text, reply_markup) {
  if (!BOT_TOKEN || !chat_id) return;
  const body = { chat_id, text };
  if (reply_markup) body.reply_markup = reply_markup;
  await fetch(`${TGBOT}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function tgPhoto(chat_id, photo, caption, reply_markup) {
  if (!BOT_TOKEN || !chat_id) return;
  const body = { chat_id, photo, caption: caption || "" };
  if (reply_markup) body.reply_markup = reply_markup;
  await fetch(`${TGBOT}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function tgAction(chat_id, action = "typing") {
  if (!BOT_TOKEN || !chat_id) return;
  await fetch(`${TGBOT}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, action })
  });
}

// Ссылка от Telegram (если нужна)
async function tgFileLink(fileId) {
  if (!BOT_TOKEN || !fileId) return null;
  const r = await fetch(`${TGBOT}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = await r.json();
  const path = j?.result?.file_path;
  return path ? `https://api.telegram.org/file/bot${BOT_TOKEN}/${path}` : null;
}

// Скачиваем бинарь у Telegram и шлём байты в Deepgram (надёжнее URL-режима)
async function transcribeVoiceFromTelegram(fileId, mime = "audio/ogg", lang = "ru") {
  if (!DEEPGRAM_API_KEY || !fileId) return null;

  // 1) получаем file_path
  const r1 = await fetch(`${TGBOT}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j1 = await r1.json();
  const path = j1?.result?.file_path;
  if (!path) return null;

  // 2) качаем байты из Telegram
  const tgFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`;
  const r2 = await fetch(tgFileUrl);
  if (!r2.ok) return null;
  const buf = await r2.arrayBuffer();

  // 3) шлём байты в Deepgram
  const url = `https://api.deepgram.com/v1/listen?language=${encodeURIComponent(lang)}&smart_format=true&punctuate=true`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": mime || "application/octet-stream"
    },
    body: Buffer.from(buf) // Node 18 поддерживает Buffer в fetch
  });

  if (!resp.ok) return null;
  const data = await resp.json().catch(()=>null);
  const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return text.trim() || null;
}

// ==== Google Sheets
async function getSheets() {
  const client_email = process.env.GCP_CLIENT_EMAIL || "";
  const private_key  = (process.env.GCP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const auth = new google.auth.JWT(client_email, null, private_key, [
    "https://www.googleapis.com/auth/spreadsheets"
  ]);
  return google.sheets({ version: "v4", auth });
}

async function ensureHeaders(sheets) {
 const need = {
  DialogState: [ 
    "chat_id","step","name","phone","company","device","model","issue","urgent",
    "voice_urls","voice_texts", // ← было 1 поле, стало два «множественных»
    "updated_at" ],
  Requests: [
    "date","name","phone","company","device","model","issue","urgent",
    "voice_urls","voice_texts", // ← тоже два
    "chat_id","ticket_id","status","yougile_link","notified","closed_at"
  ]
};
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const titles = (meta.data.sheets || []).map(s => s.properties.title);

  for (const [name, headers] of Object.entries(need)) {
    if (!titles.includes(name)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: name } } }] }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${name}!A1:${String.fromCharCode(64 + headers.length)}1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
    } else {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${name}!1:1` });
      const row = resp.data.values?.[0] || [];
      if (row.length === 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${name}!A1:${String.fromCharCode(64 + headers.length)}1`,
          valueInputOption: "RAW",
          requestBody: { values: [headers] }
        });
      }
    }
  }
}

async function readAll(sheets, range) {
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return resp.data.values || [];
}
async function appendRow(sheets, sheet, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}
async function updateCell(sheets, sheet, row, colLetter, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!${colLetter}${row}`,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] }
  });
}

function colLetterFromIndex(idx) { // 0-based
  // простая A..Z, достаточно для наших заголовков
  return String.fromCharCode(65 + idx);
}

// ==== UI
const PROMPT = {
  name:    "Как вас зовут? (Фамилия не обязательна) ✍️",
  phone:   "Укажите телефон (формат +7XXXXXXXXXX или 8XXXXXXXXXX) 📱",
  company: "Как называется компания? 🏢",
  device:  "Какое устройство? Выберите ниже ⤵️",
  model:   "Модель устройства / картриджа (например: HP LaserJet Pro M404 / CF259A) 🧾",
  issue:   "Кратко опишите проблему (1–2 предложения) 🛠️",
  urgent:  "Срочность ремонта? Выберите вариант ниже ⤵️"
};

const KBD_MAIN   = { keyboard: [[{ text: "❌ Отмена /stop" }]], resize_keyboard: true };
const KBD_DEVICE = { keyboard: [[{text:"🖨 Принтер"},{text:"🖨 МФУ"},{text:"📠 Копир"}],[{text:"🧰 Другое"}]], resize_keyboard:true, one_time_keyboard:true };
const KBD_URGENT = { keyboard: [[{text:"⏱ В течение дня"},{text:"📅 Завтра"}],[{text:"🕑 1–2 дня"}]], resize_keyboard:true, one_time_keyboard:true };
const YESNO_INLINE = { inline_keyboard: [[{text:"✅ Подтвердить", callback_data:"CONFIRM"}],[{text:"✏️ Исправить…", callback_data:"EDIT_MENU"}]] };
const EDIT_INLINE  = { inline_keyboard: [[{text:"👤 Имя", callback_data:"EDIT:name"},{text:"📱 Телефон", callback_data:"EDIT:phone"}],[{text:"🏢 Компания", callback_data:"EDIT:company"},{text:"🖨 Устройство", callback_data:"EDIT:device"}],[{text:"🧾 Модель", callback_data:"EDIT:model"},{text:"🛠 Проблема", callback_data:"EDIT:issue"}],[{text:"⏳ Срочность", callback_data:"EDIT:urgent"}],[{text:"⬅️ Назад", callback_data:"BACK"}]] };

function makeSummary(state, idx) {
  return `Проверьте заявку:

👤 Имя: ${state[idx.name]||""}
📱 Тел: ${state[idx.phone]||""}
🏢 Компания: ${state[idx.company]||""}
🖨 Устройство: ${state[idx.device]||""}
🧾 Модель: ${state[idx.model]||""}
🛠 Проблема: ${state[idx.issue]||""}
⏳ Срочность: ${state[idx.urgent]||""}
🎧 Голос: ${state[idx.voice_urls] ? state[idx.voice_urls] : "—"}
🗒 Текст голоса: ${state[idx.voice_texts] ? state[idx.voice_texts] : "—"}

Всё верно?`;
}

// ==== Dialog state
async function findStateRow(sheets, chatId) {
  const rows = await readAll(sheets, "DialogState!A:Z");
  const head = rows[0] || [];
  const idx = {}; head.forEach((h,i)=> idx[h]=i);
  for (let r=1; r<rows.length; r++) {
    if (String(rows[r][idx["chat_id"]||0]) === String(chatId)) {
      return { rowNum: r+1, data: rows[r], idx, head };
    }
  }
  await appendRow(sheets, "DialogState", [String(chatId),"ask_name","","","","","","","","","", new Date().toISOString()]);
  const fresh = await readAll(sheets, "DialogState!A:Z");
  return { rowNum: fresh.length, data: fresh[fresh.length-1], idx, head };
}
async function setField(sheets, rowNum, head, field, value) {
  const colIdx = head.indexOf(field); if (colIdx<0) return;
  const colLetter = colLetterFromIndex(colIdx);
  await updateCell(sheets, "DialogState", rowNum, colLetter, value);
  const updIdx = head.indexOf("updated_at");
  if (updIdx >= 0) {
    const updCol = colLetterFromIndex(updIdx);
    await updateCell(sheets, "DialogState", rowNum, updCol, new Date().toISOString());
  }
}

// ==== Handler
export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(200).send("ok"); return; }

  try {
    const sheets = await getSheets();
    await ensureHeaders(sheets);

    const update = req.body || {};
    const cb  = update.callback_query || null;
    const msg = update.message || {};

    const chatId = cb ? cb.message?.chat?.id : msg.chat?.id;
    const text   = (msg.text || "").trim();
    const cbData = cb ? String(cb.data || "") : null;

    // --- callback-кнопки ---
    if (cb) {
      // тут НЕ объявляй chatId заново
      // используй chatId и cbData
      // ...
      res.status(200).send("ok"); return;
    }

    // --- voice / команды / диалог ---
    // тут тоже НЕ объявляй chatId заново
    // ...
    res.status(200).send("ok"); return;

  } catch (e) {
    console.error(e);
    res.status(200).send("ok");
  }
}

    // ==== Inline buttons
    if (update.callback_query) {
      const chatId = update.callback_query.message.chat.id;
      const data   = String(update.callback_query.data || "");
      const st = await findStateRow(sheets, chatId);
      const head = st.head, idx = st.idx;

      if (data === "CONFIRM") {
        const row = st.data;
        const vline = row[idx.voice_urls]  ? `\n🎧 Голос(а): ${row[idx.voice_urls]}`   : "";
        const tline = row[idx.voice_texts] ? `\n🗒 Текст(ы): ${row[idx.voice_texts]}` : "";
        await appendRow(sheets, "Requests", [
          new Date().toISOString(),
          row[idx.name]||"", row[idx.phone]||"", row[idx.company]||"",
          row[idx.device]||"", row[idx.model]||"", row[idx.issue]||"", row[idx.urgent]||"",
          row[idx.voice_urls]||"", row[idx.voice_texts]||"", // ← вот тут
          String(chatId), "", "new", "", "no", ""
        ]);

        if (WORK_CHAT_ID) {
          await tgSend(WORK_CHAT_ID,
`Новая заявка
👤 ${row[idx.name]||""}
📱 ${row[idx.phone]||""}
🏢 ${row[idx.company]||""}
🖨 ${row[idx.device]||""}
🧾 ${row[idx.model]||""}
🛠 ${row[idx.issue]||""}
⏳ ${row[idx.urgent]||""}${vline}${tline}`);
        }
        await setField(sheets, st.rowNum, head, "step", "done");
        await tgSend(chatId, "Спасибо! Заявка принята. Менеджер свяжется с вами в ближайшее время. 🙌");
        res.status(200).send("ok"); return;
      }

      if (data === "EDIT_MENU") { await tgSend(chatId, "Что исправим?", EDIT_INLINE); res.status(200).send("ok"); return; }
      if (data === "BACK") {
        await setField(sheets, st.rowNum, head, "step", "confirm");
        const fresh = (await readAll(sheets, `DialogState!A${st.rowNum}:Z${st.rowNum}`))[0];
        await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
        res.status(200).send("ok"); return;
      }
      if (data.startsWith("EDIT:")) {
        const field = data.split(":")[1]; // name/phone/...
        await setField(sheets, st.rowNum, head, "step", "edit_"+field); // ← именно edit_*
        const kbd = field==="device" ? KBD_DEVICE : (field==="urgent" ? KBD_URGENT : KBD_MAIN);
        await tgSend(chatId, PROMPT[field] || "Введите значение:", kbd);
        res.status(200).send("ok"); return;
      }


    // ==== Text / Voice messages
    const msg = update.message || {};
    const chatId = msg.chat?.id;
    const text = (msg.text || "").trim();

    // системные команды
    if (text === "/ping") { await tgSend(chatId, "ALIVE ✅"); res.status(200).send("ok"); return; }
    if (text === "/help") { await tgSend(chatId, "Команды:\n/start — начать заново\n/stop — отменить\n/id — ваш Chat ID\n/help — помощь"); res.status(200).send("ok"); return; }
    if (text === "/id")   { await tgSend(chatId, "Chat ID: " + chatId); res.status(200).send("ok"); return; }
    if (text === "/stop") {
      const st = await findStateRow(sheets, chatId);
      await setField(sheets, st.rowNum, st.head, "step", "stopped");
      await tgSend(chatId, "Ок, остановил. Чтобы начать заново — /start");
      res.status(200).send("ok"); return;
    }
    if (text === "/start") {
      const st = await findStateRow(sheets, chatId);
      for (const f of ["name","phone","company","device","model","issue","urgent","voice_url","voice_text"]) {
        await setField(sheets, st.rowNum, st.head, f, "");
      }
      await setField(sheets, st.rowNum, st.head, "step", "ask_name");
      const about = "Здравствуйте! Я бот приёма заявок по обслуживанию оргтехники.\nСоберу заявку и передам специалистам. Это займёт 1–2 минуты.";
      if (BOT_BANNER_URL) await tgPhoto(chatId, BOT_BANNER_URL, about); else await tgSend(chatId, about);
      await tgSend(chatId, PROMPT.name, KBD_MAIN);
      res.status(200).send("ok"); return;
    }

    // если пользователь прислал voice — прикрепим к заявке и распознаем
   if (msg.voice && msg.voice.file_id) {
  await tgAction(chatId, "record_voice");

  const fileId = msg.voice.file_id;
  const mime   = msg.voice.mime_type || "audio/ogg";

  const st0 = await findStateRow(sheets, chatId);
  const head = st0.head, idx = st0.idx;

  // 1) ссылка (на всякий случай тоже сохраним)
  const link = await tgFileLink(fileId);

  // 2) распознаём байтами (надёжно)
  let transcript = null;
  try {
    transcript = await transcribeVoiceFromTelegram(fileId, mime, "ru");
  } catch (_) {}

  // 3) аппендим к уже существующим значениям
  const prevUrls  = (st0.data[idx.voice_urls]  || "").trim();
  const prevTexts = (st0.data[idx.voice_texts] || "").trim();

  const newUrls  = link ? (prevUrls ? prevUrls + "\n" + link : link) : prevUrls;
  const newTexts = transcript ? (prevTexts ? prevTexts + "\n" + transcript : transcript) : prevTexts;

  if (newUrls !== prevUrls)   await setField(sheets, st0.rowNum, head, "voice_urls", newUrls);
  if (newTexts !== prevTexts) await setField(sheets, st0.rowNum, head, "voice_texts", newTexts);

  if (transcript) {
    await tgSend(chatId, "🎙 Голосовое прикрепил к заявке.\n🗒 Текст распознан и сохранён.");
  } else {
    await tgSend(chatId, "🎙 Голосовое прикрепил к заявке. Распознать не удалось, но ссылка сохранена.");
  }
  // продолжаем сценарий (не выходим)
}
    const st = await findStateRow(sheets, chatId);
    const head = st.head, idx = st.idx;
    const step = st.data[idx["step"]] || "ask_name";

    async function ask(field) {
      const kbd = field==="device" ? KBD_DEVICE : (field==="urgent" ? KBD_URGENT : KBD_MAIN);
      await tgAction(chatId, "typing");
      await tgSend(chatId, PROMPT[field], kbd);
      await setField(sheets, st.rowNum, head, "step", "ask_"+field);
    }
    // ---- РЕЖИМ ПРАВКИ (одного поля) ----
      if (String(step).startsWith("edit_")) {
        const field = String(step).slice(5); // edit_name -> name
        const val = (text || "").trim();
        if (!val) { await tgSend(chatId, "Введите значение."); res.status(200).send("ok"); return; }

  // мини-валидация для телефона
        if (field === "phone") {
          const s = val.replace(/\D+/g, "");
          const norm = (s.length===11 && (s[0]==="7"||s[0]==="8")) ? "+7"+s.slice(1) : (s.length===10 ? "+7"+s : null);
          if (!norm) { await tgSend(chatId, "Телефон не распознан. Формат: +7XXXXXXXXXX или 8XXXXXXXXXX."); res.status(200).send("ok"); return; }
          await setField(sheets, st.rowNum, head, "phone", norm);
        } else {
          await setField(sheets, st.rowNum, head, field, val);
        }

  // вернуться на подтверждение
        await setField(sheets, st.rowNum, head, "step", "confirm");
        const fresh = (await readAll(sheets, `DialogState!A${st.rowNum}:Z${st.rowNum}`))[0];
        await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
        res.status(200).send("ok"); return;
    }


    if (step === "ask_name") {
      if (!text) { await tgSend(chatId, "Введите имя."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "name", text); await ask("phone"); res.status(200).send("ok"); return;
    }
    if (step === "ask_phone") {
      const s = String(text||"").replace(/\D+/g, "");
      const norm = (s.length===11 && (s[0]==="7"||s[0]==="8")) ? "+7"+s.slice(1) : (s.length===10 ? "+7"+s : null);
      if (!norm) { await tgSend(chatId, "Телефон не распознан. Формат: +7XXXXXXXXXX или 8XXXXXXXXXX."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "phone", norm); await ask("company"); res.status(200).send("ok"); return;
    }
    if (step === "ask_company") {
      if (!text) { await tgSend(chatId, "Укажите название компании."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "company", text); await ask("device"); res.status(200).send("ok"); return;
    }
    if (step === "ask_device") {
      if (!text) { await tgSend(chatId, "Выберите устройство на клавиатуре или введите текстом."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "device", text); await ask("model"); res.status(200).send("ok"); return;
    }
    if (step === "ask_model") {
      if (!text) { await tgSend(chatId, "Укажите модель устройства/картриджа."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "model", text); await ask("issue"); res.status(200).send("ok"); return;
    }
    if (step === "ask_issue") {
      if (!text) { await tgSend(chatId, "Опишите проблему в 1–2 предложениях."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "issue", text); await ask("urgent"); res.status(200).send("ok"); return;
    }
    if (step === "ask_urgent") {
      const v = (text || "").toLowerCase();
      const ok = ["в течение дня","завтра","1–2 дня","1-2 дня"].some(k => v.includes(k));
      if (!ok) { await tgSend(chatId, "Выберите с клавиатуры: «В течение дня», «Завтра» или «1–2 дня»."); res.status(200).send("ok"); return; }
      const val = v.includes("в течение") ? "в течение дня" : (v.includes("завтра") ? "завтра" : "1–2 дня");
      await setField(sheets, st.rowNum, head, "urgent", val);
      const fresh = (await readAll(sheets, `DialogState!A${st.rowNum}:Z${st.rowNum}`))[0];
      await setField(sheets, st.rowNum, head, "step", "confirm");
      await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
      res.status(200).send("ok"); return;
    }
    if (step === "confirm") {
      await tgSend(chatId, "Нажмите «✅ Подтвердить» или «✏️ Исправить…» ниже.");
      res.status(200).send("ok"); return;
    }

    await tgSend(chatId, "Давайте начнём заново: /start");
    res.status(200).send("ok"); return;

  } catch (e) {
    console.error(e);
    // Даже в случае ошибки отвечаем 200, чтобы Telegram не спамил ретраями
    res.status(200).send("ok");
  }
}

export const config = { api: { bodyParser: true } };
