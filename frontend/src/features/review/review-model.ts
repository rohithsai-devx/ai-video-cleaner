import type { components } from "@/api/generated/schema";

type S = components["schemas"];
export type ProposalDoc = S["Proposal"];
export type Entry = S["EDLEntry"];
export type Check = S["CheckResult"];
export type ProposalUpdate = S["ProposalUpdate"];
type Spot = S["Spot"];
type Fix = S["Fix"];

/**
 * Local edits on top of a saved proposal. `texts` are the user's own block edits, `kept` the cut
 * segments flipped back to keep, `entryOverrides` the Done-by-AI undo state, and `chosenFixes` the
 * needs-you picks (spot id to fix id). A chosen fix's patch is never copied into the other maps: it
 * is applied when the effective plan is computed, so undo cannot drop it and a new pick replaces it.
 */
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

/** The fixes picked in this draft, in spot order. */
function draftFixes(base: ProposalDoc, draft: Draft): Fix[] {
  const chosen = draft.chosenFixes ?? {};
  return (base.spots ?? []).flatMap((spot) => {
    const fix = spot.fixes.find((item) => item.fix_id === chosen[spot.spot_id]);
    return fix ? [fix] : [];
  });
}

export function applyFixToDraft(draft: Draft, _base: ProposalDoc, spot: Spot, fix: Fix): Draft {
  const next: Draft = {
    ...draft,
    chosenFixes: { ...draft.chosenFixes, [spot.spot_id]: fix.fix_id },
  };
  // The fix's text replaces an earlier hand edit of the same block.
  const blockId = fix.patch.block?.block_id;
  if (blockId && next.texts[blockId] !== undefined) {
    const texts = { ...next.texts };
    delete texts[blockId];
    return { ...next, texts };
  }
  return next;
}

/** Undoing or redoing a change on a segment also drops a fix picked in this draft for that segment. */
export function withoutFixesOn(draft: Draft, base: ProposalDoc, segId: string): Draft {
  const chosen = { ...draft.chosenFixes };
  let changed = false;
  for (const spot of base.spots ?? []) {
    const fix = spot.fixes.find((item) => item.fix_id === chosen[spot.spot_id]);
    if (fix?.patch.entry?.seg_id === segId) {
      delete chosen[spot.spot_id];
      changed = true;
    }
  }
  return changed ? { ...draft, chosenFixes: chosen } : draft;
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
  const texts = effectiveTexts(base, draft);
  const textChanged = base.script.blocks.some((b) => texts[b.block_id] !== b.text);
  const entries = effectiveEntries(base, draft);
  const entryChanged = base.edit_plan.entries.some((entry, i) => !sameEntry(entry, entries[i]));
  const fixChanged = Object.entries(draft.chosenFixes ?? {}).some(([spotId, fixId]) => {
    const original = base.spots?.find((spot) => spot.spot_id === spotId)?.chosen_fix_id;
    return original !== fixId;
  });
  return textChanged || entryChanged || fixChanged;
}

/** Block id to text: the saved text, then a chosen fix's text, then the user's own edit. */
export function effectiveTexts(base: ProposalDoc, draft: Draft): Record<string, string> {
  const texts = Object.fromEntries(base.script.blocks.map((b) => [b.block_id, b.text]));
  for (const fix of draftFixes(base, draft)) {
    const patch = fix.patch.block;
    if (patch && patch.block_id in texts) texts[patch.block_id] = patch.text;
  }
  for (const [blockId, text] of Object.entries(draft.texts)) {
    if (blockId in texts) texts[blockId] = text;
  }
  return texts;
}

/** The plan: saved entries, then undo state and kept flips, then chosen fixes (applied last). */
export function effectiveEntries(base: ProposalDoc, draft: Draft): Entry[] {
  const patches = new Map(
    draftFixes(base, draft).flatMap((fix) =>
      fix.patch.entry ? [[fix.patch.entry.seg_id, fix.patch.entry] as const] : [],
    ),
  );
  return base.edit_plan.entries.map((entry) => {
    const override = draft.entryOverrides?.[entry.seg_id];
    const edited: Entry =
      override ??
      (entry.action === "cut" && draft.kept[entry.seg_id]
        ? { ...entry, action: "keep", speed: 1, freeze_s: 0 }
        : entry);
    const patch = patches.get(entry.seg_id);
    return patch
      ? {
          ...edited,
          action: patch.action,
          speed: patch.speed ?? 1,
          freeze_s: patch.freeze_s ?? 0,
        }
      : edited;
  });
}

/** The PUT body: the saved proposal with only the user's allowed edits applied, on its version. */
export function toUpdate(base: ProposalDoc, draft: Draft): ProposalUpdate {
  const chosenFixes = draft.chosenFixes ?? {};
  const texts = effectiveTexts(base, draft);
  return {
    base_version: base.version,
    script: {
      ...base.script,
      blocks: base.script.blocks.map((b) => ({ ...b, text: texts[b.block_id] ?? b.text })),
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

/** Same rule as the backend's timeline_duration: the span at its speed, plus any held frame. */
export function outputLength(entries: Entry[]): number {
  return entries.reduce((sum, e) => {
    if (e.action === "cut") return sum;
    const speed = e.action === "speed" ? e.speed || 1 : 1;
    return sum + entryLength(e) / speed + Math.max(0, e.freeze_s);
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
