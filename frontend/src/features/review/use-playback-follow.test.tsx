import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPlaybackContext, usePlaybackFollow, type FollowTarget } from "./use-playback-follow";

const targets: FollowTarget[] = [
  { id: "change-cut-1", tab: "done-by-ai", start: 10, end: 20 },
  { id: "spot-open-1", tab: "needs-you", start: 14, end: 18, open: true },
  { id: "script-line-1", tab: "script", start: 30, end: 40 },
];

function FollowHarness({ playhead, activeTab }: { playhead: number; activeTab: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const activeId = usePlaybackFollow({ playhead, activeTab, targets, panelRef });
  return (
    <div ref={panelRef}>
      <article data-follow-id="change-cut-1">AI change</article>
      <article data-follow-id="spot-open-1">Open spot</article>
      <article data-follow-id="script-line-1">Script line</article>
      <output>{activeId ?? "none"}</output>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("usePlaybackFollow", () => {
  it("reports the current chapter and edit state for the now bar", () => {
    const chapters = [
      { title: "Sign in", start: 0, end: 10 },
      { title: "Billing page", start: 10, end: 40 },
    ];
    const segments = [
      { start: 10, end: 20, kind: "removed" as const, label: "Pause removed" },
      { start: 30, end: 40, kind: "speed" as const, speed: 2, label: "Speed up" },
    ];
    expect(getPlaybackContext(15, chapters, targets, segments)).toEqual({
      chapter: "Billing page",
      state: "Needs you",
    });
    expect(getPlaybackContext(25, chapters, targets, segments).state).toBe("Kept");
    expect(getPlaybackContext(35, chapters, targets, segments).state).toBe("Sped up");
  });

  it("follows the row in the open tab and gives an open spot priority", () => {
    const { rerender } = render(<FollowHarness playhead={12} activeTab="done-by-ai" />);
    expect(screen.getByText("change-cut-1")).toBeInTheDocument();

    rerender(<FollowHarness playhead={15} activeTab="done-by-ai" />);
    expect(screen.getByText("spot-open-1")).toBeInTheDocument();

    rerender(<FollowHarness playhead={35} activeTab="script" />);
    expect(screen.getByText("script-line-1")).toBeInTheDocument();
  });

  it("scrolls the active row to nearest using auto under reduced motion", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    render(<FollowHarness playhead={35} activeTab="script" />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
  });
});
