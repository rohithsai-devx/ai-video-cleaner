import { describe, expect, it } from "vitest";
import { runRequestBody } from "./run-request";

describe("runRequestBody", () => {
  it("sends the selected AI voice as voice_id", () => {
    expect(runRequestBody({ mode: "review", voice: "ai", voiceId: "narrator-2" })).toEqual({
      mode: "review",
      voice: "ai",
      voice_id: "narrator-2",
    });
  });

  it("omits voice_id for the original voice", () => {
    expect(runRequestBody({ mode: "auto", voice: "original", voiceId: "narrator-2" })).toEqual({
      mode: "auto",
      voice: "original",
    });
  });
});
