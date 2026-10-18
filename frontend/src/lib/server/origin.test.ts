import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isAllowedOrigin } = await import("./origin");

function req(method: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/videos", { method, headers });
}

describe("Origin check", () => {
  it("lets safe methods through without an Origin", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) expect(isAllowedOrigin(req(m))).toBe(true);
  });

  it("accepts state-changing methods from the app's own origin", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        isAllowedOrigin(req(m, { origin: "http://localhost:3000", host: "localhost:3000" })),
      ).toBe(true);
    }
  });

  it("rejects a foreign Origin", () => {
    expect(
      isAllowedOrigin(req("POST", { origin: "https://evil.example", host: "localhost:3000" })),
    ).toBe(false);
    expect(
      isAllowedOrigin(req("DELETE", { origin: "http://localhost:3001", host: "localhost:3000" })),
    ).toBe(false);
  });

  it("rejects a missing or opaque Origin on state-changing methods", () => {
    expect(isAllowedOrigin(req("POST", { host: "localhost:3000" }))).toBe(false);
    expect(isAllowedOrigin(req("POST", { origin: "null", host: "localhost:3000" }))).toBe(false);
  });

  it("uses the forwarded host and proto behind a load balancer", () => {
    const r = req("POST", {
      origin: "https://app.example.com",
      host: "internal:8080",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
    });
    expect(isAllowedOrigin(r)).toBe(true);
    const wrongProto = req("POST", {
      origin: "http://app.example.com",
      host: "internal:8080",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https",
    });
    expect(isAllowedOrigin(wrongProto)).toBe(false);
  });
});
