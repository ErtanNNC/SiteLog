# SiteLog — start development in Claude Code

Everything Claude Code needs is in this claude.ai Project. Open Claude Code attached to the **SiteLog** project and paste **one** of the two kickoff prompts below:

- **A · Existing repo** — the SiteLog code that is already live on Netlify. Claude Code audits it against spec v1.2 first, then updates it on a branch. **Use this one if the repo exists.**
- **B · Empty folder** — a fresh start.

## What is in the project

| Project path | Goes to (in the repo) | What |
|---|---|---|
| `SITELOG_SPEC.md` | `docs/SITELOG_SPEC.md` | Product + build spec v1.2 (source of truth) |
| `repo/CLAUDE.md` | `CLAUDE.md` | Rules for Claude Code: stack, commands, non-negotiables, definition of done |
| `repo/docs/PLAN_WEEK1.md` | `docs/PLAN_WEEK1.md` | Week-1 tickets W1-01 … W1-19 (M0–M5) + demo script |
| `repo/env.example` | `.env.example` | Environment template, marked by week |
| `repo/brand/*.svg` | `apps/web/public/brand/`, `apps/field/public/brand/` | Logo mark, inverted, mono, app icon, favicons |
| `design/*.dc.html` | `docs/design/` | Week-1 design artboards (reference HTML) |
| `claude/channel-options.md` | `docs/decisions/channel-options.md` | Channel and provider decisions |

The full design canvas (all 32 artboards incl. hours, weather, team, settings, billing) stays in the "SiteLog — App, UX & Brand" artifact on claude.ai.

## Before you start (you, not Claude)

**Now — on your computer**
- [ ] Node 20 + pnpm 9, Git, Docker Desktop (running), Supabase CLI.
- [ ] A private GitHub repo for the code (optional but recommended).

**Keys for week 1** — put them in `.env` yourself; don't paste keys into the chat.
- [ ] **Anthropic API key** (console.anthropic.com) — needed from W1-12 (extraction).
- [ ] **Deepgram API key** (deepgram.com, $200 sign-up credit) — needed from W1-11 (transcription).
- [ ] *Optional:* **Resend** API key — real emails in W1-15 (otherwise emails show in the Demo phone).
- [ ] For the demo deploy (W1-19): a free **Supabase** project and a free **Netlify / Vercel / Cloudflare Pages** account.

**Start now because of lead time (spec §5.2)**
- [ ] **İletimerkezi** account → subscription approval via e-Devlet → request the sender title `SITELOG` (1–2 business days). 100 test SMS included.
- [ ] **Twilio**, when you're ready to spend ~$20: upgrade → toll-free number → toll-free verification (days to weeks). The trial can't send our custom texts.

**Week 2 (voice)**
- [ ] **LiveKit Cloud** (free Build plan, no card) + the free US number.
- [ ] **Azure AI Speech** resource on the free F0 tier (Turkish voice).

Until SMS is approved, every text goes to the **Demo phone** page in the panel (`/dev/phone`), so the whole demo works without any SMS account.

## A · Kickoff prompt for the existing repo (live on Netlify)

```text
This repo is SiteLog and it is already live on Netlify. We are updating it to spec v1.2. This session is
attached to the claude.ai Project "SiteLog"; use the Projects tool to read it.

Ground rules: do NOT scaffold from scratch, run git init or overwrite existing files wholesale. Work on a
new branch "spec-v1.2" (Netlify builds it as a deploy preview; production stays on main). Never push to
main or change Netlify production settings without asking me. Keys go in .env / Netlify env vars, never
in the chat or in VITE_* unless CLAUDE.md allows it.

1. project_info, then read claude/START_HERE.md, SITELOG_SPEC.md, repo/CLAUDE.md, repo/docs/PLAN_WEEK1.md
   and claude/channel-options.md.
2. Audit this repo: stack and versions, folder layout, pages/screens that exist, backend (Supabase? Netlify
   Functions?), database schema and migrations, netlify.toml (base, build command, publish dir, redirects,
   functions), env vars it expects, tests, and anything built for WhatsApp (v1.1 removed WhatsApp).
3. Write docs/GAP_ANALYSIS.md: for every ticket W1-01 … W1-19 mark done / partial / missing / conflicts,
   with file references. List what must be removed (WhatsApp), what we keep, and a migration plan for
   any structural change (e.g. moving to apps/web + apps/field, Supabase Edge Functions, the /api/*
   rewrite to field-api in netlify.toml) that keeps the Netlify build green at every step.
4. Add the project docs without clobbering: docs/SITELOG_SPEC.md, docs/PLAN_WEEK1.md, docs/design/*,
   docs/decisions/channel-options.md, .env.example (merge with any existing one), brand SVGs into the
   app's public/brand/. If a CLAUDE.md already exists, merge ours into it and keep the repo's real
   commands and layout. Commit "chore: add spec v1.2, plan and design references".
5. STOP and show me the gap analysis and migration plan. After I approve, rewrite PLAN_WEEK1.md for this
   repo (skip what is done, adapt the rest), then work ticket by ticket: typecheck, lint, tests, tick,
   commit "W1-xx: …", 3-line report, and check the Netlify deploy preview. Stop at the end of each
   milestone (M0 … M5).
6. If a ticket needs a key that is not set yet, build the fake/console implementation with tests, tell
   me which key, and continue. Never invent product behaviour: open questions go to spec §19 and to me.
   When you change the spec, also write it back to the project (SITELOG_SPEC.md).
```

## B · Kickoff prompt for an empty folder

```text
You are starting the SiteLog codebase in this empty folder. This session is attached to the claude.ai
Project "SiteLog". Use the Projects tool for everything below.

1. project_info, then read claude/START_HERE.md, SITELOG_SPEC.md, repo/CLAUDE.md and repo/docs/PLAN_WEEK1.md.
2. Materialise the repo exactly (when a read returns a local file path, copy that file — never retype
   long content):
   SITELOG_SPEC.md → docs/SITELOG_SPEC.md · repo/CLAUDE.md → CLAUDE.md · repo/env.example → .env.example ·
   repo/docs/PLAN_WEEK1.md → docs/PLAN_WEEK1.md · repo/brand/*.svg → apps/web/public/brand/ and
   apps/field/public/brand/ · design/*.dc.html → docs/design/ · claude/channel-options.md →
   docs/decisions/channel-options.md.
3. git init if needed; commit "chore: add spec, plan, brand and design references".
4. Follow CLAUDE.md. Work through docs/PLAN_WEEK1.md from W1-01, in order. After each ticket run
   typecheck, lint and tests, tick the box, commit "W1-xx: …" and give me a 3-line report.
   Stop at the end of each milestone (M0 … M5) so I can review before you continue.
5. If a ticket needs a key that is not in .env yet, build the fake/console implementation with tests,
   tell me which key it needs, and continue.
6. Never invent product behaviour: put open questions in docs/SITELOG_SPEC.md §19 and ask me.
   When you change the spec, also write the updated file back to the project (SITELOG_SPEC.md).
```

## If Claude Code is not attached to the project

Download the files listed above from the SiteLog project on claude.ai into the paths in the table, then paste the kickoff prompt and tell Claude Code the files are already in `docs/` (skip the Projects tool steps).
