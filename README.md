# AgentX

Multi-platform AI agent dashboard — manage AI assistants that answer on WhatsApp and Telegram, powered by Groq-hosted LLaMA models.

## What's in v1

- 🤖 **Agent manager** — create/edit/delete agents with name, emoji, description, system prompt, model and status (draft / live / paused)
- 📡 **Channels** — per-agent WhatsApp and Telegram toggles with auto-reply switches (connection hooks: WhatsApp Cloud API + Telegram Bot API — next milestone)
- 💬 **Test chat console** — chat with any agent right from the dashboard, streamed through Groq
- ⚙️ **Settings** — paste your Groq API key (stored server-side); without a key the chat runs in demo mode
- 📊 **Overview** — live agent stats at a glance


## Feature suite (2026-11)

Beyond the v1 agent manager:

- 🎭 **Personality presets** — tone and depth sliders plus presets (formal teacher, friendly helper, classical scholar) that are compiled into the system prompt.
- 🌍 **Multi-language replies** — agents answer in the language the user writes in (English, Arabic, French, Hausa, Twi, Wolof, Swahili, Urdu, Malay, Indonesian, Turkish, Somali), detected from the message.
- 📚 **Knowledge base** — upload PDF, Word (.docx), CSV, Markdown, HTML or plain text (or paste it). Files are chunked and the relevant parts are quoted in the prompt. No third-party parsing dependencies.
- ✨ **Smart FAQ** — drafts Q&A pairs from the knowledge files and stores them, so answers stay consistent.
- ⏰ **Reminders** — scheduled pushes to Telegram or WhatsApp, one-off or repeating. Subscribers can also type `/remind 30m drink water`.
- 🔔 **Event triggers** — watch any JSON feed (weather, news, your own API), pick a field, choose when it fires (changed / above / below / always) and let an agent write the message.
- 📈 **Analytics** — messages, replies, average reply time, errors, per-agent and per-channel breakdowns, top questions, daily chart.
- 🎙️ **Voice** — microphone input in the test console and Telegram voice notes transcribed with Whisper; answers read aloud with TTS (browser speech as the fallback).
- 👥 **Group-chat etiquette** — in Telegram and WhatsApp groups an agent stays quiet unless mentioned (`mention`) or, if you prefer, answers everything (`always`).
- 💳 **Plans** — free and pro limits with a payment link you control (Paystack, Stripe, anything). AgentX never charges anyone itself; the founder flips an account to Pro.

All of it lives in `lib/suite.js` (+ `lib/docs.js` document store and `lib/extract.js` text extraction), mounted from `server.js` with one call. New tables are created on boot and the JSON-file fallback still works.

## Tech

Node.js + Express, zero database (JSON file store in `data/`), vanilla JS frontend, single-page dashboard. Light enough to deploy anywhere: Render, Railway, Fly.io, or a $5 VPS.

## Run it

```bash
npm install
npm start          # dashboard at http://localhost:3000
```

Then open Settings and paste your Groq API key from https://console.groq.com/keys.

## Roadmap

- [ ] WhatsApp Cloud API webhook receiver (receive + reply for real numbers)
- [ ] Telegram Bot API polling/worker per enabled agent
- [ ] Conversation history + transcripts viewer
- [x] Per-agent knowledge files (PDF/notes)
- [x] Usage analytics per channel
- [x] Voice notes, reminders, triggers, groups, personality presets

---
Experiment by Abdulrahim Abubakar · Zynora AI · Tarkwa, Ghana
