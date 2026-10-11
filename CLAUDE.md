# SiteLog — notes for Claude Code

Read `docs/SITELOG_SPEC.md` before changing product behaviour. It is the single source of truth; `README.md` lists the deliberate deviations.

## Layout

- `packages/shared` — Zod schemas, enums, pure helpers (Node + browser + Deno). Relative imports use explicit `.ts` extensions so Deno can import it; keep it free of Node-only APIs.
- `supabase/migrations` — schema, RLS, RPCs. `supabase/db-tests` runs them on PGlite (`pnpm test:db`). `supabase/seed.sql` is generated: edit `packages/shared/src/demo/kestrel.ts`, then `pnpm seed:demo`.
- `supabase/functions` — Deno edge functions (webhook, scheduler, api-*, stripe). Not runnable here without Deno; CI runs `deno check` / `deno test`.
- `apps/worker` — Node job runner (WhatsApp, transcription, Claude extraction, PDF, email, weather).
- `apps/web` — Vite + React panel. `VITE_DEMO=true` runs it on in-memory §18 data with no Supabase.
- `fixtures/` — webhook payloads, golden transcripts, expected extractions, recorded tool outputs.

## Commands

`pnpm check` (typecheck + lint + unit tests) · `pnpm test:db` · `pnpm dev` (web) · `pnpm dev:worker` · `pnpm seed:demo` · `pnpm replay-webhook -- fixtures/webhooks/*.json` · `pnpm eval` (needs `ANTHROPIC_API_KEY`).

## Conventions

- UI copy lives in `apps/web/src/copy/en.ts`; WhatsApp copy in `packages/shared/src/copy/whatsapp.ts`. No emoji. English only.
- Every state change writes `audit_log`. Report versions are immutable; edits create a new version.
- Money in integer cents, phones in E.164, timestamps UTC, site-facing times in the site's time zone.
- Never send phone numbers to an LLM. The model never decides to file a report; code does after an explicit confirm.
- Design tokens are in `apps/web/src/styles/tokens.css` (§14). Orange is a signal, not decoration.
