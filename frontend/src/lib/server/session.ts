import "server-only";
import { SESSION_COOKIE } from "./cookie-name";

// The FastAPI bearer token lives only in this httpOnly cookie. Client JS never sees it,
// and no route handler ever puts it in a response body.
export { SESSION_COOKIE };

export type SessionCookieOptions = {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function sessionCookieOptions(requestUrl: string, maxAge: number): SessionCookieOptions {
  const url = new URL(requestUrl);
  const insecureLocal = url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname);
  return { httpOnly: true, secure: !insecureLocal, sameSite: "lax", path: "/", maxAge };
}

function serialize(value: string, opts: SessionCookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookie(
  res: Response,
  requestUrl: string,
  token: string,
  expiresIn: number,
): void {
  res.headers.append(
    "set-cookie",
    serialize(encodeURIComponent(token), sessionCookieOptions(requestUrl, expiresIn)),
  );
}

export function clearSessionCookie(res: Response, requestUrl: string): void {
  res.headers.append("set-cookie", serialize("", sessionCookieOptions(requestUrl, 0)));
}

export function readSession(req: Request): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1).trim()) || null;
    } catch {
      return null; // malformed cookie: treat as signed out
    }
  }
  return null;
}
