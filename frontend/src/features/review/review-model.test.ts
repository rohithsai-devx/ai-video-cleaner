import { describe, expect, it } from "vitest";
import demo from "../../../e2e/fixtures/proposal-demo.json";
import type { components } from "@/api/generated/schema";
import {
  applyFixToDraft,
  conflictCode,
  effectiveEntries,
  effectiveTexts,
  emptyDraft,
  failingChecks,
  flagHeading,
  flaggedRefIds,
  isDirty,
  isReviewable,
  outputLength,
  toUpdate,
  withoutFixesOn,
  type Entry,
  type ProposalDoc,
} from "./review-model";

type ProposalView = components["schemas"]["ProposalView"];
const demoView = demo as unknown as ProposalView;
const screen42 = (p: ProposalDoc, d: Parameters<typeof effectiveEntries>[1]) =>
  effectiveEntries(p, d).find((e) => e.seg_id === "screen-42");

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

  it("recomputes output length from an explicit undo entry and persists that entry", () => {
    const original = base.edit_plan.entries[0];
    const undone = { ...original, action: "keep" as const, speed: 1, freeze_s: 0 };
    const draft = { texts: {}, kept: {}, entryOverrides: { [original.seg_id]: undone } };

    expect(outputLength(effectiveEntries(base, draft))).toBe(41);
    expect(toUpdate(base, draft).edit_plan.entries[0]).toEqual(undone);
    expect(isDirty(base, draft)).toBe(true);
  });

  it("marks a fix choice dirty and sends it with the next proposal save", () => {
    const draft = { texts: {}, kept: {}, chosenFixes: { "spot-1": "fix-2" } };
    expect(isDirty(base, draft)).toBe(true);
    expect(toUpdate(base, draft).chosen_fixes).toEqual({ "spot-1": "fix-2" });
  });

  it("applies block and EDL fix patches to the review draft", () => {
    const proposal = demoView.proposal as unknown as ProposalDoc;
    const narrationSpot = demoView.spots[0]!;
    const textFix = narrationSpot.fixes[0]!;
    const entryFix = narrationSpot.fixes[1]!;

    const textDraft = applyFixToDraft(emptyDraft, proposal, narrationSpot, textFix);
    expect(effectiveTexts(proposal, textDraft)["block-create"]).toBe("Create the project.");
    expect(textDraft.chosenFixes?.[narrationSpot.spot_id]).toBe(textFix.fix_id);

    const entryDraft = applyFixToDraft(emptyDraft, proposal, narrationSpot, entryFix);
    expect(screen42(proposal, entryDraft)).toMatchObject({
      action: "freeze",
      speed: 1,
      freeze_s: 4,
    });
    expect(entryDraft.chosenFixes?.[narrationSpot.spot_id]).toBe(entryFix.fix_id);
  });

  it("keeps a chosen fix when an unrelated change is undone", () => {
    const proposal = demoView.proposal as unknown as ProposalDoc;
    const spot = demoView.spots[0]!;
    const hold = applyFixToDraft(emptyDraft, proposal, spot, spot.fixes[1]!);
    const other = proposal.edit_plan.entries.find((e) => e.action === "cut")!;
    // what the screen does on undo: replace the undo map with the reducer's entries
    const undone = {
      ...withoutFixesOn(hold, proposal, other.seg_id),
      entryOverrides: { [other.seg_id]: { ...other, action: "keep" as const } },
    };
    expect(screen42(proposal, undone)?.action).toBe("freeze");
    expect(toUpdate(proposal, undone).chosen_fixes).toEqual({ [spot.spot_id]: "hold" });
  });

  it("replaces the earlier patch when a different fix is chosen", () => {
    const proposal = demoView.proposal as unknown as ProposalDoc;
    const spot = demoView.spots[0]!;
    const hold = applyFixToDraft(emptyDraft, proposal, spot, spot.fixes[1]!);
    const shorten = applyFixToDraft(hold, proposal, spot, spot.fixes[0]!);
    expect(screen42(proposal, shorten)?.action).toBe("keep");
    expect(effectiveTexts(proposal, shorten)["block-create"]).toBe("Create the project.");
    const slow = applyFixToDraft(shorten, proposal, spot, spot.fixes[2]!);
    expect(screen42(proposal, slow)).toMatchObject({ action: "speed", speed: 0.7 });
    expect(effectiveTexts(proposal, slow)["block-create"]).not.toBe("Create the project.");
  });

  it("drops a draft fix when the user undoes the change on its segment", () => {
    const proposal = demoView.proposal as unknown as ProposalDoc;
    const spot = demoView.spots[0]!;
    const hold = applyFixToDraft(emptyDraft, proposal, spot, spot.fixes[1]!);
    expect(withoutFixesOn(hold, proposal, "screen-42").chosenFixes).toEqual({});
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
    expect(outputLength([entry("h", "freeze", [0, 2], { freeze_s: 4 })])).toBe(6);
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
