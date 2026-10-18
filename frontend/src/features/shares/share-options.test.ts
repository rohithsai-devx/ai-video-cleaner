import { describe, expect, it } from "vitest";
import { absoluteShareUrl, expiryToIso, VISIBILITY_OPTIONS } from "./share-options";

describe("absoluteShareUrl", () => {
  it("keeps absolute urls", () => {
    expect(absoluteShareUrl("https://x.io/s/abc", "http://localhost:3000")).toBe(
      "https://x.io/s/abc",
    );
  });
  it("resolves a path against the origin", () => {
    expect(absoluteShareUrl("/s/abc", "http://localhost:3000")).toBe("http://localhost:3000/s/abc");
  });
});

describe("expiryToIso", () => {
  const now = new Date("2026-10-18T00:00:00.000Z");
  it("is null for never", () => expect(expiryToIso("never", now)).toBeNull());
  it("adds days", () => {
    expect(expiryToIso("7d", now)).toBe("2026-10-25T00:00:00.000Z");
    expect(expiryToIso("30d", now)).toBe("2026-11-17T00:00:00.000Z");
  });
});

describe("VISIBILITY_OPTIONS", () => {
  it("has no em-dashes", () => {
    expect(JSON.stringify(VISIBILITY_OPTIONS)).not.toContain("—");
  });
});
