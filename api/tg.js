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

// ===== Google Sheets (Ñ‡ÐµÑ€ÐµÐ· SA Ð¸Ð· env) =====
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
  name:    "ÐšÐ°Ðº Ð²Ð°Ñ Ð·Ð¾Ð²ÑƒÑ‚? (Ð¤Ð°Ð¼Ð¸Ð»Ð¸Ñ Ð½Ðµ Ð¾Ð±ÑÐ·Ð°Ñ‚ÐµÐ»ÑŒÐ½Ð°) âœï¸",
  phone:   "Ð£ÐºÐ°Ð¶Ð¸Ñ‚Ðµ Ñ‚ÐµÐ»ÐµÑ„Ð¾Ð½ (Ñ„Ð¾Ñ€Ð¼Ð°Ñ‚ +7XXXXXXXXXX Ð¸Ð»Ð¸ 8XXXXXXXXXX) ðŸ“±",
  company: "ÐšÐ°Ðº Ð½Ð°Ð·Ñ‹Ð²Ð°ÐµÑ‚ÑÑ ÐºÐ¾Ð¼Ð¿Ð°Ð½Ð¸Ñ? ðŸ¢",
  device:  "ÐšÐ°ÐºÐ¾Ðµ ÑƒÑÑ‚Ñ€Ð¾Ð¹ÑÑ‚Ð²Ð¾? Ð’Ñ‹Ð±ÐµÑ€Ð¸Ñ‚Ðµ Ð½Ð¸Ð¶Ðµ â¤µï¸",
  model:   "ÐœÐ¾Ð´ÐµÐ»ÑŒ ÑƒÑÑ‚Ñ€Ð¾Ð¹ÑÑ‚Ð²Ð° / ÐºÐ°Ñ€Ñ‚Ñ€Ð¸Ð´Ð¶Ð° (Ð½Ð°Ð¿Ñ€Ð¸Ð¼ÐµÑ€: HP LaserJet Pro M404 / CF259A) ðŸ§¾",
  issue:   "ÐšÑ€Ð°Ñ‚ÐºÐ¾ Ð¾Ð¿Ð¸ÑˆÐ¸Ñ‚Ðµ Ð¿Ñ€Ð¾Ð±Ð»ÐµÐ¼Ñƒ (1â€“2 Ð¿Ñ€ÐµÐ´Ð»Ð¾Ð¶ÐµÐ½Ð¸Ñ) ðŸ› ï¸",
  urgent:  "Ð¡Ñ€Ð¾Ñ‡Ð½Ð¾ÑÑ‚ÑŒ Ñ€ÐµÐ¼Ð¾Ð½Ñ‚Ð°? Ð’Ñ‹Ð±ÐµÑ€Ð¸Ñ‚Ðµ Ð²Ð°Ñ€Ð¸Ð°Ð½Ñ‚ Ð½Ð¸Ð¶Ðµ â¤µï¸"
};
const KBD_MAIN = { keyboard: [[{text:"âŒ ÐžÑ‚Ð¼ÐµÐ½Ð° /stop"}]], resize_keyboard: true };
const KBD_DEVICE = {
  keyboard: [[{text:"ðŸ–¨ ÐŸÑ€Ð¸Ð½Ñ‚ÐµÑ€"},{text:"ðŸ–¨ ÐœÐ¤Ð£"},{text:"ðŸ“  ÐšÐ¾Ð¿Ð¸Ñ€"}],[{text:"ðŸ§° Ð”Ñ€ÑƒÐ³Ð¾Ðµ"}]],
  resize_keyboard:true, one_time_keyboard:true
};
const KBD_URGENT = {
  keyboard: [[{text:"â± Ð’ Ñ‚ÐµÑ‡ÐµÐ½Ð¸Ðµ Ð´Ð½Ñ"},{text:"ðŸ“… Ð—Ð°Ð²Ñ‚Ñ€Ð°"}],[{text:"ðŸ•‘ 1â€“2 Ð´Ð½Ñ"}]],
  resize_keyboard:true, one_time_keyboard:true
};
const YESNO_INLINE = {
  inline_keyboard: [
    [{text:"âœ… ÐŸÐ¾Ð´Ñ‚Ð²ÐµÑ€Ð´Ð¸Ñ‚ÑŒ", callback_data:"CONFIRM"}],
    [{text:"âœï¸ Ð˜ÑÐ¿Ñ€Ð°Ð²Ð¸Ñ‚ÑŒâ€¦", callback_data:"EDIT_MENU"}]
  ]
};
const EDIT_INLINE = {
  inline_keyboard: [
    [{text:"ðŸ‘¤ Ð˜Ð¼Ñ", callback_data:"EDIT:name"}, {text:"ðŸ“± Ð¢ÐµÐ»ÐµÑ„Ð¾Ð½", callback_data:"EDIT:phone"}],
    [{text:"ðŸ¢ ÐšÐ¾Ð¼Ð¿Ð°Ð½Ð¸Ñ", callback_data:"EDIT:company"}, {text:"ðŸ–¨ Ð£ÑÑ‚Ñ€Ð¾Ð¹ÑÑ‚Ð²Ð¾", callback_data:"EDIT:device"}],
    [{text:"ðŸ§¾ ÐœÐ¾Ð´ÐµÐ»ÑŒ", callback_data:"EDIT:model"}, {text:"ðŸ›  ÐŸÑ€Ð¾Ð±Ð»ÐµÐ¼Ð°", callback_data:"EDIT:issue"}],
    [{text:"â³ Ð¡Ñ€Ð¾Ñ‡Ð½Ð¾ÑÑ‚ÑŒ", callback_data:"EDIT:urgent"}],
    [{text:"â¬…ï¸ ÐÐ°Ð·Ð°Ð´", callback_data:"BACK"}]
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
  return `ÐŸÑ€Ð¾Ð²ÐµÑ€ÑŒÑ‚Ðµ Ð·Ð°ÑÐ²ÐºÑƒ:

ðŸ‘¤ Ð˜Ð¼Ñ: ${state[idx.name]||""}
ðŸ“± Ð¢ÐµÐ»: ${state[idx.phone]||""}
ðŸ¢ ÐšÐ¾Ð¼Ð¿Ð°Ð½Ð¸Ñ: ${state[idx.company]||""}
ðŸ–¨ Ð£ÑÑ‚Ñ€Ð¾Ð¹ÑÑ‚Ð²Ð¾: ${state[idx.device]||""}
ðŸ§¾ ÐœÐ¾Ð´ÐµÐ»ÑŒ: ${state[idx.model]||""}
ðŸ›  ÐŸÑ€Ð¾Ð±Ð»ÐµÐ¼Ð°: ${state[idx.issue]||""}
â³ Ð¡Ñ€Ð¾Ñ‡Ð½Ð¾ÑÑ‚ÑŒ: ${state[idx.urgent]||""}

Ð’ÑÑ‘ Ð²ÐµÑ€Ð½Ð¾?`;
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
`ÐÐ¾Ð²Ð°Ñ Ð·Ð°ÑÐ²ÐºÐ°
ðŸ‘¤ ${row[idx.name]||""}
ðŸ“± ${row[idx.phone]||""}
ðŸ¢ ${row[idx.company]||""}
ðŸ–¨ ${row[idx.device]||""}
ðŸ§¾ ${row[idx.model]||""}
ðŸ›  ${row[idx.issue]||""}
â³ ${row[idx.urgent]||""}`);
        }
        await setField(sheets, st.rowNum, head, "step", "done");
        await tgSend(chatId, "Ð¡Ð¿Ð°ÑÐ¸Ð±Ð¾! Ð—Ð°ÑÐ²ÐºÐ° Ð¿Ñ€Ð¸Ð½ÑÑ‚Ð°. ÐœÐµÐ½ÐµÐ´Ð¶ÐµÑ€ ÑÐ²ÑÐ¶ÐµÑ‚ÑÑ Ñ Ð²Ð°Ð¼Ð¸ Ð² Ð±Ð»Ð¸Ð¶Ð°Ð¹ÑˆÐµÐµ Ð²Ñ€ÐµÐ¼Ñ. ðŸ™Œ");
        return;
      }
      if (data === "EDIT_MENU"){ await tgSend(chatId, "Ð§Ñ‚Ð¾ Ð¸ÑÐ¿Ñ€Ð°Ð²Ð¸Ð¼?", EDIT_INLINE); return; }
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
        const prompt = PROMPT[field] || "Ð’Ð²ÐµÐ´Ð¸Ñ‚Ðµ Ð·Ð½Ð°Ñ‡ÐµÐ½Ð¸Ðµ:";
        await tgSend(chatId, prompt, kbd);
        return;
      }
      return;
    }

    if (update.message){
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      if (text === "/ping"){ await tgSend(chatId, "ALIVE âœ…"); return; }
      if (text === "/help"){ await tgSend(chatId, "ÐšÐ¾Ð¼Ð°Ð½Ð´Ñ‹:\n/start â€” Ð½Ð°Ñ‡Ð°Ñ‚ÑŒ Ð·Ð°Ð½Ð¾Ð²Ð¾\n/stop â€” Ð¾Ñ‚Ð¼ÐµÐ½Ð¸Ñ‚ÑŒ\n/id â€” Ð²Ð°Ñˆ Chat ID\n/help â€” Ð¿Ð¾Ð¼Ð¾Ñ‰ÑŒ"); return; }
      if (text === "/id"){ await tgSend(chatId, "Chat ID: " + chatId); return; }
      if (text === "/stop"){
        const st = await findStateRow(sheets, chatId);
        await setField(sheets, st.rowNum, st.head, "step", "stopped");
        await tgSend(chatId, "ÐžÐº, Ð¾ÑÑ‚Ð°Ð½Ð¾Ð²Ð¸Ð». Ð§Ñ‚Ð¾Ð±Ñ‹ Ð½Ð°Ñ‡Ð°Ñ‚ÑŒ Ð·Ð°Ð½Ð¾Ð²Ð¾ â€” /start");
        return;
      }
      if (text === "/start"){
        const st = await findStateRow(sheets, chatId);
        for (const f of ["name","phone","company","device","model","issue","urgent"]){
          await setField(sheets, st.rowNum, st.head, f, "");
        }
        await setField(sheets, st.rowNum, st.head, "step", "ask_name");
        const about = "Ð—Ð´Ñ€Ð°Ð²ÑÑ‚Ð²ÑƒÐ¹Ñ‚Ðµ! Ð¯ Ð±Ð¾Ñ‚ Ð¿Ñ€Ð¸Ñ‘Ð¼Ð° Ð·Ð°ÑÐ²Ð¾Ðº Ð¿Ð¾ Ð¾Ð±ÑÐ»ÑƒÐ¶Ð¸Ð²Ð°Ð½Ð¸ÑŽ Ð¾Ñ€Ð³Ñ‚ÐµÑ…Ð½Ð¸ÐºÐ¸.\nÐ¡Ð¾Ð±ÐµÑ€Ñƒ Ð·Ð°ÑÐ²ÐºÑƒ Ð¸ Ð¿ÐµÑ€ÐµÐ´Ð°Ð¼ ÑÐ¿ÐµÑ†Ð¸Ð°Ð»Ð¸ÑÑ‚Ð°Ð¼. Ð­Ñ‚Ð¾ Ð·Ð°Ð¹Ð¼Ñ‘Ñ‚ 1â€“2 Ð¼Ð¸Ð½ÑƒÑ‚Ñ‹.";
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
        if (!text){ await tgSend(chatId,"Ð’Ð²ÐµÐ´Ð¸Ñ‚Ðµ Ð¸Ð¼Ñ."); return; }
        await setField(sheets, st.rowNum, head, "name", text);
        await ask("phone"); return;
      }
      if (step === "ask_phone"){
        const s = String(text||"").replace(/\D+/g,"");
        const norm = (s.length===11 && (s[0]==="7"||s[0]==="8")) ? "+7"+s.slice(1) : (s.length===10 ? "+7"+s : null);
        if (!norm){ await tgSend(chatId,"Ð¢ÐµÐ»ÐµÑ„Ð¾Ð½ Ð½Ðµ Ñ€Ð°ÑÐ¿Ð¾Ð·Ð½Ð°Ð½. Ð¤Ð¾Ñ€Ð¼Ð°Ñ‚: +7XXXXXXXXXX Ð¸Ð»Ð¸ 8XXXXXXXXXX."); return; }
        await setField(sheets, st.rowNum, head, "phone", norm);
        await ask("company"); return;
      }
      if (step === "ask_company"){
        if (!text){ await tgSend(chatId,"Ð£ÐºÐ°Ð¶Ð¸Ñ‚Ðµ Ð½Ð°Ð·Ð²Ð°Ð½Ð¸Ðµ ÐºÐ¾Ð¼Ð¿Ð°Ð½Ð¸Ð¸."); return; }
        await setField(sheets, st.rowNum, head, "company", text);
        await ask("device"); return;
      }
      if (step === "ask_device"){
        if (!text){ await tgSend(chatId,"Ð’Ñ‹Ð±ÐµÑ€Ð¸Ñ‚Ðµ ÑƒÑÑ‚Ñ€Ð¾Ð¹ÑÑ‚Ð²Ð¾ Ð½Ð° ÐºÐ»Ð°Ð²Ð¸Ð°Ñ‚ÑƒÑ€Ðµ Ð¸Ð»Ð¸ Ð²Ð²ÐµÐ´Ð¸Ñ‚Ðµ Ñ‚ÐµÐºÑÑ‚Ð¾Ð¼."); return; }
        await setField(sheets, st.rowNum, head, "device", text);
        await ask("model"); return;
      }
      if (step === "ask_model"){
        if (!text){ await tgSend(chatId,"Ð£ÐºÐ°Ð¶Ð¸Ñ‚Ðµ Ð¼Ð¾Ð´ÐµÐ»ÑŒ ÑƒÑÑ‚Ñ€Ð¾Ð¹ÑÑ‚Ð²Ð°/ÐºÐ°Ñ€Ñ‚Ñ€Ð¸Ð´Ð¶Ð°."); return; }
        await setField(sheets, st.rowNum, head, "model", text);
        await ask("issue"); return;
      }
      if (step === "ask_issue"){
        if (!text){ await tgSend(chatId,"ÐžÐ¿Ð¸ÑˆÐ¸Ñ‚Ðµ Ð¿Ñ€Ð¾Ð±Ð»ÐµÐ¼Ñƒ Ð² 1â€“2 Ð¿Ñ€ÐµÐ´Ð»Ð¾Ð¶ÐµÐ½Ð¸ÑÑ…."); return; }
        await setField(sheets, st.rowNum, head, "issue", text);
        await ask("urgent"); return;
      }
      if (step === "ask_urgent"){
        const v = text.toLowerCase();
        const ok = ["Ð² Ñ‚ÐµÑ‡ÐµÐ½Ð¸Ðµ Ð´Ð½Ñ","Ð·Ð°Ð²Ñ‚Ñ€Ð°","1â€“2 Ð´Ð½Ñ","1-2 Ð´Ð½Ñ"].some(k => v.includes(k));
        if (!ok){ await tgSend(chatId,"Ð’Ñ‹Ð±ÐµÑ€Ð¸Ñ‚Ðµ Ñ ÐºÐ»Ð°Ð²Ð¸Ð°Ñ‚ÑƒÑ€Ñ‹: Â«Ð’ Ñ‚ÐµÑ‡ÐµÐ½Ð¸Ðµ Ð´Ð½ÑÂ», Â«Ð—Ð°Ð²Ñ‚Ñ€Ð°Â» Ð¸Ð»Ð¸ Â«1â€“2 Ð´Ð½ÑÂ»."); return; }
        const val = v.includes("Ð² Ñ‚ÐµÑ‡ÐµÐ½Ð¸Ðµ") ? "Ð² Ñ‚ÐµÑ‡ÐµÐ½Ð¸Ðµ Ð´Ð½Ñ" : (v.includes("Ð·Ð°Ð²Ñ‚Ñ€Ð°") ? "Ð·Ð°Ð²Ñ‚Ñ€Ð°" : "1â€“2 Ð´Ð½Ñ");
        await setField(sheets, st.rowNum, head, "urgent", val);
        const fresh = (await readAll(sheets, f"DialogState!A{st.rowNum}:Z{st.rowNum}"))[0];
        await setField(sheets, st.rowNum, head, "step", "confirm");
        await tgSend(chatId, makeSummary(fresh, idx), YESNO_INLINE);
        return;
      }
      if (step === "confirm"){
        await tgSend(chatId, "ÐÐ°Ð¶Ð¼Ð¸Ñ‚Ðµ Â«âœ… ÐŸÐ¾Ð´Ñ‚Ð²ÐµÑ€Ð´Ð¸Ñ‚ÑŒÂ» Ð¸Ð»Ð¸ Â«âœï¸ Ð˜ÑÐ¿Ñ€Ð°Ð²Ð¸Ñ‚ÑŒâ€¦Â» Ð½Ð¸Ð¶Ðµ.");
        return;
      }
      if (String(step).startsWith("ask_") || String(step).startsWith("edit_")){
        const field = step.replace(/^ask_|^edit_/, "");
        if (!text){ await tgSend(chatId,"Ð’Ð²ÐµÐ´Ð¸Ñ‚Ðµ Ð·Ð½Ð°Ñ‡ÐµÐ½Ð¸Ðµ."); return; }
        await setField(sheets, st.rowNum, head, field, text);
        await setField(sheets, st.rowNum, head, "step", "confirm");
        await tgSend(chatId, "ÐžÐ±Ð½Ð¾Ð²Ð¸Ð» Ð¿Ð¾Ð»Ðµ. ÐŸÑ€Ð¾Ð²ÐµÑ€ÑŒÑ‚Ðµ Ð·Ð°ÑÐ²ÐºÑƒ ÐµÑ‰Ñ‘ Ñ€Ð°Ð·.", YESNO_INLINE);
        return;
      }

      await tgSend(chatId, "Ð”Ð°Ð²Ð°Ð¹Ñ‚Ðµ Ð½Ð°Ñ‡Ð½Ñ‘Ð¼ Ð·Ð°Ð½Ð¾Ð²Ð¾: /start");
    }
  } catch(e){
    console.error(e);
  }
}

export const config = { api: { bodyParser: true } };
