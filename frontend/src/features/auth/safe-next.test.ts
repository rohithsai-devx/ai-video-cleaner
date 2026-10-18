import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth-messages";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps same-site relative paths", () => {
    expect(safeNext("/videos/abc?tab=1")).toBe("/videos/abc?tab=1");
  });
  it("falls back to /library for missing or off-site targets", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "library",
      "/\t/evil.example",
      "/\n/evil.example",
      "/\r\n/evil.example",
      "/\t\\evil.example",
    ]) {
      expect(safeNext(bad)).toBe("/library");
    }
  });
});

describe("authErrorMessage", () => {
  it("maps 401 to the wrong-credentials copy", () => {
    expect(authErrorMessage("sign-in", 401)).toBe("Email or password is wrong");
  });
  it("maps 409 on sign-up to an existing account", () => {
    expect(authErrorMessage("sign-up", 409)).toMatch(/already exists/);
  });
});
