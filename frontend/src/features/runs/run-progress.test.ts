import { describe, expect, it } from "vitest";
import type { components } from "@/api/generated/schema";
import { applyRunEvent, buildSteps, isTerminal, logLine } from "./run-progress";

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

describe("applyRunEvent", () => {
  it("applies status, proposal flags, failure and done onto the cached run", () => {
    let r = applyRunEvent(run, {
      type: "run.status",
      data: { status: "agent_running", stage: "agent" },
    });
    expect(r).toMatchObject({ status: "agent_running", stage: "agent" });
    r = applyRunEvent(r, {
      type: "run.proposal_ready",
      data: { version: 1, flags: ["f"], auto_approved: false },
    });
    expect(r.flags).toEqual(["f"]);
    const err = { stage: "render", message: "boom", retryable: true };
    expect(applyRunEvent(r, { type: "run.failed", data: err })).toMatchObject({
      status: "failed",
      error: err,
    });
    expect(
      applyRunEvent(r, { type: "run.done", data: { video_id: "v1", output_uri: "x" } }).status,
    ).toBe("done");
  });
});

describe("isTerminal", () => {
  it("is true only for done, failed and cancelled", () => {
    expect(["done", "failed", "cancelled"].map((s) => isTerminal(s as Run["status"]))).toEqual([
      true,
      true,
      true,
    ]);
    expect(isTerminal("awaiting_review")).toBe(false);
  });
});

describe("buildSteps", () => {
  it("marks earlier steps done and the current one active", () => {
    const steps = buildSteps({ ...run, status: "agent_running" });
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "active", "todo", "todo"]);
  });
  it("waits at review without pulsing and skips it in auto mode", () => {
    expect(buildSteps({ ...run, status: "awaiting_review" })[3]).toMatchObject({
      state: "active",
      waiting: true,
    });
    expect(buildSteps({ ...run, mode: "auto", status: "postprocessing" })[3].label).toBe(
      "Your review (skipped)",
    );
  });
  it("marks the failed step", () => {
    const steps = buildSteps({
      ...run,
      status: "failed",
      error: { stage: "render", message: "x", retryable: false },
    });
    expect(steps[4].state).toBe("failed");
  });
  it("completes everything when done", () => {
    expect(buildSteps({ ...run, status: "done" }).every((s) => s.state === "done")).toBe(true);
  });
});

describe("logLine", () => {
  it("formats events for the activity feed without em-dashes", () => {
    expect(
      logLine({ type: "run.status", data: { status: "preprocessing", stage: "preprocess" } }),
    ).toBe("run.status preprocessing / preprocess");
    expect(
      logLine({
        type: "run.proposal_ready",
        data: { version: 2, flags: ["a", "b"], auto_approved: false },
      }),
    ).toBe("run.proposal_ready v2, 2 flags");
  });
});
