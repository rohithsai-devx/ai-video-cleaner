"use client";

import { useState } from "react";
import type { components } from "@/api/generated/schema";
import { formatClock } from "@/lib/clock";
import { Button } from "@/ui/button";

type Spot = components["schemas"]["Spot"];
type Fix = components["schemas"]["Fix"];
type Chapter = components["schemas"]["Chapter"];

export type NeedsYouPanelProps = {
  spots: Spot[];
  chapters: Chapter[];
  chosenFixes: Record<string, string>;
  editable: boolean;
  playhead: number;
  onChooseFix: (spot: Spot, fix: Fix) => void;
};

function chapterAt(spot: Spot, chapters: Chapter[]): string {
  return (
    chapters.find((chapter) => spot.span[0] >= chapter.start && spot.span[0] < chapter.end)
      ?.title ?? "Recording"
  );
}

function fixLabel(spot: Spot, fixId: string | undefined): string | undefined {
  return spot.fixes.find((fix) => fix.fix_id === fixId)?.label;
}

export function NeedsYouPanel({
  spots,
  chapters,
  chosenFixes,
  editable,
  playhead,
  onChooseFix,
}: NeedsYouPanelProps) {
  const [reopened, setReopened] = useState<Record<string, boolean>>({});

  if (spots.length === 0) return <p className="m-0 text-sm text-muted">Nothing needs you.</p>;

  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {spots.map((spot) => {
        const chosenFixId = chosenFixes[spot.spot_id] ?? spot.chosen_fix_id ?? undefined;
        const chosenLabel = fixLabel(spot, chosenFixId);
        const isOpen = !chosenFixId || reopened[spot.spot_id] === true;
        const isPlaying = playhead >= spot.span[0] && playhead < spot.span[1];
        return (
          <li key={spot.spot_id}>
            <article className="flex flex-col gap-3 rounded-xl border-2 border-flag bg-flag-soft p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-sm font-medium">
                  {formatClock(spot.span[0])} · {chapterAt(spot, chapters)}
                </h3>
                {chosenFixId ? (
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">
                    Decided
                  </span>
                ) : isPlaying ? (
                  <span className="rounded-full bg-surface px-2 py-0.5 text-xs text-muted">
                    Playing
                  </span>
                ) : null}
              </div>

              <p className="m-0 text-sm leading-normal text-ink-2">{spot.question}</p>

              {chosenFixId && !isOpen ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="m-0 text-sm text-ink-2">You chose: {chosenLabel ?? "a fix"}</p>
                  {editable ? (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setReopened((current) => ({ ...current, [spot.spot_id]: true }));
                      }}
                    >
                      Change
                    </Button>
                  ) : null}
                </div>
              ) : editable ? (
                <div className="flex flex-wrap gap-2">
                  {spot.fixes.map((fix, index) => (
                    <Button
                      key={fix.fix_id}
                      variant={index === 0 ? "primary" : "secondary"}
                      onClick={() => {
                        setReopened((current) => ({ ...current, [spot.spot_id]: false }));
                        onChooseFix(spot, fix);
                      }}
                    >
                      {fix.label}
                    </Button>
                  ))}
                </div>
              ) : chosenFixId ? (
                <p className="m-0 text-sm text-ink-2">You chose: {chosenLabel ?? "a fix"}</p>
              ) : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}
