// api/tg.js — минимальный хендлер
export default function handler(req, res) {
  res.status(200).send('ok');
}
export const config = { api: { bodyParser: true } };

