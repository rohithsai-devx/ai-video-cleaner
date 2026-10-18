import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { SESSION_COOKIE, clearSessionCookie, readSession, sessionCookieOptions, setSessionCookie } =
  await import("./session");

function header(res: Response): string {
  return res.headers.get("set-cookie") ?? "";
}

describe("session cookie", () => {
  it("is named stepwise_session", () => {
    expect(SESSION_COOKIE).toBe("stepwise_session");
  });

  it("is httpOnly, Lax, Path=/ and lives for expires_in", () => {
    const opts = sessionCookieOptions("https://app.example.com/api/auth/signin", 3600);
    expect(opts).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3600,
      secure: true,
    });
  });

  it("drops Secure only on http://localhost", () => {
    expect(sessionCookieOptions("http://localhost:3000/x", 60).secure).toBe(false);
    expect(sessionCookieOptions("http://127.0.0.1:3000/x", 60).secure).toBe(false);
    expect(sessionCookieOptions("http://app.example.com/x", 60).secure).toBe(true);
  });

  it("writes the flags into Set-Cookie", () => {
    const res = new Response(null, { status: 204 });
    setSessionCookie(res, "https://app.example.com/api/auth/signin", "tok123", 900);
    const c = header(res);
    expect(c).toMatch(/^stepwise_session=tok123;/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Secure/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/Max-Age=900/);
  });

  it("clears with Max-Age=0 and the same flags", () => {
    const res = new Response(null, { status: 204 });
    clearSessionCookie(res, "http://localhost:3000/api/auth/signout");
    const c = header(res);
    expect(c).toMatch(/^stepwise_session=;/);
    expect(c).toMatch(/Max-Age=0/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).not.toMatch(/Secure/i);
  });

  it("reads the token from the Cookie header", () => {
    const req = new Request("http://localhost:3000/api/me", {
      headers: { cookie: "a=1; stepwise_session=abc.def; b=2" },
    });
    expect(readSession(req)).toBe("abc.def");
    expect(readSession(new Request("http://localhost:3000/api/me"))).toBeNull();
    const bad = new Request("http://localhost:3000/api/me", {
      headers: { cookie: `${SESSION_COOKIE}=%E0%A4%A` },
    });
    expect(readSession(bad)).toBeNull();
  });
});
