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

## Islamic commands (2026-11)

Every chat, on Telegram, WhatsApp and the dashboard, answers these directly from
the Ilm API without spending model tokens:

| Command | What it does |
| --- | --- |
| `/prayer <city or lat,lng>` | today's five times, shown on that place's clock, plus the next prayer and how long until it |
| `/quran 2:255` | Arabic ayah with translation (`/quran 2:255 ar.sahih` to pick a translation) |
| `/hadith patience \| bukhari` | search 47,000+ narrations, optionally within one collection |
| `/dua travel` | a du'a; `/dua` for a random one, `/dua save travel` keeps it, `/dua saved` lists them |
| `/fiqh wudu` | the four madhhabs side by side, with the other related questions listed |
| `/help` | the menu |

A city the API does not know is resolved through OpenStreetMap and cached, and the
timezone comes from timeapi.io, so times are correct anywhere in the world. The
Telegram menu is registered on boot, so the commands show up as soon as someone
types `/`. Anything that is not a command still goes to the model.

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

## Daily post pipeline (2026-11-09)

One ayah, one image, two channels, twice a day. What decides which verse goes out:

1. `daily_cursor` in `agx_social` is the only source of order. Every successful publish
   moves it on by one, so a manual post consumes a verse instead of repeating the
   morning's. The date only seeds the very first run. Sixty verses in
   `data/daily_ayat.json` mean an ayah returns after about a month at two posts a day.
2. `daily_last_<slot>` holds the day that slot last published, and a run that is not
   forced returns `skipped` rather than publishing twice. Records are JSON text, so they
   are parsed on read (`parseRecord`) — comparing the raw string to an object is what let
   four copies of 33:41 reach the Page on 2026-11-09.
3. Before publishing, the pipeline reads the Page's last ten posts and compares captions
   with whitespace flattened. If the exact post is already up there, it moves on to the
   next verse and reports `guard`. A guard failure is reported as `guardError` and never
   blocks a post. `guard=0` on the admin route switches it off.

Seeing and changing the queue:

- WhatsApp or Telegram, owner only: `preview`, `queue`, `what's next`, or `/preview` lists
  the next eight posts with their verses and notes.
- `GET /api/admin/daily-preview?count=8` (admin key) returns the same as JSON.
- `GET /api/admin/daily-post?dry=1` shows what would go out next without publishing.

Failures are no longer only in the logs: the cron route messages the owner on WhatsApp
and Telegram when a channel errors, when nothing was published, when the day could not be
recorded, or when the guard moved the verse.

Tests: `node test-daily-rotation.js` (27 assertions, order and the daily claim) and
`node test-daily-guard.js` (13, preview, the page guard and the alert paths).

## Per-page slots and engagement (2026-11-09)

Each slot can post to its own Page and Instagram account without a redeploy:
`GET /api/admin/daily-schedule` shows the current map, and `POST /api/admin/daily-schedule` with
`{"morning":{"page":"The salafi Da'wah","ig":"the_salafi_dawah"},"evening":{"page":"Hikmah Hub","ig":"thesalafidawah"}}`
sets it. The Page is resolved before it is stored, so a typo is refused rather than saved, and a missing or
half-written record falls back to `DAILY_FB_PAGE` / `DAILY_IG_ACCOUNT`. Vercel Hobby allows two runs a day,
so this cannot add posting times; it decides which Page each of the two runs serves.

`GET /api/admin/insights?limit=15` reads the Page's recent posts with likes, comments, shares, the ayah ref
and a score (likes + 2x comments + 3x shares), newest first, plus the best performer. Read-only, and the input
for steering the rotation by evidence later.

A slot with no Instagram account of its own publishes to Facebook only: it never falls
back to another Page's account, since that would put the same ayah on one account twice
in a day. Set `"ig": ""` for that slot.

## Workflows and the run log (2026-11-10)

A workflow is data in `agx_workflows`, not code, so the owner can change what happens without a
deploy. Shape: `{id, name, enabled, trigger, approval, steps[]}`.

*Trigger* is `{type:"manual"}`, `{type:"cron", slot:"morning"|"evening"}` or `{type:"webhook"}`.
Cron workflows ride the two runs the daily post already uses, because Vercel's free plan allows
only those two; they are not a third schedule.

*Steps* run in order and may be `http`, `agent` or `notify`. `http` is limited to https and to
`WORKFLOW_HOSTS` (default ilm-api and this service), because a step that can call any URL is an
open redirect with extra steps. A non-2xx response fails the step unless it carries
`allowFailure: true`. `notify` is the only step that reaches a person, and it is held for
approval unless the workflow was created with `approval: false`. `when: {path, equals|notEquals|
exists|contains}` skips a step when its condition is not met. `{{steps.name.body.x}}` and
`{{input.y}}` fill from what actually ran; a missing path renders empty, never `undefined`.

*The run log* is the point. Every run keeps its steps, each step's saved output, and its failure
reason in `agx_runs`; approval runs record what was held and when it went out. Approving sends
only the held text and never re-runs the research, so what the owner approved is what was sent.

Endpoints (admin key): `GET/POST /api/workflows`, `POST /api/workflows/delete`,
`POST /api/workflows/:id/run`, `GET /api/runs`, `GET /api/runs/:id`,
`POST /api/runs/:id/approve|reject`.

From the owner's chat: `workflows`, `runs`, `run <id>`, `approve <id>`, `reject <id>`.
A gated run arrives as a message with the exact text and a one-word way to send or drop it.

Rules baked in: verse and hadith text is fetched from ilm-api, never composed by the model; a
workflow cannot publish to a Page yet, because the approval gate comes before that power.

Tests: `node test-workflows.js` (40 assertions: definition rules, templating, conditions, ordered
steps, failure stops later steps, allowFailure, the approval gate and reject, and cron slot
selection).

### Publishing from a workflow

A `publish` step posts the daily ayah through the same pipeline as the cron, so the daily
claim, the verse cursor and the Page duplicate guard all still apply: a workflow cannot
post the same ayah twice in a day. It cannot be saved with `approval: false`; the run holds
the publish, shows "Publish the morning post", and the post happens when the owner approves,
not when the run was prepared. A later `notify` step can quote what went out with
`{{steps.<save>.url}}` and `{{steps.<save>.ref}}`.

### Webhook triggers

A workflow with `trigger: {type: "webhook"}` is given a token on save and started by
`POST /api/hooks/<id>` with `x-hook-token` (or `?token=`). This is how a five-minute
external pinger can drive a schedule Vercel's free plan cannot.

### When a post fails

The claim record is written only when something actually reached a channel. A run where
Facebook and Instagram both refused leaves the slot open, says so in `claimSkipped`, and the
next run tries again instead of spending the day. `GET /api/admin/daily-last` shows what each
slot last did, including the error the platform returned.

An approval stops at the first step that fails: later held steps are marked skipped with the
reason, so a message saying "Posted ..." is never sent after a publish that did not happen.

### Two bugs worth remembering

`slotForNow()` accepted a slot name and passed it to `new Date()`. "morning" is an Invalid
Date, its hours are NaN, and `NaN < 12` is false, so every scheduled run resolved to the
evening target: a whole day landed on Hikmah Hub while The salafi Da'wah stayed empty. It
now returns an explicit slot unchanged and falls back to the clock only for dates.

The duplicate guard used to move on to the next verse when today's copy was already on the
Page, which posted a second time in the same slot (two appeared seventeen minutes apart).
It now treats the slot as done, records that decision with the time the copy was seen, and
leaves the cursor alone.

## The daily hadith post

A second daily piece sits beside the ayah: one narration, on whichever Page owns that day
(alternating by day so neither Page needs a third cron run), claimed separately in
`hadith_last` with its own rotation cursor.

The Arabic and English are fetched from ilm-api by collection and number, never written by a
model: a composed hadith is a fabrication of the Prophet's words. `data/daily_hadith.json`
holds only references that were checked to return both languages, each with an image scene
that forbids people, faces and Quranic calligraphy. A failed fetch publishes nothing and says
why; it never falls back to a remembered narration.

`GET|POST /api/admin/hadith-post?dry=1` previews (caption and image, nothing posted),
`?force=1` posts even if today is done. `GET /api/admin/daily-last` reports it under
`hadith`. Tests: `node test-hadith-daily.js` (20 assertions).

### Hadith from the owner's chat

"post hadith", "publish the daily hadith" and `/hadithpost` send today's narration and
respect the claim (a second try says it is already up). "hadith", "hadith of the day" and
`/hadithday` show what would go out, with the image, without posting. "post" still means the
ayah: the hadith triggers are matched first, so neither can publish the other. All of them
are owner-only, and a stranger's "post hadith" is refused rather than ignored.

A skipped ayah run now reports `page` and `skippedPage`, because "nothing happened" without
naming the Page is how the wrong-Page bug hid for a day.

## Editing what is already on the Page

`pages_manage_posts` covers the Page's own posts, so a wrong caption or a bad post can be
fixed without opening Facebook:

- "last post" / `/lastpost` shows the newest post on the slot's Page.
- "fix caption ..." / "change the caption to ..." / `/fixcaption ...` stages an edit and
  answers with the old caption, the new one, and the post it belongs to. Editing keeps the
  same post and its likes and comments.
- "delete the last post" / `/deletepost` stages a deletion and warns that likes and comments
  go with it.
- "yes" applies the staged action, "no" drops it. A yes with nothing staged is not a
  command, an ordinary sentence beginning with "yes" is left alone, and a failed apply keeps
  the action staged so it can be retried.

Staged actions live in `agx_social.pending_post_action`, owner-only through `ctx.canManage`.
Comment replies and Page details still need `pages_manage_engagement` and
`pages_manage_metadata`, which the token does not carry. Tests: `node test-post-edit.js`
(23 assertions).

## The daily audit

Every cron run ends by asking a question success cannot answer: did each slot post what it
was supposed to, on the Page it was supposed to? `lib/audit.js` compares each slot's claim
with that slot's configured Page and reports:

- `missing`: a slot whose time has passed (plus a 45-minute grace) with no post today.
- `wrong_page`: the post landed on a different Page than the schedule names. This is the
  incident it was written for: a whole day went to Hikmah Hub and every run said success.
- `unknown_page`: posted, but the claim never recorded where. A warning, not a failure.

The cron alerts the owner when anything but `unknown_page` appears. `GET /api/admin/audit`
returns the same findings as JSON, and "audit" or "did today go out" asks for it in AgentX's
chat.

## Engagement, on request

"engagement", "stats", "analytics", "how did the posts do" and `/engagement` read the Page's
own numbers (reactions, comments, shares from the posts endpoint) and list the recent posts
best first, scoring a comment above a reaction and a share above both. Owner-only.

Tests: `node test-audit.js` (15 assertions); command routing in `test-commands-hadith.js`.
