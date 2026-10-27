import { describe, expect, it } from "vitest";
import type { components } from "@/api/generated/schema";
import { applyRunEvent, buildSteps, isTerminal, runChoicesLabel, runHeader } from "./run-progress";

type Run = components["schemas"]["Run"];
const run: Run = {
  id: "r1",
  video_id: "v1",
  status: "queued",
  stage: null,
  mode: "review",
  voice: "original",
  attempt: 1,
  flags: [],
  created_at: "2026-10-18T10:00:00Z",
};

const states = (value: Run) => buildSteps(value).map((step) => step.state);

describe("applyRunEvent", () => {
  it("applies status, proposal flags, failure and done onto the cached run", () => {
    let current = applyRunEvent(run, {
      type: "run.status",
      data: { status: "agent_running", stage: "agent" },
    });
    expect(current).toMatchObject({ status: "agent_running", stage: "agent" });
    current = applyRunEvent(current, {
      type: "run.proposal_ready",
      data: { version: 1, flags: ["f"], auto_approved: false },
    });
    expect(current.flags).toEqual(["f"]);
    const error = { stage: "4", message: "boom", retryable: true };
    expect(applyRunEvent(current, { type: "run.failed", data: error })).toMatchObject({
      status: "failed",
      error,
    });
    expect(
      applyRunEvent(current, { type: "run.done", data: { video_id: "v1", output_uri: "x" } })
        .status,
    ).toBe("done");
  });

  it("leaves progress events outside the cached run", () => {
    expect(
      applyRunEvent(run, {
        type: "run.progress",
        data: { pauses: 6, filler: 3, retakes: 3, slow_parts: 2 },
      }),
    ).toBe(run);
  });
});

describe("isTerminal", () => {
  it("is true only for done, failed and cancelled", () => {
    expect(
      ["done", "failed", "cancelled"].map((status) => isTerminal(status as Run["status"])),
    ).toEqual([true, true, true]);
    expect(isTerminal("awaiting_review")).toBe(false);
  });
});

describe("buildSteps", () => {
  it.each([
    ["queued", ["current", "current", "next", "next"]],
    ["preprocessing", ["current", "current", "next", "next"]],
    ["agent_running", ["done", "done", "current", "next"]],
    ["awaiting_review", ["done", "done", "done", "done"]],
    ["approved", ["done", "done", "done", "current"]],
    ["postprocessing", ["done", "done", "done", "current"]],
    ["done", ["done", "done", "done", "done"]],
  ] as const)("maps %s to the four user steps", (status, expected) => {
    expect(states({ ...run, status })).toEqual(expected);
  });

  it("uses the screen copy and details for a running proposal", () => {
    expect(buildSteps({ ...run, status: "agent_running" })).toEqual([
      {
        label: "Listening to your narration",
        detail: "Found what you said and when you said it.",
        state: "done",
      },
      {
        label: "Watching your screen",
        detail: "Found the parts of your screen recording.",
        state: "done",
      },
      {
        label: "Planning the cuts",
        detail: "Choosing what to remove, speed up or keep.",
        state: "current",
      },
      { label: "Getting it ready for you", detail: "Next", state: "next" },
    ]);
  });

  it("includes known chapters in the watching step detail", () => {
    expect(
      buildSteps({ ...run, status: "agent_running" }, [
        { title: "Sign In", start: 0, end: 15 },
        { title: "Create the Project", start: 15, end: 42 },
      ])[1]?.detail,
    ).toBe("Found 2 chapters: sign in, create the project.");
  });

  it("shows approved changes and render progress with the required details", () => {
    expect(buildSteps({ ...run, status: "awaiting_review" }).map((step) => step.detail)).toEqual([
      "Found what you said and when you said it.",
      "Found the parts of your screen recording.",
      "Chose what to remove, speed up or keep.",
      "Lined every change up on the timeline.",
    ]);
    expect(buildSteps({ ...run, status: "postprocessing" })[3]).toEqual({
      label: "Getting it ready for you",
      detail: "Rendering your video.",
      state: "current",
    });
  });

  it.each([
    ["1", ["failed", "next", "next", "next"]],
    ["3", ["done", "done", "failed", "next"]],
    ["4", ["done", "done", "done", "failed"]],
  ] as const)("marks only step %s as failed", (stage, expected) => {
    const failedRun: Run = {
      ...run,
      status: "failed",
      error: { stage, message: "The safe explanation.", retryable: false },
    };
    expect(states(failedRun)).toEqual(expected);
    expect(buildSteps(failedRun).find((step) => step.state === "failed")?.detail).toBe(
      "This step stopped. Nothing you did caused it.",
    );
  });

  it("keeps a cancelled run at its last completed point without a current step", () => {
    const cancelled = buildSteps({ ...run, status: "cancelled", stage: "agent" });
    expect(cancelled.map((step) => step.state)).toEqual(["done", "done", "next", "next"]);
    expect(cancelled.some((step) => step.state === "current")).toBe(false);
  });
});

describe("runHeader", () => {
  it.each([
    ["queued", null, "Cleaning your video", "Step 1 of 4"],
    ["preprocessing", null, "Cleaning your video", "Step 1 of 4"],
    ["agent_running", null, "Cleaning your video", "Step 3 of 4"],
    ["awaiting_review", null, "Ready for you", "Nothing renders until you approve."],
    ["approved", null, "Cleaning your video", "Step 4 of 4"],
    ["postprocessing", null, "Cleaning your video", "Step 4 of 4"],
    ["done", null, "Ready for you", "Your video is ready."],
    [
      "failed",
      { stage: "3", message: "safe", retryable: true },
      "Cleaning stopped",
      "Step 3 of 4 didn't finish.",
    ],
    ["cancelled", null, "Cleaning stopped", "You stopped this run. The recording is safe."],
  ] as const)("describes %s without internal stage names", (status, error, title, detail) => {
    expect(runHeader({ ...run, status, error })).toEqual({ title, detail });
  });

  it("uses the failure stage from the safe error event", () => {
    expect(
      runHeader({
        ...run,
        status: "failed",
        error: { stage: "4", message: "x", retryable: false },
      }),
    ).toEqual({
      title: "Cleaning stopped",
      detail: "Step 4 of 4 didn't finish.",
    });
  });
});

describe("runChoicesLabel", () => {
  it("uses plain words for the voice and render choice", () => {
    expect(runChoicesLabel(run)).toBe("My voice · I review first");
    expect(runChoicesLabel({ ...run, voice: "ai", mode: "auto" })).toBe(
      "AI voice · Renders straight away",
    );
  });
});
