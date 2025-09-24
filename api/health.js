// api/health.js
import { google } from "googleapis";

export default async function handler(req, res) {
  const envOk = !!(process.env.BOT_TOKEN && process.env.SHEET_ID);
  let sheetsOk = false;

  try {
    const auth = new google.auth.JWT(
      process.env.GCP_CLIENT_EMAIL || "",
      null,
      (process.env.GCP_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    );
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.get({ spreadsheetId: process.env.SHEET_ID });
    sheetsOk = true;
  } catch (_) {
    sheetsOk = false;
  }

  res.status(200).json({
    ok: envOk && sheetsOk,
    envOk,
    sheetsOk,
    time: new Date().toISOString()
  });
}
