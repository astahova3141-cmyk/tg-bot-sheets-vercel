// api/tg.js — Telegram → Google Sheets + Voice (Deepgram), Node 18+ on Vercel

import { google } from "googleapis";
import { verifyTelegramSecret, dedupeUpdate, rateLimit, sanitizeCell, voiceAllowed } from "../security.js";
import { sanitizeCell } from "../security.js";


// ==== ENV
const BOT_TOKEN        = process.env.BOT_TOKEN || "";
const SHEET_ID         = process.env.SHEET_ID || "";
const WORK_CHAT_ID     = process.env.WORK_CHAT_ID || "";
const BOT_BANNER_URL   = process.env.BOT_BANNER_URL || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "";
const TG_SECRET_TOKEN  = process.env.TG_SECRET_TOKEN || ""; // тот же, что передаём в setWebhook

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

// === Files / voice
async function tgFileLink(fileId) {
  if (!BOT_TOKEN || !fileId) return null;
  const r = await fetch(`${TGBOT}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j = await r.json();
  const path = j?.result?.file_path;
  return path ? `https://api.telegram.org/file/bot${BOT_TOKEN}/${path}` : null;
}

async function transcribeVoiceFromTelegram(fileId, mime = "audio/ogg", lang = "ru") {
  if (!DEEPGRAM_API_KEY || !fileId) return null;
  const r1 = await fetch(`${TGBOT}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j1 = await r1.json();
  const path = j1?.result?.file_path;
  if (!path) return null;
  const tgFileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${path}`;
  const r2 = await fetch(tgFileUrl);
  if (!r2.ok) return null;
  const buf = await r2.arrayBuffer();

  const url = `https://api.deepgram.com/v1/listen?language=${encodeURIComponent(lang)}&smart_format=true&punctuate=true`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Token ${DEEPGRAM_API_KEY}`,
      "Content-Type": mime || "application/octet-stream"
    },
    body: Buffer.from(buf)
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
      "chat_id","step","name","phone","company",
      "service_type","model","issue","qty","devices_count",
      "delivery_deadline","repair_deadline","self_delivery",
      "voice_urls","voice_texts",
      "updated_at"
    ],
    Requests: [
      "date","name","phone","company",
      "service_type","model","issue","qty","devices_count",
      "delivery_deadline","repair_deadline","self_delivery",
      "voice_urls","voice_texts",
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

function colLetterFromIndex(idx) { return String.fromCharCode(65 + idx); }

// ==== UI
const PROMPT = {
  name:    "Как вас зовут? (Фамилия не обязательна) ✍️",
  phone:   "Укажите телефон (формат +7XXXXXXXXXX или 8XXXXXXXXXX) 📱",
  company: "Как называется компания? 🏢",

  service: "Что необходимо сделать? Выберите ниже ⤵️",
  model:   "Укажите модель устройства / картриджа (например: HP LaserJet Pro M404 / CF259A) 🧾",
  issue:   "Кратко опишите проблему (1–2 предложения) 🛠️",

  qty:               "Сколько штук? (только число) 🔢",
  devices_count:     "Сколько единиц техники? (только число) 🔢",
  delivery_deadline: "Когда нужна доставка? (например: сегодня/завтра/дата) 🚚",
  repair_deadline:   "К какому сроку нужен ремонт? (например: завтра/1–2 дня/дата) 🗓️",
  self_delivery:     "Для ускорения обработки вашей заявки вы можете самостоятельно доставить технику по адресу: г. Дубна, проспект Боголюбова, 15, офис 39.\nЕсть ли возможность доставить самостоятельно? ⤵️"
};
  // Сопоставление кнопок (с эмодзи) и «чистых» значений
const SERVICE_OPTIONS = [
  { btn: "🛒 Заказ картриджей",     key: "Заказ картриджей" },
  { btn: "🛠 Ремонт оргтехники",     key: "Ремонт оргтехники" },
  { btn: "🔄 Заправка картриджей",   key: "Заправка картриджей" },
  { btn: "🧑‍🔧 Вызвать мастера в офис", key: "Вызвать мастера в офис" }
];


const START_KBD = { keyboard: [[{ text: "▶️ Старт" }, { text: "❌ Отмена" }]], resize_keyboard: true };
const SERVICE_KBD = {
  keyboard: [
    [{ text: SERVICE_OPTIONS[0].btn }, { text: SERVICE_OPTIONS[1].btn }],
    [{ text: SERVICE_OPTIONS[2].btn }, { text: SERVICE_OPTIONS[3].btn }]
  ],
  resize_keyboard: true,
  one_time_keyboard: true
};
const YESNO_KBD = { keyboard: [[{ text: "Да" }, { text: "Нет" }]], resize_keyboard: true, one_time_keyboard: true };
const KBD_MAIN   = { keyboard: [[{ text: "❌ Отмена /stop" }]], resize_keyboard: true };

const YESNO_INLINE = { inline_keyboard: [[{text:"✅ Подтвердить", callback_data:"CONFIRM"}],[{text:"✏️ Исправить…", callback_data:"EDIT_MENU"}]] };
const EDIT_INLINE  = {
  inline_keyboard: [
    [{text:"👤 Имя", callback_data:"EDIT:name"}, {text:"📱 Телефон", callback_data:"EDIT:phone"}],
    [{text:"🏢 Компания", callback_data:"EDIT:company"}, {text:"🧭 Услуга", callback_data:"EDIT:service"}],
    [{text:"🧾 Модель", callback_data:"EDIT:model"}, {text:"🛠 Проблема", callback_data:"EDIT:issue"}],
    [{text:"🔢 Кол-во", callback_data:"EDIT:qty"}, {text:"🖨 Техники", callback_data:"EDIT:devices_count"}],
    [{text:"🚚 Срок дост.", callback_data:"EDIT:delivery_deadline"}, {text:"🗓️ Срок ремонта", callback_data:"EDIT:repair_deadline"}],
    [{text:"📦 Самодоставка", callback_data:"EDIT:self_delivery"}],
    [{text:"⬅️ Назад", callback_data:"BACK"}]
  ]
};
function makeSummary(state, idx) {
  const lines = [];
  lines.push("Проверьте заявку:\n");

  const add = (label, value) => {
    const v = (value || "").toString().trim();
    if (v) lines.push(`${label} ${v}`);
  };

  add("👤 Имя:", state[idx.name]);
  add("📱 Тел:", state[idx.phone]);
  add("🏢 Компания:", state[idx.company]);

  add("🧭 Услуга:", state[idx.service_type]);
  add("🧾 Модель:", state[idx.model]);
  add("🛠 Проблема:", state[idx.issue]);
  add("🔢 Кол-во (картриджи):", state[idx.qty]);
  add("🖨 Кол-во техники:", state[idx.devices_count]);
  add("🚚 Срок доставки:", state[idx.delivery_deadline]);
  add("🗓️ Срок ремонта:", state[idx.repair_deadline]);
  add("📦 Самодоставка:", state[idx.self_delivery]);

  add("🎧 Голос:", state[idx.voice_urls]);
  add("🗒 Текст голоса:", state[idx.voice_texts]);

  lines.push("\nВсё верно?");
  return lines.join("\n");
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
  // ВСТАВЛЯЕМ СТРОКУ ПОЛНОЙ ДЛИНЫ (16 колонок)
  await appendRow(sheets, "DialogState", [
    String(chatId), "ask_name", "", "", "",          // chat_id, step, name, phone, company
    "", "", "", "", "",                              // service_type, model, issue, qty, devices_count
    "", "", "",                                      // delivery_deadline, repair_deadline, self_delivery
    "", "",                                          // voice_urls, voice_texts
    new Date().toISOString()                         // updated_at
  ]);
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
       if (req.method !== "POST") { 
     res.status(200).send("ok"); 
     return; 
   }
 
   try {
     // 1) Верификация источника (Telegram)
     if (!verifyTelegramSecret(req, TG_SECRET_TOKEN)) {
       res.status(200).send("ok");
       return;
     }
     // 2) БЫСТРАЯ проверка дедупликации по update_id
     const prelimUpdate = req.body || {};
     if (await dedupeUpdate(prelimUpdate.update_id)) {
       res.status(200).send("ok");
       return;
     }

    const sheets = await getSheets();
    await ensureHeaders(sheets);

    const update = req.body || {};
    const cb  = update.callback_query || null;
    const msg = update.message || {};

    const chatId = cb ? cb.message?.chat?.id : msg.chat?.id;
    const text   = (msg.text || "").trim();
    const cbData = cb ? String(cb.data || "") : null;

 // 3) Рейт-лимит на чат (3 сек по умолчанию)
     if (await rateLimit(chatId, 2)) { // можно 2–3 сек
       res.status(200).send("ok");
       return;
     }


    // === CALLBACK-КНОПКИ ===
    if (cb) {
      const st = await findStateRow(sheets, chatId);
      const head = st.head, idx = st.idx;

      if (cbData === "CONFIRM") {
        const row = st.data;
        const vline = row[idx.voice_urls]  ? `\n🎧 Голос(а): ${row[idx.voice_urls]}`   : "";
        const tline = row[idx.voice_texts] ? `\n🗒 Текст(ы): ${row[idx.voice_texts]}` : "";
        await appendRow(sheets, "Requests", [
          new Date().toISOString(),
          sanitizeCell(row[idx.name]||""), sanitizeCell(row[idx.phone]||""), sanitizeCell(row[idx.company]||""),
          sanitizeCell(row[idx.service_type]||""), sanitizeCell(row[idx.model]||""), sanitizeCell(row[idx.issue]||""),
          sanitizeCell(row[idx.qty]||""), sanitizeCell(row[idx.devices_count]||""),
          sanitizeCell(row[idx.delivery_deadline]||""), sanitizeCell(row[idx.repair_deadline]||""), sanitizeCell(row[idx.self_delivery]||""),
          sanitizeCell(row[idx.voice_urls]||""), sanitizeCell(row[idx.voice_texts]||""),
          String(chatId), "", "new", "", "no", ""
        ]);
        if (WORK_CHAT_ID) {
          const card = [];
          const add = (label, value) => {
            const v = (value || "").toString().trim();
            if (v) card.push(`${label} ${v}`);
          };
          card.push("Новая заявка");
          add("👤", row[idx.name]);
          add("📱", row[idx.phone]);
          add("🏢", row[idx.company]);
          add("🧭", row[idx.service_type]);
          add("🧾", row[idx.model]);
          add("🛠", row[idx.issue]);
          add("🔢", row[idx.qty]);
          add("🖨", row[idx.devices_count]);
          add("🚚", row[idx.delivery_deadline]);
          add("🗓️", row[idx.repair_deadline]);
          add("📦", row[idx.self_delivery]);
          // Голос/транскрипт — тоже только если есть
          if ((row[idx.voice_urls] || "").toString().trim()) {
            card.push(`🎧 ${row[idx.voice_urls]}`);
          }
          if ((row[idx.voice_texts] || "").toString().trim()) {
            card.push(`🗒 ${row[idx.voice_texts]}`);
          }
          await tgSend(WORK_CHAT_ID, card.join("\n"));
        }

        await setField(sheets, st.rowNum, head, "step", "done");
        await tgSend(chatId, "Спасибо! Заявка принята. Менеджер свяжется с вами в ближайшее время. 🙌");
        res.status(200).send("ok"); return;
      }

      if (cbData === "EDIT_MENU") {
        await tgSend(chatId, "🧭 Услуга?", EDIT_INLINE);
        res.status(200).send("ok"); return;
      }

      if (cbData === "BACK") {
        await setField(sheets, st.rowNum, head, "step", "confirm");
        const fresh = (await readAll(sheets, `DialogState!A${st.rowNum}:Z${st.rowNum}`))[0];
        await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
        res.status(200).send("ok"); return;
      }

      if (cbData && cbData.startsWith("EDIT:")) {
        const field = cbData.split(":")[1]; // name/phone/company/service/model/...
        await setField(sheets, st.rowNum, head, "step", "edit_"+field);
        // правильная клавиатура для конкретного поля
        let kbd = KBD_MAIN;
        if (field === "service") kbd = SERVICE_KBD;
        if (field === "self_delivery") kbd = YESNO_KBD;
        await tgSend(chatId, PROMPT[field] || "Введите значение:", kbd);
        res.status(200).send("ok"); return;
      }

      res.status(200).send("ok"); return;
    }

    // === VOICE ===
  
    if (msg.voice && msg.voice.file_id) {
      if (!voiceAllowed(msg, 60)) { // до 60 сек
        await tgSend(chatId, "Голосовое слишком длинное (максимум 60 секунд).");
        res.status(200).send("ok"); return;
      }
       await tgAction(chatId, "record_voice");

      await tgAction(chatId, "record_voice");
      const fileId = msg.voice.file_id;
      const mime   = msg.voice.mime_type || "audio/ogg";
      const st0 = await findStateRow(sheets, chatId);
      const head0 = st0.head, idx0 = st0.idx;

      const link = await tgFileLink(fileId);
      let transcript = null;
      try { transcript = await transcribeVoiceFromTelegram(fileId, mime, "ru"); } catch (_) {}

      const prevUrls  = (st0.data[idx0.voice_urls]  || "").trim();
      const prevTexts = (st0.data[idx0.voice_texts] || "").trim();
      const newUrls  = link ? (prevUrls ? prevUrls + "\n" + link : link) : prevUrls;
      const newTexts = transcript ? (prevTexts ? prevTexts + "\n" + transcript : transcript) : prevTexts;
      
      if (newUrls !== prevUrls)   await setField(sheets, st0.rowNum, head0, "voice_urls", sanitizeCell(newUrls));
      if (newTexts !== prevTexts) await setField(sheets, st0.rowNum, head0, "voice_texts", sanitizeCell(newTexts));


      await tgSend(chatId, transcript
        ? "🎙 Голосовое прикрепил к заявке.\n🗒 Текст распознан и сохранён."
        : "🎙 Голосовое прикрепил к заявке. Распознать не удалось, но ссылка сохранена."
      );
    }

    // === Команды ===
    if (text === "/ping") { await tgSend(chatId, "ALIVE ✅"); res.status(200).send("ok"); return; }
    if (text === "/help") { await tgSend(chatId, "Команды:\n/start — начать заново\n/stop — отменить\n/id — ваш Chat ID\n/help — помощь"); res.status(200).send("ok"); return; }
    if (text === "/id")   { await tgSend(chatId, "Chat ID: " + chatId); res.status(200).send("ok"); return; }

    if (text === "/stop" || text === "❌ Отмена") {
      const st = await findStateRow(sheets, chatId);
      await setField(sheets, st.rowNum, st.head, "step", "stopped");
      await tgSend(chatId, "Ок, остановил. Чтобы начать заново — /start", START_KBD);
      res.status(200).send("ok"); return;
    }

    if (text === "/start") {
      const st = await findStateRow(sheets, chatId);
      // очистка всех полей сценария
      for (const f of ["name","phone","company","service_type","model","issue","qty","devices_count","delivery_deadline","repair_deadline","self_delivery","voice_urls","voice_texts"]) {
        await setField(sheets, st.rowNum, st.head, f, "");
      }
      await setField(sheets, st.rowNum, st.head, "step", "wait_start");
      const about = "Здравствуйте! Я бот приёма заявок по обслуживанию оргтехники.\nНажмите «Старт», чтобы начать, либо «Отмена».";
      if (BOT_BANNER_URL) await tgPhoto(chatId, BOT_BANNER_URL, about, START_KBD);
      else await tgSend(chatId, about, START_KBD);
      res.status(200).send("ok"); return;
    }

    if (text === "▶️ Старт") {
      const st = await findStateRow(sheets, chatId);
      await setField(sheets, st.rowNum, st.head, "step", "ask_name");
      await tgSend(chatId, PROMPT.name);
      res.status(200).send("ok"); return;
    }

    // === Диалог ===
    const st = await findStateRow(sheets, chatId);
    const head = st.head, idx = st.idx;
    const step = st.data[idx["step"]] || "ask_name";

    // Режим правки одного поля
    if (String(step).startsWith("edit_")) {
      const field = String(step).slice(5); // edit_name -> name / service / ...
      const rawVal = (text || "").trim();
      if (!rawVal) { await tgSend(chatId, "Введите значение."); res.status(200).send("ok"); return; }

      let targetField = field;
      let val = rawVal;

      if (field === "phone") {
        const s = val.replace(/\D+/g, "");
        const norm = (s.length===11 && (s[0]==="7"||s[0]==="8")) ? "+7"+s.slice(1) : (s.length===10 ? "+7"+s : null);
        if (!norm) { await tgSend(chatId, "Телефон не распознан. Формат: +7XXXXXXXXXX или 8XXXXXXXXXX."); res.status(200).send("ok"); return; }
        val = norm;
      }
      if (field === "service") { targetField = "service_type"; }
      if (field === "self_delivery") {
        const v = val.toLowerCase(); val = v.includes("да") ? "Да" : v.includes("нет") ? "Нет" : val;
      }
      if (field === "qty" || field === "devices_count") {
        const n = parseInt(val, 10); if (!(n>0)) { await tgSend(chatId, "Введите положительное число."); res.status(200).send("ok"); return; }
        val = String(n);
      }
      await setField(sheets, st.rowNum, head, targetField, sanitizeCell(val));
      await setField(sheets, st.rowNum, head, "step", "confirm");
      const fresh = (await readAll(sheets, `DialogState!A${st.rowNum}:Z${st.rowNum}`))[0];
      await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
      res.status(200).send("ok"); return;
    }

    // Хелпер вопроса
    async function ask(field) {
      let kbd = KBD_MAIN;
      if (field === "service") kbd = SERVICE_KBD;
      else if (field === "self_delivery") kbd = YESNO_KBD;
      await tgAction(chatId, "typing");
      await tgSend(chatId, PROMPT[field], kbd);
      await setField(sheets, st.rowNum, head, "step", "ask_"+field);
    }

    // Шаги
    if (step === "ask_name") {
      if (!text) { await tgSend(chatId, "Введите имя."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "name", sanitizeCell(text)); await ask("phone"); res.status(200).send("ok"); return;
    }
    if (step === "ask_phone") {
      const s = String(text||"").replace(/\D+/g, "");
      const norm = (s.length===11 && (s[0]==="7"||s[0]==="8")) ? "+7"+s.slice(1) : (s.length===10 ? "+7"+s : null);
      if (!norm) { await tgSend(chatId, "Телефон не распознан. Формат: +7XXXXXXXXXX или 8XXXXXXXXXX."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "phone", sanitizeCell(norm)); await ask("company"); res.status(200).send("ok"); return;
    }
    if (step === "ask_company") {
      if (!text) { await tgSend(chatId, "Укажите название компании."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "company", sanitizeCell(text));
      await ask("service"); res.status(200).send("ok"); return; // ← исправлено: к выбору услуги
    }
    if (step === "ask_service") {
      const v = (text || "").trim();
      // ищем по включению «чистого» ключа — эмодзи не помеха
      const opt = SERVICE_OPTIONS.find(o => v.includes(o.key));
      if (!opt) {
        await tgSend(chatId, "Выберите вариант на клавиатуре.", SERVICE_KBD);
        res.status(200).send("ok"); return;
      }
      await setField(sheets, st.rowNum, head, "service_type", sanitizeCell(opt.key));

      if (opt.key === "Вызвать мастера в офис") {
        await ask("issue");
      } else {
        await ask("model");
      }
      res.status(200).send("ok"); return;
    }
    if (step === "ask_model") {
      if (!text) { await tgSend(chatId, "Укажите модель устройства/картриджа."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "model", sanitizeCell(text));
      const service = st.data[idx["service_type"]];
      if (service === "Заказ картриджей")       await ask("qty");
      else if (service === "Заправка картриджей") await ask("qty");
      else if (service === "Ремонт оргтехники")   await ask("issue");
      else                                         await ask("issue");
      res.status(200).send("ok"); return;
    }
    if (step === "ask_qty") {
      const n = parseInt(String(text||"").trim(), 10);
      if (!(n > 0)) { await tgSend(chatId, "Введите положительное число."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "qty", sanitizeCell(String(n)));
      const service = st.data[idx["service_type"]];
      if (service === "Заказ картриджей")      await ask("delivery_deadline");
      else if (service === "Заправка картриджей") await ask("self_delivery");
      else                                      await ask("issue");
      res.status(200).send("ok"); return;
    }
    if (step === "ask_issue") {
      if (!text) { await tgSend(chatId, "Опишите проблему в 1–2 предложениях."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "issue", sanitizeCell(text));
      const service = st.data[idx["service_type"]];
      if (service === "Ремонт оргтехники") {
        await ask("devices_count");
      } else if (service === "Вызвать мастера в офис") {
        await setField(sheets, st.rowNum, head, "step", "confirm");
        const fresh = (await readAll(sheets, `DialogState!A${st.rowNum}:Z${st.rowNum}`))[0];
        await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
      }
      res.status(200).send("ok"); return;
    }
    if (step === "ask_devices_count") {
      const n = parseInt(String(text||"").trim(), 10);
      if (!(n > 0)) { await tgSend(chatId, "Введите положительное число."); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "devices_count", sanitizeCell(String(n)));
      await ask("repair_deadline");
      res.status(200).send("ok"); return;
    }
    if (step === "ask_delivery_deadline") {
      await setField(sheets, st.rowNum, head, "delivery_deadline", sanitizeCell((text||"").trim()));
      await setField(sheets, st.rowNum, head, "step", "confirm");
      const fresh = (await readAll(sheets, `DialogState!A${st.rowNum}:Z${st.rowNum}`))[0];
      await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
      res.status(200).send("ok"); return;
    }
    if (step === "ask_repair_deadline") {
      await setField(sheets, st.rowNum, head, "repair_deadline", sanitizeCell((text||"").trim()));
      await ask("self_delivery");
      res.status(200).send("ok"); return;
    }
    if (step === "ask_self_delivery") {
      const v = (text||"").toLowerCase();
      const val = v.includes("да") ? "Да" : v.includes("нет") ? "Нет" : null;
      if (!val) { await tgSend(chatId, "Выберите «Да» или «Нет».", YESNO_KBD); res.status(200).send("ok"); return; }
      await setField(sheets, st.rowNum, head, "self_delivery", sanitizeCell(val));
      await setField(sheets, st.rowNum, head, "step", "confirm");
      const fresh = (await readAll(sheets, `DialogState!A${st.rowNum}:Z${st.rowNum}`))[0];
      await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
      res.status(200).send("ok"); return;
    }

    if (step === "confirm") {
      await tgSend(chatId, "Нажмите «✅ Подтвердить» или «✏️ Исправить…» ниже.");
      res.status(200).send("ok"); return;
    }

    // дефолт
    await tgSend(chatId, "Давайте начнём заново: /start");
    res.status(200).send("ok"); return;

  } catch (e) {
    console.error(e);
    res.status(200).send("ok"); return;
  }
}

export const config = { api: { bodyParser: true } };
