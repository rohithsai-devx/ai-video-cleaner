import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { POST } = await import("./route");
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  process.env.API_URL = "http://api.test";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function signin(origin = "http://localhost:3000"): Request {
  return new Request("http://localhost:3000/api/auth/signin", {
    method: "POST",
    headers: { host: "localhost:3000", origin, "content-type": "application/json" },
    body: JSON.stringify({ email: "a@b.co", password: "pw" }),
  });
}

describe("POST /api/auth/signin", () => {
  it("sets the httpOnly cookie and returns 204 with no token in the body", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ access_token: "secret-token", expires_in: 3600, token_type: "bearer" }),
    );
    const res = await POST(signin());
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("set-cookie")).toMatch(
      /^stepwise_session=secret-token;.*Max-Age=3600.*HttpOnly/,
    );
  });

  it("passes a 401 through without a cookie", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ detail: "invalid email or password" }, { status: 401 }),
    );
    const res = await POST(signin());
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a foreign Origin", async () => {
    const res = await POST(signin("https://evil.example"));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
