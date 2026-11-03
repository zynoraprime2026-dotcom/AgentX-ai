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

## 4. Reminders and triggers need a tick
Reminders and event triggers are delivered by a background tick:

- **Long-running hosts (Render, Railway, VPS):** nothing to do. The app runs an in-process ticker every 60 seconds.
- **Vercel:** serverless functions cannot keep a timer, so point any scheduler at `GET /api/cron/tick` with `Authorization: Bearer <CRON_SECRET>` every 5 minutes (cron-job.org, GitHub Actions, or a Vercel Pro cron entry — Hobby only allows daily crons). The daily Fajr cron already runs a tick, so a reminder can be up to a day late without it.
- Set `AGX_DISABLE_TICKER=1` if you run several instances and only want the external scheduler to deliver.
- **Neon (and any serverless Postgres) — compute hours matter.** A ticker that queries every 60 seconds keeps compute awake 24/7, which is ~730 hours a month against Neon Free's ~192 hours, so the database would be suspended partway through the month. The ticker is therefore idle-aware: it reads the schedule, then stays completely off the database until the next reminder is due or the earliest trigger interval elapses (15 minutes when nothing is scheduled). A new reminder or trigger from the dashboard wakes it immediately. Knobs: `AGX_TICK_SECONDS` (default 60) and `AGX_TICK_IDLE_SECONDS` (default 900). Triggers set to check every 15 minutes will still wake the database that often — use hourly or daily for always-on work on the free tier.

## 5. Voice
Speech-to-text and text-to-speech use the Groq key already configured (`whisper-large-v3-turbo` and `playai-tts`). Voice replies in the dashboard are a Pro feature; spoken answers fall back to the browser's own speech synthesis when the server voice is unavailable.

## Notes
- Deploys from this repo work with automatic Git deploys (the gitSource block that blocked the Noor project does not apply here; if a deploy arrives blocked, use Redeploy).
- Local test: `npm install && node server.js` → http://localhost:3100
