# Phase 2 tickets: production-ready frontend

Scope, decisions and exit criteria: `docs/plan/phases.md` (Phase 2, "Decided at phase start"). Versions: `docs/research/frontend-stack-2026-10-18.md`. Screens: `docs/design/screens/*.dc.html` (Main = sign in; the others are named by screen). API contract: `backend/openapi.json`. This file only splits the work; it does not restate the design.

Product name in UI copy: **Stepwise**. Copy and visual style follow the screen files: neutral palette, near-black ink, lavender `#BBA8EE` as the only accent (AI moments), light amber only for agent flags, coral dot for recording, radii 12/16/24, Bricolage Grotesque 500 for h1/h2, Geist for body, Geist Mono for times. No em-dashes in copy.

## Layout (enforced by `frontend/scripts/check-layout.mjs`, do not edit it)

```
frontend/
  scripts/check-layout.mjs        verifier, pinned by acceptance A5
  src/
    proxy.ts                      redirects signed-out users from app routes to /sign-in
    app/                          routes only: thin pages that compose features
      (auth)/sign-in, (auth)/sign-up
      (app)/library, (app)/record, (app)/videos/[id], (app)/runs/[id], (app)/runs/[id]/review
      s/[slug]                    public share page (Server Component, no auth)
      api/auth/{signin,signup,signout}/route.ts
      api/[...path]/route.ts      the proxy to FastAPI
    api/                          the ONLY network layer
      generated/schema.d.ts       openapi-typescript output; never hand-edited
      client.ts                   openapi-fetch + openapi-react-query, baseUrl "/api"
      events.ts                   typed EventSource wrapper for /api/runs/{id}/events
      upload.ts                   resumable PUT to the GCS session URL
    lib/server/                   server-only: session cookie, upstream fetch
    features/{auth,videos,recorder,runs,review,shares}/   one folder per domain, like the backend
    ui/                           tokens + primitives (button, field, badge, panel, dialog, icons)
```

Rules the verifier checks: top-level folders; feature names; kebab-case files; no barrel `index.ts`; `ui` imports only `ui`/`lib`; `api` imports only `api`/`lib`; features never import other features or `app` (compose in `app/`); `fetch(` only in `api/`, `app/api/`, `lib/server/`; no `document.cookie` or token in localStorage; API types are never redeclared outside `api/`.

## Ticket B: backend gaps (do first)

- `FRONTEND_BASE_URL` setting (`app/shared/config.py`, `.env.example` = `http://localhost:3000`); `ShareCreated.url` = `{FRONTEND_BASE_URL}/s/{slug}`.
- `GET /me` in the `auth` package: `{user: {id, email, name}, workspaces: [{id, name, role}]}` read under `tenant_tx`. Add the schema in `auth/schemas.py`.
- `POST /videos/{id}/uploaded`: a `duration_s` over 900 → 422 (`MAX_RECORDING_SECONDS = 900` in config; mechanical global limit).
- Regenerate `backend/openapi.json`. Tests for all three. `check_layout.py`, ruff, ruff format, pyright, pytest stay green.

## Ticket F1: scaffold, tokens, generated client

- `frontend/` with Next.js 16 (App Router, TypeScript strict, Turbopack), React 19, Tailwind 4 via `@tailwindcss/postcss`, `next/font` for Geist / Geist Mono / Bricolage Grotesque, `output: 'standalone'`, Node 20.9+. Exact versions pinned in `package.json` (no `^`).
- Path alias `@/*` → `src/*`. ESLint (next config), Prettier, Vitest + Testing Library + jsdom, Playwright.
- Scripts: `gen:api` (openapi-typescript `../backend/openapi.json` → `src/api/generated/schema.d.ts`), `gen:api:check` (regenerate to a temp file and diff; nonzero on drift), `lint`, `typecheck`, `test`, `e2e`, `layout` (`node scripts/check-layout.mjs`), `check` (all of gen:api:check, layout, lint, typecheck, test).
- `src/api/client.ts`: `createClient<paths>({ baseUrl: "/api" })` + `createQueryClient` from openapi-react-query; one `QueryClientProvider` in a small client `providers.tsx` under `app/`.
- `src/ui/`: tokens as CSS variables in `app/globals.css` (`@theme`), primitives matching the screen files. Icons from `@phosphor-icons/react` (one family). Visible focus rings, 44 px targets.
- Dockerfile for Cloud Run: standalone server, copies `public/` and `.next/static`, `HOSTNAME=0.0.0.0`, `PORT` from env. `frontend/.env.example`: `API_URL=http://localhost:8000`.

## Ticket F2: session and proxy (security seam)

- `lib/server/session.ts` (`import "server-only"`): cookie `stepwise_session`, httpOnly, Secure (except on http://localhost), SameSite=Lax, Path=/, Max-Age = `expires_in`.
- `app/api/auth/signin|signup/route.ts`: POST to FastAPI, set the cookie, return 204 (never the token). `signout`: clear it.
- `app/api/[...path]/route.ts`: every method; forwards path, query, body and content-type to `API_URL`; adds `Authorization` from the cookie; rejects state-changing methods whose `Origin` is not the app's own (CSRF); on 401 clears the cookie. Streams the response body untouched, so `text/event-stream` passes through (`runtime = "nodejs"`, no buffering, `cache: "no-store"`, forward the client's abort signal).
- `/s/{slug}` is public: the proxy forwards it without a cookie.
- `src/proxy.ts`: redirect to `/sign-in?next=…` when the cookie is missing on `(app)` routes; signed-in users on `/sign-in` go to `/library`.
- Sign-in / sign-up screens with form errors (401 → "Email or password is wrong"). Unit tests for cookie flags and the Origin check.

## Ticket F3: recorder and upload

- `features/recorder/machine.ts`: a pure reducer `idle → choosing → recording ⇄ paused → stopping → recorded | error`, with a 15:00 auto-stop and a `noTabAudio` warning when the display stream has no audio track. TDD.
- `features/recorder/media.ts`: `getDisplayMedia({video, audio: true})` + `getUserMedia({audio})`, mixed with an `AudioContext` into one `MediaRecorder` stream (`video/webm;codecs=vp9,opus`, fallback vp8); a mic level meter; stops tracks on every exit path, including when the user ends sharing from Chrome's bar.
- `src/api/upload.ts`: after stop, `POST /videos` → PUT the blob to `upload_url` in 8 MiB chunks (a multiple of 256 KiB) with `Content-Range`; after a failed chunk, query `bytes */total` and resume from the `Range` the server returns (308); progress callback; then `POST /videos/{id}/uploaded` with `duration_s` (and width/height when known). TDD with a fake fetch.
- First step, before building: confirm the browser can PUT cross-origin to fake-gcs on `localhost:4443`. If CORS blocks it, add a CORS config for the fake-gcs bucket in `compose.yaml` or the dev setup, and note the real-GCS bucket CORS need in `docs/design/hld-lld.md`.
- Record screen per `Record.dc.html`.

## Ticket F4: library and recorded video

- Library (`Library.dc.html`): `GET /videos` with cursor paging (load more), status badges from `video.status` + `current_run`, empty state, skeletons, header from `GET /me`.
- Recorded video (`Recorded.dc.html`): playback from `playback_url`, "Process with AI" panel → `POST /videos/{id}/runs` `{mode, voice, voice_id?}` → go to `/runs/{run_id}`. The voice list is a placeholder option set until a voices endpoint exists; `voice = original` works today.

## Ticket F5: live progress

- `src/api/events.ts`: `new EventSource("/api/runs/{id}/events")`, typed listeners for `run.status`, `run.proposal_ready`, `run.done`, `run.failed` using the generated event types; closes on terminal events and on unmount.
- `features/runs/use-run-events.ts`: seeds from `GET /runs/{id}`, applies events to the TanStack Query cache (no duplicate local state), and re-reads `GET /runs/{id}` when the connection drops.
- Progress screen (`Progress.dc.html`): steps mapped from `status`/`stage`, activity feed, "Open review" when `awaiting_review`, auto mode → `/videos/{id}` on `done`, failed + retryable → retry (surface only; no retry endpoint yet), cancel → `POST /runs/{id}/cancel`.

## Ticket F6: review

- `GET /runs/{id}/proposal` → script blocks (editable text, est vs target duration), EDL rows with action and reasoning, timeline strip, flags highlighted (`Review.dc.html`).
- Edits are local until "Save edits" → `PUT /runs/{id}/proposal` (sends `version`; a 409 shows "Someone else saved a newer version" and reloads). "Approve and render" → `POST /runs/{id}/approve` → back to `/runs/{id}`. A 422 from approve shows the failing checks.
- Keyframe thumbnails may be empty (FixtureEngines); the UI must not break.

## Ticket F7: share and public page

- Done screen (`Share.dc.html`): `POST /videos/{id}/shares` with default `link`, copy link, Download MP4 (`playback_url`).
- `app/s/[slug]/page.tsx`: Server Component calling `GET /s/{slug}` server-side, `generateMetadata` (title, `og:video`, poster), `notFound()` on 404. Per `Public.dc.html`.

## Verification (after F7)

Coordinator-run gates from coding-powers `frontend-workflow.md`: browser click-through with screenshots at 1440 and 390 widths, `web-design-guidelines` audit, user feedback, one correction pass, re-audit, then `code-review` and `independent-behavior-verification`. React/Next rules from `vercel-react-best-practices` are review evidence, chiefly: `bundle-barrel-imports`, `bundle-dynamic-imports` (recorder and review are client islands), `async-parallel`, `server-serialization`, `rerender-derived-state-no-effect`, `rendering-conditional-render`.

## Correction pass (after the first visual audit and user feedback, 2026-10-18)

### Ticket P: persistent local storage and browser poster

- `compose.yaml`: fake-gcs keeps objects in `./.data/gcs` (`-backend filesystem -filesystem-root /storage` + bind mount); `.data/` in `.gitignore`. The bucket must still exist after a fresh start (create it if the app or migrate step does not).
- Backend: `POST /videos` also opens a resumable session for `videos/{id}/poster.jpg` → `VideoCreated.poster_upload_url`. `POST /videos/{id}/uploaded` sets `poster_uri` when that object exists (checked outside `tenant_tx`, like the raw object). `Video` gains `poster_url` (signed, null when absent). Tests; regenerate `openapi.json`; `npm run gen:api` in `frontend/`.
- Frontend: at stop, grab one frame from the live preview into a canvas → JPEG blob (about 1280 px wide) → `putResumable` to `poster_upload_url` before confirming; a poster failure never fails the video upload. Library cards and the video page use `poster_url` (gray box stays as the fallback).
- The real-duration check moves to phase 3 preprocess (see `docs/plan/phases.md`).

### Ticket A: accessibility and UX fixes from the web-interface-guidelines audit

1. Global `:focus-visible` ring in `globals.css` (`@layer base`), and visible focus on radio cards (`has-[:focus-visible]`) in video-screen and share-panel.
2. Reduced motion: a global `prefers-reduced-motion` rule; `motion-reduce:animate-none` on skeleton and the record dot.
3. Account menu: `aria-haspopup`/`aria-controls`, Escape and outside-click close, focus returns to the trigger.
4. Confirm before Discard recording, Cancel run, and Approve and render (a small `ui/confirm-dialog.tsx` on native `<dialog>`).
5. Live regions: run status headline `aria-live="polite"`; narrow the record-screen upload live region; no `role="alert"` inside `aria-live`; flagged review rows and blocks carry visible "Flagged" text, not color alone; review cut buttons have a constant label plus `aria-label` naming the span.
6. Disabled Retry: replace with visible text ("Retry is coming soon") instead of a title tooltip.
7. Touch targets ≥ 44 px (pause, stop, search, selects).
8. Bug: the AI voice select is controlled and its value is sent as `voice_id`.
9. Share: copy failure shows a message and selects the link; "Copied" announced; labels "Copy link" / "Share link".
10. Copy: busy labels end with "…"; curly quotes; "×" in dimensions; hyphenated "6-minute"; record limit text from `MAX_RECORDING_MS`; tokens instead of hard-coded hex (`text-danger`, `bg-record`).
11. Review cut rows readable in the two-column layout (reason text not squeezed by the time column and button).
