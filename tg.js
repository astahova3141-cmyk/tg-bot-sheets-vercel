// api/tg.js (Vercel serverless function)
import fetch from "node-fetch";
import { google } from "googleapis";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID  = process.env.SHEET_ID;
const WORK_CHAT_ID = process.env.WORK_CHAT_ID || "";
const BOT_BANNER_URL = process.env.BOT_BANNER_URL || "";

const TGBOT = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ===== Telegram helpers =====
const tgSend = (chat_id, text, reply_markup) =>
  fetch(`${TGBOT}/sendMessage`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id, text, reply_markup })
  });

const tgPhoto = (chat_id, photo, caption, reply_markup) =>
  fetch(`${TGBOT}/sendPhoto`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ chat_id, photo, caption, reply_markup })
  });

// ===== Google Sheets (через SA из env) =====
async function getSheets(){
  const credentials = {
    client_email: process.env.GCP_CLIENT_EMAIL,
    private_key: (process.env.GCP_PRIVATE_KEY || "").replace(/\\n/g, "\n").replace(/\r/g, "")
  };
  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth });
  return sheets;
}

async function ensureHeaders(sheets){
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const titles = (meta.data.sheets || []).map(s => s.properties.title);

  async function ensureSheet(name, headers){
    if (!titles.includes(name)){
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests:[{ addSheet:{ properties:{ title:name } } }] }
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${name}!A1:${String.fromCharCode(64+headers.length)}1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
    } else {
      const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${name}!1:1` });
      const row = resp.data.values?.[0] || [];
      if (row.length === 0){
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${name}!A1:${String.fromCharCode(64+headers.length)}1`,
          valueInputOption: "RAW",
          requestBody: { values: [headers] }
        });
      }
    }
  }

  await ensureSheet("DialogState", ["chat_id","step","name","phone","company","device","model","issue","urgent","updated_at"]);
  await ensureSheet("Requests",    ["date","name","phone","company","device","model","issue","urgent","chat_id","ticket_id","status","yougile_link","notified","closed_at"]);
}

async function readAll(sheets, range){
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
  return resp.data.values || [];
}
async function appendRow(sheets, sheet, row){
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}
async function updateCell(sheets, sheet, row, colLetter, value){
  const range = `${sheet}!${colLetter}${row}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID, range, valueInputOption:"RAW",
    requestBody: { values: [[value]] }
  });
}

const PROMPT = {
  name:    "Как вас зовут? (Фамилия не обязательна) ✍️",
  phone:   "Укажите телефон (формат +7XXXXXXXXXX или 8XXXXXXXXXX) 📱",
  company: "Как называется компания? 🏢",
  device:  "Какое устройство? Выберите ниже ⤵️",
  model:   "Модель устройства / картриджа (например: HP LaserJet Pro M404 / CF259A) 🧾",
  issue:   "Кратко опишите проблему (1–2 предложения) 🛠️",
  urgent:  "Срочность ремонта? Выберите вариант ниже ⤵️"
};
const KBD_MAIN = { keyboard: [[{text:"❌ Отмена /stop"}]], resize_keyboard: true };
const KBD_DEVICE = {
  keyboard: [[{text:"🖨 Принтер"},{text:"🖨 МФУ"},{text:"📠 Копир"}],[{text:"🧰 Другое"}]],
  resize_keyboard:true, one_time_keyboard:true
};
const KBD_URGENT = {
  keyboard: [[{text:"⏱ В течение дня"},{text:"📅 Завтра"}],[{text:"🕑 1–2 дня"}]],
  resize_keyboard:true, one_time_keyboard:true
};
const YESNO_INLINE = {
  inline_keyboard: [
    [{text:"✅ Подтвердить", callback_data:"CONFIRM"}],
    [{text:"✏️ Исправить…", callback_data:"EDIT_MENU"}]
  ]
};
const EDIT_INLINE = {
  inline_keyboard: [
    [{text:"👤 Имя", callback_data:"EDIT:name"}, {text:"📱 Телефон", callback_data:"EDIT:phone"}],
    [{text:"🏢 Компания", callback_data:"EDIT:company"}, {text:"🖨 Устройство", callback_data:"EDIT:device"}],
    [{text:"🧾 Модель", callback_data:"EDIT:model"}, {text:"🛠 Проблема", callback_data:"EDIT:issue"}],
    [{text:"⏳ Срочность", callback_data:"EDIT:urgent"}],
    [{text:"⬅️ Назад", callback_data:"BACK"}]
  ]
};

async function findStateRow(sheets, chatId){
  const rows = await readAll(sheets, "DialogState!A:Z");
  const head = rows[0] || [];
  let idx = {}; head.forEach((h,i)=> idx[h]=i);
  for (let r=1; r<rows.length; r++){
    if (String(rows[r][idx["chat_id"]||0]) === String(chatId))
      return { rowNum: r+1, data: rows[r], idx, head };
  }
  await appendRow(sheets, "DialogState", [String(chatId),"ask_name","","","","","","","", new Date().toISOString()]);
  const fresh = await readAll(sheets, "DialogState!A:Z");
  return { rowNum: fresh.length, data: fresh[fresh.length-1], idx, head };
}
async function setField(sheets, rowNum, head, field, value){
  const colIdx = head.indexOf(field); if (colIdx<0) return;
  const colLetter = String.fromCharCode(65 + colIdx);
  await updateCell(sheets, "DialogState", rowNum, colLetter, value);
  const updIdx = head.indexOf("updated_at");
  if (updIdx >= 0){
    const updCol = String.fromCharCode(65 + updIdx);
    await updateCell(sheets, "DialogState", rowNum, updCol, new Date().toISOString());
  }
}
function makeSummary(state, idx){
  return `Проверьте заявку:

👤 Имя: ${state[idx.name]||""}
📱 Тел: ${state[idx.phone]||""}
🏢 Компания: ${state[idx.company]||""}
🖨 Устройство: ${state[idx.device]||""}
🧾 Модель: ${state[idx.model]||""}
🛠 Проблема: ${state[idx.issue]||""}
⏳ Срочность: ${state[idx.urgent]||""}

Всё верно?`;
}

// ==== Vercel handler ====
export default async function handler(req, res){
  res.status(200).send("ok");
  try{
    if (req.method !== "POST") return;

    const update = req.body;
    const sheets = await getSheets();
    await ensureHeaders(sheets);

    if (update.callback_query){
      const chatId = update.callback_query.message.chat.id;
      const data   = String(update.callback_query.data || "");
      const st = await findStateRow(sheets, chatId);
      const head = st.head, idx = st.idx;

      if (data === "CONFIRM"){
        const row = st.data;
        await appendRow(sheets, "Requests", [
          new Date().toISOString(),
          row[idx.name]||"", row[idx.phone]||"", row[idx.company]||"",
          row[idx.device]||"", row[idx.model]||"", row[idx.issue]||"", row[idx.urgent]||"",
          String(chatId), "", "new", "", "no", ""
        ]);
        if (WORK_CHAT_ID){
          await tgSend(WORK_CHAT_ID,
`Новая заявка
👤 ${row[idx.name]||""}
📱 ${row[idx.phone]||""}
🏢 ${row[idx.company]||""}
🖨 ${row[idx.device]||""}
🧾 ${row[idx.model]||""}
🛠 ${row[idx.issue]||""}
⏳ ${row[idx.urgent]||""}`);
        }
        await setField(sheets, st.rowNum, head, "step", "done");
        await tgSend(chatId, "Спасибо! Заявка принята. Менеджер свяжется с вами в ближайшее время. 🙌");
        return;
      }
      if (data === "EDIT_MENU"){ await tgSend(chatId, "Что исправим?", EDIT_INLINE); return; }
      if (data === "BACK"){
        await setField(sheets, st.rowNum, head, "step", "confirm");
        const fresh = (await readAll(sheets, f"DialogState!A{st.rowNum}:Z{st.rowNum}"))[0];
        await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
        return;
      }
      if (data.startsWith("EDIT:")){
        const field = data.split(":")[1];
        await setField(sheets, st.rowNum, head, "step", "ask_"+field);
        const kbd = field==="device" ? KBD_DEVICE : (field==="urgent" ? KBD_URGENT : KBD_MAIN);
        const prompt = PROMPT[field] || "Введите значение:";
        await tgSend(chatId, prompt, kbd);
        return;
      }
      return;
    }

    if (update.message){
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      if (text === "/ping"){ await tgSend(chatId, "ALIVE ✅"); return; }
      if (text === "/help"){ await tgSend(chatId, "Команды:\n/start — начать заново\n/stop — отменить\n/id — ваш Chat ID\n/help — помощь"); return; }
      if (text === "/id"){ await tgSend(chatId, "Chat ID: " + chatId); return; }
      if (text === "/stop"){
        const st = await findStateRow(sheets, chatId);
        await setField(sheets, st.rowNum, st.head, "step", "stopped");
        await tgSend(chatId, "Ок, остановил. Чтобы начать заново — /start");
        return;
      }
      if (text === "/start"){
        const st = await findStateRow(sheets, chatId);
        for (const f of ["name","phone","company","device","model","issue","urgent"]){
          await setField(sheets, st.rowNum, st.head, f, "");
        }
        await setField(sheets, st.rowNum, st.head, "step", "ask_name");
        const about = "Здравствуйте! Я бот приёма заявок по обслуживанию оргтехники.\nСоберу заявку и передам специалистам. Это займёт 1–2 минуты.";
        if (BOT_BANNER_URL) await tgPhoto(chatId, BOT_BANNER_URL, about);
        else await tgSend(chatId, about);
        await tgSend(chatId, PROMPT.name, KBD_MAIN);
        return;
      }

      const st = await findStateRow(sheets, chatId);
      const head = st.head, idx = st.idx;
      const step = (st.data[idx["step"]] || "ask_name");

      function ask(field){
        const kbd = field==="device" ? KBD_DEVICE : (field==="urgent" ? KBD_URGENT : KBD_MAIN);
        return tgSend(chatId, PROMPT[field], kbd)
          .then(()=> setField(sheets, st.rowNum, head, "step", "ask_"+field));
      }

      if (step === "ask_name"){
        if (!text){ await tgSend(chatId,"Введите имя."); return; }
        await setField(sheets, st.rowNum, head, "name", text);
        await ask("phone"); return;
      }
      if (step === "ask_phone"){
        const s = String(text||"").replace(/\D+/g,"");
        const norm = (s.length===11 && (s[0]==="7"||s[0]==="8")) ? "+7"+s.slice(1) : (s.length===10 ? "+7"+s : null);
        if (!norm){ await tgSend(chatId,"Телефон не распознан. Формат: +7XXXXXXXXXX или 8XXXXXXXXXX."); return; }
        await setField(sheets, st.rowNum, head, "phone", norm);
        await ask("company"); return;
      }
      if (step === "ask_company"){
        if (!text){ await tgSend(chatId,"Укажите название компании."); return; }
        await setField(sheets, st.rowNum, head, "company", text);
        await ask("device"); return;
      }
      if (step === "ask_device"){
        if (!text){ await tgSend(chatId,"Выберите устройство на клавиатуре или введите текстом."); return; }
        await setField(sheets, st.rowNum, head, "device", text);
        await ask("model"); return;
      }
      if (step === "ask_model"){
        if (!text){ await tgSend(chatId,"Укажите модель устройства/картриджа."); return; }
        await setField(sheets, st.rowNum, head, "model", text);
        await ask("issue"); return;
      }
      if (step === "ask_issue"){
        if (!text){ await tgSend(chatId,"Опишите проблему в 1–2 предложениях."); return; }
        await setField(sheets, st.rowNum, head, "issue", text);
        await ask("urgent"); return;
      }
      if (step === "ask_urgent"){
        const v = text.toLowerCase();
        const ok = ["в течение дня","завтра","1–2 дня","1-2 дня"].some(k => v.includes(k));
        if (!ok){ await tgSend(chatId,"Выберите с клавиатуры: «В течение дня», «Завтра» или «1–2 дня»."); return; }
        const val = v.includes("в течение") ? "в течение дня" : (v.includes("завтра") ? "завтра" : "1–2 дня");
        await setField(sheets, st.rowNum, head, "urgent", val);
        const fresh = (await readAll(sheets, f"DialogState!A{st.rowNum}:Z{st.rowNum}"))[0];
        await setField(sheets, st.rowNum, head, "step", "confirm");
        await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
        return;
      }
      if (step === "confirm"){
        await tgSend(chatId, "Нажмите «✅ Подтвердить» или «✏️ Исправить…» ниже.");
        return;
      }
      if (String(step).startsWith("ask_") || String(step).startsWith("edit_")){
        const field = step.replace(/^ask_|^edit_/, "");
        if (!text){ await tgSend(chatId,"Введите значение."); return; }
        await setField(sheets, st.rowNum, head, field, text);
        await setField(sheets, st.rowNum, head, "step", "confirm");
        await tgSend(chatId, "Обновил поле. Проверьте заявку ещё раз.", YESNO_INLINE);
        return;
      }

      await tgSend(chatId, "Давайте начнём заново: /start");
    }
  } catch(e){
    console.error(e);
  }
}

export const config = { api: { bodyParser: true } };
