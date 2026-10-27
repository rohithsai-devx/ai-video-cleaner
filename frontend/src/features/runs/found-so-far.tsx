import type { components } from "@/api/generated/schema";

type Progress = components["schemas"]["RunProgressEvent"];
type ProposalSummary = {
  changes: { kind: components["schemas"]["Change"]["kind"] }[];
  spots: { chosen_fix_id?: string | null }[];
  chapters: { title: string; start: number; end: number }[];
};

type Counts = {
  pauses: number | null;
  filler: number | null;
  retakes: number | null;
  slowParts: number | null;
};

const TILES: { key: keyof Counts; label: string }[] = [
  { key: "pauses", label: "long pauses" },
  { key: "filler", label: "filler words" },
  { key: "retakes", label: "retakes" },
  { key: "slowParts", label: "slow loads" },
];

function countsFromProgress(progress: Progress): Counts {
  return {
    pauses: progress.pauses ?? null,
    filler: progress.filler ?? null,
    retakes: progress.retakes ?? null,
    slowParts: progress.slow_parts ?? null,
  };
}

function countsFromProposal(proposal: ProposalSummary): Counts {
  return {
    pauses: proposal.changes.filter((change) => change.kind === "pause").length,
    filler: proposal.changes.filter((change) => change.kind === "filler").length,
    retakes: proposal.changes.filter((change) => change.kind === "retake").length,
    slowParts: proposal.changes.filter((change) => change.kind === "speed").length,
  };
}

function chapterTime(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

export function readySummary(proposal: Pick<ProposalSummary, "changes" | "spots">): string {
  const changes = proposal.changes.length;
  const openSpots = proposal.spots.filter(
    (spot) => spot.chosen_fix_id === null || spot.chosen_fix_id === undefined,
  ).length;
  if (proposal.spots.length === 0) {
    return `${changes} changes ready. All are applied already.`;
  }
  return `${changes + proposal.spots.length} changes ready. ${changes} are applied already. ${openSpots} need your call.`;
}

export function FoundSoFar({
  progress,
  proposal,
  ready,
}: {
  progress: Progress | null;
  proposal?: ProposalSummary;
  ready: boolean;
}) {
  const counts = ready
    ? proposal
      ? countsFromProposal(proposal)
      : null
    : progress
      ? countsFromProgress(progress)
      : null;
  if (!counts) return null;

  const chapters = ready ? (proposal?.chapters ?? []) : (progress?.chapters ?? []);

  return (
    <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5" aria-label="Found so far">
      <h2 className="m-0 text-[15px] font-medium">Found so far</h2>
      <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0">
        {TILES.map(({ key, label }) => (
          <li
            key={key}
            className="flex min-h-24 flex-col justify-between rounded-2xl border border-line bg-surface p-4"
          >
            <strong className="font-display text-[32px] font-bold leading-none">
              {counts[key] ?? "–"}
            </strong>
            <span className="text-[13px] text-muted">{label}</span>
          </li>
        ))}
      </ul>
      {chapters.length > 0 ? (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="mb-3 mt-0 text-[15px] font-medium">Chapters it sees</h2>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {chapters.map((chapter, index) => (
              <li key={`${chapter.start}-${index}`} className="flex gap-3 text-sm">
                <span className="w-10 shrink-0 font-mono text-muted">
                  {chapterTime(chapter.start)}
                </span>
                <span>{chapter.title}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </aside>
  );
}
