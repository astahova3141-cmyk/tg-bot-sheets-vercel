# Telegram → Google Sheets бот (Vercel, бесплатный план)

Готовая серверлес-функция для мгновенных ответов бота без Apps Script. Telegram шлёт вебхук на Vercel, бот пишет состояние и заявки в Google Sheets.

## Шаги деплоя (3–5 минут)

1) **Service Account (SA) и доступ к таблице**
   - Создайте SA в GCP и скачайте JSON-ключ.
   - Откройте вашу таблицу → **Share** → добавьте `client_email` из JSON с правом **Editor**.
   - Скопируйте `SHEET_ID` (между `/d/` и `/edit` в URL).

2) **Vercel → New Project**
   - Импортируйте этот репозиторий.
   - В **Environment Variables** добавьте:
     - `BOT_TOKEN` — токен от BotFather
     - `SHEET_ID` — ID таблицы
     - `GCP_CLIENT_EMAIL` — из JSON
     - `GCP_PRIVATE_KEY` — из JSON (**переводы строк заменить на \n**)
     - (опц.) `WORK_CHAT_ID` — рабочий чат
     - (опц.) `BOT_BANNER_URL` — URL картинки для приветствия
   - Deploy → получите URL: `https://<app>.vercel.app`

3) **Привязать вебхук Telegram**
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<app>.vercel.app/api/tg&drop_pending_updates=true"
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

4) **Тест**
- `/start` в чате с ботом → ответ 1–2 сек.
- Пройдите сценарий → строки появятся в листе `Requests`.

## Формат таблиц
- DialogState: `chat_id, step, name, phone, company, device, model, issue, urgent, updated_at`
- Requests: `date, name, phone, company, device, model, issue, urgent, chat_id, ticket_id, status, yougile_link, notified, closed_at`

Сборка: 2025-09-20 13:24
