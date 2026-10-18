import { describe, expect, it } from "vitest";
import { formatDuration, statusBadge, videoHref } from "./video-status";

const run = { run_id: "r1", status: "queued" as const };

describe("videoHref", () => {
  it("sends uploaded and ready videos to the video page", () => {
    expect(videoHref({ id: "v1", status: "uploaded", current_run: null })).toBe("/videos/v1");
    expect(videoHref({ id: "v1", status: "ready", current_run: run })).toBe("/videos/v1");
  });
  it("sends live states to the run page", () => {
    for (const status of ["processing", "awaiting_review", "rendering"] as const) {
      expect(videoHref({ id: "v1", status, current_run: run })).toBe("/runs/r1");
    }
  });
  it("falls back to the video page without a run", () => {
    expect(videoHref({ id: "v1", status: "processing", current_run: null })).toBe("/videos/v1");
  });
});

describe("statusBadge", () => {
  it("labels states", () => {
    expect(statusBadge({ status: "awaiting_review" })).toEqual({
      label: "Needs review",
      tone: "warning",
    });
    expect(statusBadge({ status: "uploaded" }).label).toBe("Uploaded");
  });
});

describe("formatDuration", () => {
  it("formats m:ss", () => {
    expect(formatDuration(207.4)).toBe("3:27");
    expect(formatDuration(null)).toBe("");
  });
});
