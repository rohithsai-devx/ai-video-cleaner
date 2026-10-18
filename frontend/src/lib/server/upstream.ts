import "server-only";
import { isAllowedOrigin } from "./origin";
import { clearSessionCookie, readSession } from "./session";

const FORWARD_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "last-event-id",
  "range",
  "if-none-match",
];
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "content-disposition",
  "cache-control",
  "etag",
  "location",
  "accept-ranges",
  "retry-after",
  "www-authenticate",
];

export function apiBaseUrl(): string {
  // Local dev falls back to the compose API; production must set API_URL explicitly.
  const base =
    process.env.API_URL || (process.env.NODE_ENV === "production" ? "" : "http://localhost:8000");
  if (!base) throw new Error("API_URL is not set");
  return base.replace(/\/+$/, "");
}

/** Server-side call to FastAPI. Only lib/server and app/api use it. */
export function upstreamFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${apiBaseUrl()}${path}`, { cache: "no-store", redirect: "manual", ...init });
}

export function jsonError(status: number, detail: string): Response {
  return Response.json({ detail }, { status, headers: { "cache-control": "no-store" } });
}

/** True for the public share page, which goes upstream without the session. */
export function isPublicPath(path: string): boolean {
  return /^\/s\/[^/]+\/?$/.test(path);
}

/**
 * The /api/[...path] proxy: forwards method, path, query, body and content-type to API_URL,
 * adds Authorization from the cookie, and streams the response body back untouched.
 */
export async function proxyToApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api(?=\/)/, "");

  // Auth endpoints return the raw token; only the dedicated route handlers may call them.
  // Refuse encoded separators so `/auth%2Fsignin` cannot slip past this check and be decoded upstream.
  if (/%2f|%5c/i.test(path)) return jsonError(400, "bad path");
  if (/^\/auth(\/|$)/i.test(path)) return jsonError(404, "not found");
  if (!isAllowedOrigin(req)) return jsonError(403, "cross-origin request refused");

  const headers = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const token = isPublicPath(path) ? null : readSession(req);
  if (token) headers.set("authorization", `Bearer ${token}`);

  const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
  let upstream: Response;
  try {
    upstream = await upstreamFetch(`${path}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      signal: req.signal,
      // Required by Node's fetch when the body is a stream.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("upstream fetch failed", err);
    return jsonError(502, "API unavailable");
  }

  const out = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // A redirect to the API's own host would leak the internal URL and bypass the proxy; map it onto /api.
  const location = out.get("location");
  if (location) {
    const target = new URL(location, `${apiBaseUrl()}/`);
    if (target.origin === new URL(apiBaseUrl()).origin) {
      out.set("location", `/api${target.pathname}${target.search}`);
    } else {
      out.delete("location");
    }
  }
  // Node's fetch already decoded the body, so the upstream length no longer applies.
  if (upstream.headers.get("content-encoding")) out.delete("content-length");
  if (out.get("content-type")?.startsWith("text/event-stream")) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  }

  const res = new Response(req.method.toUpperCase() === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
  if (upstream.status === 401 && !isPublicPath(path)) clearSessionCookie(res, req.url);
  return res;
}
