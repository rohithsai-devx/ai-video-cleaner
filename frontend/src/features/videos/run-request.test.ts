import { describe, expect, it } from "vitest";
import { runRequestBody } from "./run-request";

describe("runRequestBody", () => {
  it("sends the selected AI voice as voice_id", () => {
    expect(
      runRequestBody({
        mode: "review",
        voice: "ai",
        voiceId: "narrator-2",
        fixOptions: { pauses: true, filler: false, retakes: true, slow_parts: true },
      }),
    ).toEqual({
      mode: "review",
      voice: "ai",
      voice_id: "narrator-2",
      fix_options: { pauses: true, filler: false, retakes: true, slow_parts: true },
    });
  });

  it("omits voice_id for the original voice", () => {
    expect(
      runRequestBody({
        mode: "auto",
        voice: "original",
        voiceId: "narrator-2",
        fixOptions: { pauses: true, filler: true, retakes: true, slow_parts: true },
      }),
    ).toEqual({
      mode: "auto",
      voice: "original",
      fix_options: { pauses: true, filler: true, retakes: true, slow_parts: true },
    });
  });
});
