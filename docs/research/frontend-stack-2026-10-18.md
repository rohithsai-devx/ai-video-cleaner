# Frontend stack research (2026-10-18)

Versions and dates come from `npm view <pkg> time --json` (registry, checked 2026-10-18). Behavior claims come from the linked official docs, blog posts and repos. Anything not confirmed on a primary page is marked **unverified**.

## Recommendations

| Area | Pick | Version (published) |
| --- | --- | --- |
| Framework | Next.js, App Router, React 19 | `next` 16.4.2 (2026-10-15), `react` 19.3.1 (2026-10-14) |
| API client | `openapi-typescript` + `openapi-fetch` + `openapi-react-query` | 7.13.0 / 0.17.0 / 0.5.4 (all 2026-02-11) |
| Server state | TanStack Query v5 | `@tanstack/react-query` 5.104.4 (2026-10-17) |
| SSE | Hand-rolled `fetch` reader over `eventsource-parser` | `eventsource-parser` 4.1.2 (2026-10-12) |
| CSS | Tailwind CSS v4 with `@tailwindcss/postcss` | 4.3.3 (2026-07-16) |
| Unit tests | Vitest | `vitest` 5.0.5 (2026-10-15) |
| E2E tests | Playwright | `@playwright/test` 1.64.1 (2026-10-14) |

## 1. Next.js

| Claim | Source |
| --- | --- |
| Current stable is **16.4.2** (2026-10-15); 16.4.0 blog post is dated 2026-10-06. The 16.x line: 16.0 (2025-10-21), 16.1, 16.2 (2026-03-18), 16.3 (2026-08-03), 16.4. | [blog index](https://nextjs.org/blog), [next-16-4](https://nextjs.org/blog/next-16-4) |
| App Router is the default in `create-next-app`, TypeScript-first, Tailwind and ESLint included. 16.4 ships React 19.3 (stable View Transitions, Fragment Refs). `next` peer range is `react ^18.2 \|\| ^19`. | [next-16](https://nextjs.org/blog/next-16), [next-16-4](https://nextjs.org/blog/next-16-4), npm peerDependencies |
| **Caching:** caching is opt-in under Cache Components (`cacheComponents: true`, `'use cache'`); all dynamic code runs at request time by default. 16.4 recommends Cache Components for every app, enables it by default in new `create-next-app` projects, and says it becomes the default in Next.js 17. It needs `partialPrefetching: true` too. | [next-16](https://nextjs.org/blog/next-16), [next-16-4](https://nextjs.org/blog/next-16-4) |
| **Turbopack** is the default bundler for dev and build since 16.0; opt out with `next dev --webpack` / `next build --webpack`. | [next-16](https://nextjs.org/blog/next-16) |
| **`middleware.ts` is deprecated; use `proxy.ts`** (export `proxy`, Node.js runtime). `middleware.ts` stays only for Edge use and will be removed. | [next-16](https://nextjs.org/blog/next-16) |
| **React Compiler:** stable support since 16.0 but **off by default** (`reactCompiler: true`, needs `babel-plugin-react-compiler`, slower builds). A Rust version is experimental in 16.3/16.4 (`experimental.turbopackRustReactCompiler`). | [next-16](https://nextjs.org/blog/next-16), [next-16-4](https://nextjs.org/blog/next-16-4) |
| Other 16.0 changes that hit us: Node.js 20.9+ and TypeScript 5.1+ required; `params`, `searchParams`, `cookies()`, `headers()` are async only; `next lint` removed; parallel route slots need `default.js`. | [next-16](https://nextjs.org/blog/next-16) |
| **Cloud Run:** set `output: 'standalone'` to get `.next/standalone` with a minimal `server.js` and traced `node_modules`. It does **not** copy `public/` or `.next/static` by default (meant for a CDN); copy them into `standalone/public` and `standalone/.next/static` in the Dockerfile. Run with `PORT=8080 HOSTNAME=0.0.0.0 node server.js` (Cloud Run injects `PORT`; `HOSTNAME` must be `0.0.0.0`). For monorepos set `outputFileTracingRoot`. | [output docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/output) |

**Recommendation:** Next 16.4.x, App Router, React 19.3. This is a client-heavy app behind a bearer JWT held in the browser, so most pages will be Client Components; Cache Components buys little there. Decide deliberately whether to enable `cacheComponents` (the default for new apps) or turn it off in `create-next-app`. Leave the React Compiler off at first, since it is opt-in and slows builds. Use `proxy.ts`, not `middleware.ts`, if a request hook is needed. Pin `next` exactly; minors ship every 1 to 2 months.

## 2. OpenAPI to TypeScript client

| | `openapi-typescript` + `openapi-fetch` | `@hey-api/openapi-ts` | `orval` |
| --- | --- | --- | --- |
| Latest | 7.13.0 / 0.17.0 (2026-02-11); `openapi-react-query` 0.5.4 (2026-02-11) | 0.99.0 (2026-06-22) | 8.43.0 (2026-10-14) |
| OpenAPI 3.1 | Yes, "3.0 & 3.1" ([README](https://github.com/openapi-ts/openapi-typescript/blob/main/packages/openapi-typescript/README.md)) | Docs say "any OpenAPI specification"; 3.1 not named (**unverified**) ([get-started](https://heyapi.dev/openapi-ts/get-started)) | README says "any valid OpenAPI v3 or Swagger v2"; 3.1 not named (**unverified**) |
| Runtime | `openapi-fetch` "6 kb", 229 KB unpacked, one tiny dep; types are zero-runtime ([docs](https://openapi-ts.dev/openapi-fetch/)) | Generated client is bundled into your output; no size figure published (**unverified**) | Generated fetch/axios functions; no fixed runtime; query hooks use `@tanstack/react-query` |
| TanStack Query | Separate `openapi-react-query` (`useQuery`, `useMutation`, ...), thin wrapper over `openapi-fetch` | Plugin `@tanstack/react-query` generates `queryOptions`, `infiniteQueryOptions`, `mutationOptions` and keys, "TanStack Query v5 support" ([docs](https://heyapi.dev/openapi-ts/plugins/tanstack-query)) | Generates one hook per operation with `client: 'react-query'` ([docs](https://orval.dev/docs/guides/react-query)) |
| Auth | `openapi-fetch` middleware (`onRequest`) | `auth` as string or function, request/response interceptors ([fetch client](https://heyapi.dev/openapi-ts/clients/fetch)) | Custom mutator function |
| Maintenance | Repo pushed 2026-09-25, not archived; last npm release 2026-02-11 (8 months ago); 210 open issues ([releases](https://github.com/openapi-ts/openapi-typescript/releases)) | Repo pushed 2026-09-30; releases roughly monthly; pre-1.0, breaking changes in minors, docs say pin an exact version | Repo pushed 2026-10-17; v8 since 2026-01-14; frequent releases |
| Output | One `schema.d.ts` file, no generated runtime code | Several generated files (SDK, types, query options) | Several generated files (hooks, schemas, optional mocks) |

**Recommendation:** `openapi-typescript` + `openapi-fetch` + `openapi-react-query`. Reasons: it states OpenAPI 3.1 support explicitly, generates only types (diffable against the committed `openapi.json`), and the client is a small fetch wrapper. Auth middleware gives one place to attach the JWT and handle 401. Hooks stay thin and can fall back to plain `useQuery({ queryFn })` with `openapi-fetch` if `openapi-react-query` lacks something. Risk: the last release is from February 2026, so check the issue tracker before relying on a fix landing. `@hey-api/openapi-ts` is the runner-up if we want generated `queryOptions` (pin exact; pre-1.0). Choose it instead if its SSE support is confirmed useful (not found in the docs read: **unverified**).

## 3. TanStack Query

| Claim | Source |
| --- | --- |
| Current major is **v5**: `@tanstack/react-query` 5.104.4 (2026-10-17). v5.0.0 was published 2023-10-17; no v6 on the registry. Peer range `react ^18 \|\| ^19`. | npm registry (`npm view @tanstack/react-query time`) |

## 4. SSE client with an Authorization header

| Option | Status | Fits? |
| --- | --- | --- |
| `@microsoft/fetch-event-source` 2.0.1 | Last npm release 2021-04-25; last commit 2023-02-03; repo not archived, 74 open issues. Maintenance has effectively stopped. Sends custom headers via `fetch`. ([repo](https://github.com/Azure/fetch-event-source)) | Works but unmaintained. Do not adopt. |
| `eventsource-parser` 4.1.2 (2026-10-12) | Actively maintained; 97 KB unpacked, no dependencies; parser only, you own the `fetch` call ([repo](https://github.com/rexxars/eventsource-parser)) | Best base. |
| `eventsource` 5.1.3 (2026-10-14) | Active; depends on `eventsource-parser`. Since v3 the `headers` option is gone: pass a custom `fetch` that merges `Authorization` ([MIGRATION.md](https://github.com/EventSource/eventsource/blob/main/MIGRATION.md), [README](https://github.com/EventSource/eventsource)). Needs Node 22.12+ or modern browsers. | Works in the browser with a `fetch` override; adds the `EventSource` API (auto-reconnect, `Last-Event-ID`). |
| `eventsource-client` (rexxars) | fetch + Web Streams, browser and Node ([repo](https://github.com/rexxars/eventsource-client)). Version and release date not checked (**unverified**). | Alternative; not evaluated further. |

**Recommendation:** a small hand-rolled reader over `eventsource-parser`: `fetch(url, { headers: { Authorization, Accept: 'text/event-stream', 'Last-Event-ID' }, signal })`, pipe `response.body` through `TextDecoderStream` into the parser, and wrap it in a hook that aborts on unmount. Own the reconnect loop so it can handle the 30-minute JWT expiry: on 401, stop and surface "session expired" instead of retrying. The `eventsource` package with a fetch override is the fallback if built-in reconnect is wanted. Check the parser's exact API (`createParser({ onEvent })`, `parser.feed(chunk)`) against the 4.1.2 README before coding (**unverified** here).

## 5. Tailwind CSS

| Claim | Source |
| --- | --- |
| Current major is **v4**: `tailwindcss` 4.3.3 and `@tailwindcss/postcss` 4.3.3 (both 2026-07-16). | npm registry |
| Next.js setup: `npm install tailwindcss @tailwindcss/postcss postcss`; `postcss.config.mjs` with `plugins: { "@tailwindcss/postcss": {} }`; `@import "tailwindcss";` in `app/globals.css`. No `tailwind.config.js` needed. `create-next-app` includes Tailwind. | [Tailwind guide](https://tailwindcss.com/docs/guides/nextjs), [next-16](https://nextjs.org/blog/next-16) |
| Next 16.2 supports `postcss.config.ts`. | [blog index](https://nextjs.org/blog) |

## 6. Test tooling

| Claim | Source |
| --- | --- |
| Next.js docs have guides for both Vitest and Jest (both last updated 2026-08-25) and for Playwright and Cypress. No preference is stated in the pages read. Both say async Server Components are unsupported in unit tests and should get E2E tests. | [Vitest](https://nextjs.org/docs/app/guides/testing/vitest), [Jest](https://nextjs.org/docs/app/guides/testing/jest) |
| Vitest setup: `vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/dom vite-tsconfig-paths`, `vitest.config.mts` with `environment: 'jsdom'`. Vitest 5.0.5 (2026-10-15). Jest is 30.5.2 (2026-09-18) and uses `next/jest`. | docs above, npm registry |
| Playwright **1.64.1** (2026-10-14); 1.64 notes list Chromium 156, Firefox 157, WebKit 27.2. | [release notes](https://playwright.dev/docs/release-notes), npm registry |

**Recommendation:** Vitest + React Testing Library for unit and hook tests (works with ESM and TypeScript with no `next/jest` shim; mock the API with the typed `openapi-fetch` client or MSW, MSW not checked), Playwright for E2E including the SSE flow and the upload path. Vitest's "recommended" status is my judgment, not a Next.js statement.

## Open items

- No source states that Next.js prefers Vitest over Jest.
- `@hey-api/openapi-ts` and `orval` OpenAPI 3.1 support, and `@hey-api/openapi-ts` SSE support, were not confirmed on a primary page.
- Whether `openapi-react-query` 0.5.x works with TanStack Query 5.104 was not tested. Spike it before committing.
