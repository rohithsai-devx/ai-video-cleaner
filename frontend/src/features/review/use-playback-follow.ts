import { useEffect, type RefObject } from "react";
import type { PlayerSegment } from "@/lib/cut-map";

export type ReviewTabId = "needs-you" | "done-by-ai" | "script";

export type FollowTarget = {
  id: string;
  tab: ReviewTabId;
  start: number;
  end: number;
  open?: boolean;
};

export function getPlaybackContext(
  playhead: number,
  chapters: { title: string; start: number; end: number }[],
  targets: FollowTarget[],
  segments: PlayerSegment[],
): { chapter: string; state: "Kept" | "Removed" | "Sped up" | "Needs you" } {
  const chapter = chapters.find((item) => playhead >= item.start && playhead < item.end)?.title;
  if (
    targets.some(
      (target) =>
        target.tab === "needs-you" &&
        target.open &&
        playhead >= target.start &&
        playhead < target.end,
    )
  ) {
    return { chapter: chapter ?? "Recording", state: "Needs you" };
  }
  const segment = segments.find((item) => playhead >= item.start && playhead < item.end);
  if (segment?.kind === "removed") return { chapter: chapter ?? "Recording", state: "Removed" };
  if (segment?.kind === "speed") return { chapter: chapter ?? "Recording", state: "Sped up" };
  return { chapter: chapter ?? "Recording", state: "Kept" };
}

export function findPlaybackTarget(
  playhead: number,
  activeTab: string,
  targets: FollowTarget[],
): FollowTarget | undefined {
  const current = (target: FollowTarget) => playhead >= target.start && playhead < target.end;
  const openSpot = targets.find(
    (target) => target.tab === "needs-you" && target.open && current(target),
  );
  if (openSpot) return openSpot;
  return targets.find((target) => target.tab === activeTab && current(target));
}

export function usePlaybackFollow({
  playhead,
  activeTab,
  targets,
  panelRef,
}: {
  playhead: number;
  activeTab: string;
  targets: FollowTarget[];
  panelRef: RefObject<HTMLElement | null>;
}): string | null {
  const target = findPlaybackTarget(playhead, activeTab, targets);
  const targetId = target?.id;
  const targetTab = target?.tab;

  useEffect(() => {
    if (!targetId || targetTab !== activeTab) return;
    const row = [
      ...(panelRef.current?.querySelectorAll<HTMLElement>("[data-follow-id]") ?? []),
    ].find((element) => element.dataset.followId === targetId);
    if (!row) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    row.scrollIntoView?.({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }, [activeTab, panelRef, targetId, targetTab]);

  return targetId ?? null;
}
