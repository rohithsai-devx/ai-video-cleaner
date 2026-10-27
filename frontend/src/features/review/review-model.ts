import type { components } from "@/api/generated/schema";

type S = components["schemas"];
export type ProposalDoc = S["Proposal"];
export type Entry = S["EDLEntry"];
export type Check = S["CheckResult"];
export type ProposalUpdate = S["ProposalUpdate"];
type Spot = S["Spot"];
type Fix = S["Fix"];

/** Local edits on top of a saved proposal: block texts and the cut segments flipped back to keep. */
export type Draft = {
  texts: Record<string, string>;
  kept: Record<string, boolean>;
  entryOverrides?: Record<string, Entry>;
  chosenFixes?: Record<string, string>;
};
export const emptyDraft: Draft = {
  texts: {},
  kept: {},
  entryOverrides: {},
  chosenFixes: {},
};

export function applyFixToDraft(draft: Draft, base: ProposalDoc, spot: Spot, fix: Fix): Draft {
  const next: Draft = {
    ...draft,
    chosenFixes: { ...draft.chosenFixes, [spot.spot_id]: fix.fix_id },
  };
  const blockPatch = fix.patch.block;
  if (blockPatch) {
    return {
      ...next,
      texts: { ...draft.texts, [blockPatch.block_id]: blockPatch.text },
    };
  }

  const entryPatch = fix.patch.entry;
  if (!entryPatch) return next;
  const original =
    draft.entryOverrides?.[entryPatch.seg_id] ??
    base.edit_plan.entries.find((entry) => entry.seg_id === entryPatch.seg_id);
  if (!original) return next;
  return {
    ...next,
    entryOverrides: {
      ...draft.entryOverrides,
      [entryPatch.seg_id]: { ...original, ...entryPatch },
    },
  };
}

function sameEntry(left: Entry, right: Entry): boolean {
  return (
    left.seg_id === right.seg_id &&
    left.action === right.action &&
    left.speed === right.speed &&
    left.freeze_s === right.freeze_s &&
    left.src[0] === right.src[0] &&
    left.src[1] === right.src[1]
  );
}

export function isDirty(base: ProposalDoc, draft: Draft): boolean {
  const textChanged = base.script.blocks.some(
    (b) => draft.texts[b.block_id] !== undefined && draft.texts[b.block_id] !== b.text,
  );
  const flipped = base.edit_plan.entries.some((e) => e.action === "cut" && draft.kept[e.seg_id]);
  const entryChanged = base.edit_plan.entries.some((entry) => {
    const override = draft.entryOverrides?.[entry.seg_id];
    return override !== undefined && !sameEntry(entry, override);
  });
  const fixChanged = Object.entries(draft.chosenFixes ?? {}).some(([spotId, fixId]) => {
    const original = base.spots?.find((spot) => spot.spot_id === spotId)?.chosen_fix_id;
    return original !== fixId;
  });
  return textChanged || flipped || entryChanged || fixChanged;
}

export function effectiveEntries(base: ProposalDoc, draft: Draft): Entry[] {
  return base.edit_plan.entries.map((entry) => {
    const override = draft.entryOverrides?.[entry.seg_id];
    if (override) return override;
    return entry.action === "cut" && draft.kept[entry.seg_id]
      ? { ...entry, action: "keep", speed: 1, freeze_s: 0 }
      : entry;
  });
}

/** The PUT body: the saved proposal with only the user's allowed edits applied, on its version. */
export function toUpdate(base: ProposalDoc, draft: Draft): ProposalUpdate {
  const chosenFixes = draft.chosenFixes ?? {};
  return {
    base_version: base.version,
    script: {
      ...base.script,
      blocks: base.script.blocks.map((b) => ({ ...b, text: draft.texts[b.block_id] ?? b.text })),
    },
    edit_plan: { ...base.edit_plan, entries: effectiveEntries(base, draft) },
    seg_contexts: base.seg_contexts,
    ...(Object.keys(chosenFixes).length > 0 ? { chosen_fixes: chosenFixes } : {}),
  };
}

/** Review edits and approval are allowed only while the run awaits review. */
export function isReviewable(status: string | undefined): boolean {
  return status === "awaiting_review";
}

/** The machine code of a 409 detail (`version_conflict`, `not_awaiting_review`, ...), or null. */
export function conflictCode(detail: unknown): string | null {
  if (detail && typeof detail === "object" && "code" in detail) {
    const code = (detail as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function entryLength(e: Entry): number {
  return Math.max(0, e.src[1] - e.src[0]);
}

export function outputLength(entries: Entry[]): number {
  return entries.reduce((sum, e) => {
    if (e.action === "cut") return sum;
    if (e.action === "speed") return sum + entryLength(e) / (e.speed || 1);
    if (e.action === "freeze") return sum + e.freeze_s;
    return sum + entryLength(e);
  }, 0);
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function spanLabel(e: Entry): string {
  return e.action === "freeze"
    ? formatClock(e.src[0])
    : `${formatClock(e.src[0])} to ${formatClock(e.src[1])}`;
}

export function actionLabel(e: Entry): string {
  if (e.action === "speed") return `Speed ${e.speed}x`;
  if (e.action === "freeze") return `Hold ${e.freeze_s} s`;
  return e.action === "cut" ? "Cut" : "Keep";
}

/** Failing checks from an approve 422: the body detail is a check object, a string, or a validation list. */
export function failingChecks(detail: unknown): string[] {
  if (typeof detail === "string") return [detail];
  if (Array.isArray(detail)) {
    return detail.map((d) =>
      typeof d === "object" && d && "msg" in d ? String(d.msg) : String(d),
    );
  }
  if (detail && typeof detail === "object") {
    const d = detail as { passed?: boolean; name?: string; message?: string };
    return [d.message || d.name || "A check failed"];
  }
  return ["A check failed"];
}

export function failedProposalChecks(p: ProposalDoc): Check[] {
  return p.checks.filter((c) => !c.passed);
}

/** "The agent flagged 1 thing" / "2 things". Counts failed checks only; raw flag ids are never shown. */
export function flagHeading(count: number): string {
  return `The agent flagged ${count} ${count === 1 ? "thing" : "things"}`;
}

/** Ids (script block or EDL segment) that a failed check points at. */
export function flaggedRefIds(checks: Check[]): Set<string> {
  return new Set(checks.map((c) => c.ref_id).filter((r): r is string => Boolean(r)));
}
