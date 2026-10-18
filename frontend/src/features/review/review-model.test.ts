import { describe, expect, it } from "vitest";
import {
  conflictCode,
  effectiveEntries,
  failingChecks,
  flagHeading,
  flaggedRefIds,
  isDirty,
  isReviewable,
  outputLength,
  toUpdate,
  type Entry,
  type ProposalDoc,
} from "./review-model";

const entry = (
  seg_id: string,
  action: Entry["action"],
  src: [number, number],
  extra: Partial<Entry> = {},
): Entry => ({
  seg_id,
  action,
  src,
  speed: 1,
  freeze_s: 0,
  reasoning: "r",
  block_id: null,
  ...extra,
});

const base = {
  run_id: "r",
  version: 1,
  source: "agent",
  flags: [],
  checks: [],
  seg_contexts: [],
  transcript_ctx: {},
  script: {
    style: "clean",
    blocks: [
      {
        block_id: "b1",
        text: "Hello",
        est_dur: 3,
        seg_ids: ["s2"],
        source_span: [9, 31],
        target_min: 2,
        target_max: 5,
      },
    ],
  },
  edit_plan: {
    entries: [
      entry("s1", "cut", [0, 9]),
      entry("s2", "keep", [9, 31]),
      entry("s3", "speed", [31, 51], { speed: 2 }),
    ],
  },
} as unknown as ProposalDoc;

describe("review model", () => {
  it("is clean until a text or a cut changes", () => {
    expect(isDirty(base, { texts: {}, kept: {} })).toBe(false);
    expect(isDirty(base, { texts: { b1: "Hello" }, kept: {} })).toBe(false);
    expect(isDirty(base, { texts: { b1: "Hi" }, kept: {} })).toBe(true);
    expect(isDirty(base, { texts: {}, kept: { s1: true } })).toBe(true);
  });

  it("flips a cut to keep and sends only allowed edits", () => {
    const body = toUpdate(base, { texts: { b1: "Hi" }, kept: { s1: true, s2: true } });
    expect(body.edit_plan.entries.map((e) => e.action)).toEqual(["keep", "keep", "speed"]);
    expect(body.script.blocks[0]).toEqual({ ...base.script.blocks[0], text: "Hi" });
  });

  it("sends the version the edit was made on as base_version", () => {
    expect(toUpdate(base, { texts: {}, kept: {} }).base_version).toBe(base.version);
  });

  it("reads the machine code from a 409 detail", () => {
    expect(conflictCode({ code: "version_conflict", message: "m" })).toBe("version_conflict");
    expect(conflictCode({ code: "not_awaiting_review", message: "m" })).toBe("not_awaiting_review");
    expect(conflictCode("run is approved")).toBeNull();
    expect(conflictCode(undefined)).toBeNull();
    expect(conflictCode({ message: "m" })).toBeNull();
  });

  it("is editable only while the run awaits review", () => {
    expect(isReviewable("awaiting_review")).toBe(true);
    for (const s of ["approved", "rendering", "done", "failed", "cancelled", undefined]) {
      expect(isReviewable(s)).toBe(false);
    }
  });

  it("computes the output length", () => {
    expect(outputLength(base.edit_plan.entries)).toBe(22 + 10);
    expect(outputLength(effectiveEntries(base, { texts: {}, kept: { s1: true } }))).toBe(41);
  });

  it("reads failing checks from a 422 detail", () => {
    expect(failingChecks("nope")).toEqual(["nope"]);
    expect(failingChecks({ passed: false, name: "n", message: "m" })).toEqual(["m"]);
    expect(failingChecks([{ msg: "bad" }])).toEqual(["bad"]);
  });
});

describe("flag copy", () => {
  it("pluralises the heading", () => {
    expect(flagHeading(1)).toBe("The agent flagged 1 thing");
    expect(flagHeading(2)).toBe("The agent flagged 2 things");
  });

  it("collects ref ids of failed checks", () => {
    const ids = flaggedRefIds([
      { name: "a", passed: false, message: "m", ref_id: "b3" },
      { name: "b", passed: false, message: "m", ref_id: null },
    ] as never);
    expect([...ids]).toEqual(["b3"]);
  });
});
