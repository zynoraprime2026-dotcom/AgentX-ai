# AgentX

Multi-platform AI agent dashboard — manage AI assistants that answer on WhatsApp and Telegram, powered by Groq-hosted LLaMA models.

## What's in v1

- 🤖 **Agent manager** — create/edit/delete agents with name, emoji, description, system prompt, model and status (draft / live / paused)
- 📡 **Channels** — per-agent WhatsApp and Telegram toggles with auto-reply switches (connection hooks: WhatsApp Cloud API + Telegram Bot API — next milestone)
- 💬 **Test chat console** — chat with any agent right from the dashboard, streamed through Groq
- ⚙️ **Settings** — paste your Groq API key (stored server-side); without a key the chat runs in demo mode
- 📊 **Overview** — live agent stats at a glance

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
- [ ] Per-agent knowledge files (PDF/notes)
- [ ] Usage analytics per channel

---
Experiment by Abdulrahim Abubakar · Zynora AI · Tarkwa, Ghana
