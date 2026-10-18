import "server-only";
import type { components } from "@/api/generated/schema";
import { isAllowedOrigin } from "./origin";
import { clearSessionCookie, setSessionCookie } from "./session";
import { jsonError, upstreamFetch } from "./upstream";

type IssuedToken = components["schemas"]["Token"];

/**
 * POSTs credentials to FastAPI, stores the issued token in the httpOnly cookie and
 * answers 204. The token never appears in the response body.
 */
export async function exchangeCredentials(
  req: Request,
  upstreamPath: "/auth/signin" | "/auth/signup",
): Promise<Response> {
  if (!isAllowedOrigin(req)) return jsonError(403, "cross-origin request refused");

  let upstream: Response;
  try {
    upstream = await upstreamFetch(upstreamPath, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: await req.text(),
      signal: req.signal,
    });
  } catch (err) {
    console.error("auth upstream failed", err);
    return jsonError(502, "API unavailable");
  }

  if (!upstream.ok) {
    // Error bodies carry only `detail`; pass them through for form messages.
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  }

  const token = (await upstream.json()) as IssuedToken;
  const res = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  setSessionCookie(res, req.url, token.access_token, token.expires_in);
  return res;
}

export function signOut(req: Request): Response {
  if (!isAllowedOrigin(req)) return jsonError(403, "cross-origin request refused");
  const res = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  clearSessionCookie(res, req.url);
  return res;
}
