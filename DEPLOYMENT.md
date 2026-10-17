# AgentX — Deploy to Vercel

## 1. Import the repo
Vercel dashboard → Add New → Project → import `zynoraprime2026-dotcom/AgentX-ai`.
Root directory: leave as `/`. The build is automatic (plain Node app, no build step).

## 2. Environment variables (Settings → Environment Variables)
| Variable | Required | What it does |
|---|---|---|
| DATABASE_URL | YES | Neon (or any Postgres) connection string. Tables are created automatically on boot. Without it the app falls back to temporary JSON storage that resets on every cold start. |
| GROQ_API_KEY | YES | The AI brain (model: openai/gpt-oss-120b). |
| ILM_API_KEY | recommended | Activates the Quran / hadith / duas / prayer-time tools so answers cite real data. |
| ADMIN_KEY | recommended | Platform owner key. Registering with this key makes your account the founder. |
| CRON_SECRET | recommended | Auth for the daily Fajr cron endpoint. |
| TELEGRAM_BOT_TOKEN | optional | Enables the Telegram bot + Fajr reminders delivery. |
| WHATSAPP_TOKEN / META tokens | optional | Enables the WhatsApp channel. |

## 3. After first deploy
- Vercel will detect `vercel.json` and offer to enable the cron. Accept it.
- The cron hits `GET /api/cron/fajr` daily at 03:30 UTC with `Authorization: Bearer <CRON_SECRET>`.
  It sends every Telegram subscriber their Fajr time for their city plus a morning dua.
- Telegram: set the webhook to `https://<your-app>.vercel.app/webhook/telegram` (BotFather or the dashboard's Telegram page).

## Notes
- Deploys from this repo work with automatic Git deploys (the gitSource block that blocked the Noor project does not apply here; if a deploy arrives blocked, use Redeploy).
- Local test: `npm install && node server.js` → http://localhost:3100
