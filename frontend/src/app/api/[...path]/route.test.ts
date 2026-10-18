import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const route = await import("./route");

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  process.env.API_URL = "http://api.test";
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Request {
  return new Request(`http://localhost:3000/api${path}`, {
    method,
    headers: { host: "localhost:3000", ...headers },
    body,
  });
}

describe("/api/[...path] proxy", () => {
  it("forwards path, query and Authorization from the cookie", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const res = await route.GET(call("GET", "/videos?limit=5", { cookie: "stepwise_session=tok" }));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/videos?limit=5");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
    expect(init?.cache).toBe("no-store");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards a POST body and content-type from the same origin", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const res = await route.POST(
      call(
        "POST",
        "/videos",
        { origin: "http://localhost:3000", "content-type": "application/json" },
        '{"a":1}',
      ),
    );
    expect(res.status).toBe(201);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(await new Response(init.body).text()).toBe('{"a":1}');
  });

  it("refuses a foreign Origin without calling upstream", async () => {
    const res = await route.POST(call("POST", "/videos", { origin: "https://evil.example" }, "{}"));
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the cookie on upstream 401", async () => {
    fetchMock.mockResolvedValue(Response.json({ detail: "expired" }, { status: 401 }));
    const res = await route.GET(call("GET", "/me", { cookie: "stepwise_session=old" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toMatch(/^stepwise_session=;.*Max-Age=0/);
  });

  it("sends /s/{slug} upstream without the session", async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    await route.GET(call("GET", "/s/abc123", { cookie: "stepwise_session=tok" }));
    expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).has("authorization")).toBe(false);
  });

  it("never exposes upstream auth endpoints", async () => {
    const res = await route.POST(
      call("POST", "/auth/signin", { origin: "http://localhost:3000" }, "{}"),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses encoded path separators, so /auth%2Fsignin cannot reach upstream", async () => {
    const res = await route.POST(
      call("POST", "/auth%2Fsignin", { origin: "http://localhost:3000" }, "{}"),
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an upstream redirect to the API host back onto /api", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: "http://api.test/videos?cursor=x" } }),
    );
    const res = await route.GET(call("GET", "/videos/"));
    expect(res.headers.get("location")).toBe("/api/videos?cursor=x");
  });

  it("drops an upstream redirect to any other host", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } }),
    );
    const res = await route.GET(call("GET", "/videos"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("streams text/event-stream through untouched", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("event: status\ndata: {}\n\n"));
        c.close();
      },
    });
    const upstreamBody = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    fetchMock.mockResolvedValue(upstreamBody);
    const res = await route.GET(call("GET", "/runs/r1/events", { cookie: "stepwise_session=t" }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(await res.text()).toBe("event: status\ndata: {}\n\n");
  });
});
