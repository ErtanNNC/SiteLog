# @sitelog/web — office web panel

Vite + React 19 + TypeScript. The office panel from `docs/SITELOG_SPEC.md` §11 (pages) and §14 (design system).

## Scripts

| Command                                  | What it does                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @sitelog/web dev`         | Vite dev server (http://localhost:5173)                                                                 |
| `pnpm --filter @sitelog/web build`       | Production build to `dist/`                                                                             |
| `pnpm --filter @sitelog/web preview`     | Serve the build                                                                                         |
| `pnpm --filter @sitelog/web typecheck`   | `tsc` over `src`, `e2e` and the configs                                                                 |
| `pnpm --filter @sitelog/web test`        | Vitest (jsdom + Testing Library)                                                                        |
| `pnpm --filter @sitelog/web e2e`         | Playwright smoke test (starts Vite on :4173 with `VITE_DEMO=true`)                                      |
| `pnpm --filter @sitelog/web screenshots` | Saves `e2e/__screenshots__/{login,overview,sites,site,reports,report}-{1440,375}.png` for visual review |

Root: `pnpm lint`, `pnpm format`, `pnpm check`.

## Environment variables

| Variable                 | Purpose                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `VITE_SUPABASE_URL`      | Supabase project URL. Missing → demo mode.                                                            |
| `VITE_SUPABASE_ANON_KEY` | Anon key (RLS does the rest; never the service key).                                                  |
| `VITE_APP_URL`           | Public URL used for the magic-link redirect (`/auth/callback`). Defaults to `window.location.origin`. |
| `VITE_WA_DISPLAY_NUMBER` | The SiteLog WhatsApp number shown in the sidebar footer (E.164).                                      |
| `VITE_DEMO`              | `true` → in-memory §18 Kestrel data, no Supabase.                                                     |
| `VITE_SENTRY_DSN`        | Enables Sentry; the inline error card shows the event id.                                             |

Copy `../../.env.example` to `.env.local` (Vite reads `.env*` files in this folder).

## Demo mode

`VITE_DEMO=true` (or simply no `VITE_SUPABASE_URL`) runs the panel on `kestrelDemo()` from `@sitelog/shared/demo/kestrel.ts`: Kestrel Build Group, six sites, "now" frozen at **Fri Oct 9 2026, 19:05 Chicago**.

- `/login` accepts any email and signs you in as **Lena Ortiz (admin)**. A visible **Demo** chip sits in the sidebar footer.
- `/login?as=pm` → Sam Kowalski (project manager) · `?as=ops` → Ravi Patel (operations, demo-only user) · `?as=accounts` → Accounts (payroll, lands on `/hours`). The account menu (sidebar footer) also switches users.
- Mutations (sign-off, edits, mark no work, glossary review, settings, invoices, pause/resume…) update the in-memory rows — with audit log and notifications — and persist until the tab reloads or you sign out.
- Realtime is deterministic: nothing changes on its own. The account menu has **Simulate report**, which makes Priya's late Elm St. report arrive (Missing → Filed, late) through the same change-event path the Supabase Realtime channel uses.

## Data-layer architecture

```
src/data/types.ts          view models for every page (OverviewData, SiteCard, HoursMatrix, …)
src/data/source.ts         DataSource interface: reads + mutations + subscribe(onChange)
src/data/assemble.ts       pure assemblers: DB-shaped rows → view models (shared by both sources, unit-tested)
src/data/demo/store.ts     DemoStore: cloned dataset + mutations (audit, notifications, denormalised rows)
src/data/demo/DemoSource.ts
src/data/supabase/SupabaseSource.ts   supabase-js queries/views/RPCs, edge functions, Realtime, signed URLs
src/data/hooks.ts          TanStack Query hooks (org-scoped keys) + mutation hooks with invalidation + toasts
src/data/DataProvider.tsx  picks the source by `isDemo`, wires realtime → query invalidation
```

Reads go: page → `useX()` hook → `DataSource.getX()` → (fetch rows) → `assembleX(rows)` → view model. Mutations go: page → `useXMutation()` → `DataSource.x()` → RPC / table write / edge function (Supabase) or `DemoStore.x()` (demo) → invalidate the org's queries → toast.

**Adding a page or a field:**

1. `types.ts` — add or extend the view model.
2. `assemble.ts` — build it from rows (`RowSet`). Keep it pure; add a test in `demo/DemoSource.test.ts` against the §18 numbers.
3. `demo/store.ts` — add mutations if the page writes.
4. `supabase/SupabaseSource.ts` — fetch only the rows the assembler needs (RLS-friendly, org-scoped) and call the same assembler; add RPC/edge-function calls for writes.
5. `hooks.ts` — `useX()` / `useXMutation()` with a key in `lib/query.ts`.
6. `src/app/<name>/Page.tsx` — the page; it is lazy-loaded from `src/app/routes.tsx`, so swapping the file swaps the page.

Server calls used: RPCs `create_org`, `sign_off_report`, `undo_sign_off`, `create_report_version`, `mark_no_work`, `resolve_unknown_company`, `review_glossary_term`, `mark_notifications_read`; views `current_manpower`, `current_weather`; edge functions `api-invite-reporter`, `api-link-unknown-sender`, `api-export-payroll` (GET CSV), `api-evidence-pack`, `api-billing` — all with the user's `Authorization: Bearer <access_token>`. Media (audio, photos, PDFs, packs) use 10-minute signed URLs.

## Auth

`src/auth/AuthProvider.tsx` keeps the session, org memberships (`orgs`), the current org (persisted in `localStorage['sitelog.currentOrg']`) and the role. Sign-in is `signInWithOtp` with `emailRedirectTo = VITE_APP_URL + '/auth/callback'`; the callback page sends users with ≥ 1 `org_members` row home (`/`, or `/hours` for `accounts`) and everyone else to `/setup`. `RequireAuth` and `RequireRole` (`src/auth/guards.tsx`) implement §2.2; the nav is role-aware (`src/components/shell/nav.ts`).

## Design tokens

`src/styles/tokens.css` is Tailwind v4 CSS-first: `@theme` defines every §14.1 colour (core, functional, chip, heatmap ramp), the fonts (Archivo / IBM Plex Mono), radii (chip 4 · btn 6 · card 8) and type sizes; the default Tailwind palette is removed so only tokens can be used (`bg-signal`, `text-dust`, `border-rebar`, `bg-heat-4`…). Utilities: `font-display` (Archivo Expanded 800 via `font-stretch: 125%`), `font-h2`, `eyebrow` (mono, uppercase, 0.08em), `tabular`, `hazard-stripe`. Focus ring: 2 px Asphalt + 2 px offset. Rules: orange is a signal (≈10 % of a screen), borders over shadows, no gradients, no emoji, no left-border accent cards, buttons 44 px (40 px dense), lucide icons 24 px / 2 px stroke.

UI primitives live in `src/components/ui` (shadcn-style, restyled), SiteLog components in `src/components/sitelog` (StatusChip, KpiTile, StreakBar, CalendarMonth, VoicePlayer, SourceLink, TranscriptExcerpt, DataTable, HeatmapGrid, EvidenceChips, PageHeader, EmptyState/ErrorState/NoAccess/OfflineBanner/ReviewReasonsBanner, skeletons). All copy comes from `src/copy/en.ts`.

## Tests

- Vitest: components (`src/components/**/*.test.tsx`), Login, Overview, Site detail, Reports and Report review pages, `DemoSource` aggregations against the §18 figures (Overview KPIs, hours matrix, weather log, streaks, mutations).
- Playwright: `e2e/smoke.spec.ts` (login → overview → every nav item, sites, accounts landing, demo realtime, mobile drawer) and `e2e/screenshots.spec.ts`. The configs use `/opt/pw-browsers/chromium` when it exists (or `PLAYWRIGHT_CHROMIUM_PATH`); do not run `playwright install` in the sandbox.
