// api/health.js — эталонная проверка платформы
export default function handler(req, res) {
  res.status(200).send('ok-health');
}
export const config = { api: { bodyParser: true } };
