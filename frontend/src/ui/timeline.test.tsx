import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Timeline } from "./timeline";

const tracks = [
  {
    id: "chapters",
    label: "Chapters",
    sublabel: "Sections in this recording",
    items: [
      {
        id: "sign-in",
        start: 0,
        end: 30,
        kind: "chapter",
        text: "Sign in",
        ariaLabel: "Sign in, 0:00 to 0:30",
      },
      {
        id: "billing",
        start: 30,
        end: 60,
        kind: "needs-you",
        text: "Billing page",
        ariaLabel: "Billing page, needs your attention",
      },
    ],
  },
  {
    id: "screen",
    label: "Screen",
    sublabel: "Cuts and speed-ups",
    items: [
      {
        id: "pause",
        start: 12,
        end: 20,
        kind: "removed",
        text: "Removed",
        ariaLabel: "Long pause removed",
        thumbnailUrl: "/thumb.jpg",
      },
    ],
  },
];

describe("Timeline", () => {
  it("exposes a clock-labelled playhead and supports timeline keyboard movement", () => {
    const onSeek = vi.fn();
    const { rerender } = render(
      <Timeline duration={120} playhead={44} tracks={[]} onSeek={onSeek} onSelect={vi.fn()} />,
    );
    const slider = screen.getByRole("slider", { name: "Timeline playhead" });
    expect(slider).toHaveAttribute("aria-valuetext", "0:44");

    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onSeek).toHaveBeenLastCalledWith(49);
    rerender(
      <Timeline duration={120} playhead={49} tracks={[]} onSeek={onSeek} onSelect={vi.fn()} />,
    );
    fireEvent.keyDown(slider, { key: "ArrowLeft", shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(48);
    fireEvent.keyDown(slider, { key: "End" });
    expect(onSeek).toHaveBeenLastCalledWith(120);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });

  it("renders labelled track items, indicates selection, and seeks on selection", () => {
    const onSeek = vi.fn();
    const onSelect = vi.fn();
    render(
      <Timeline
        duration={120}
        playhead={44}
        tracks={tracks}
        selectedId="billing"
        onSeek={onSeek}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText("Chapters")).toBeInTheDocument();
    expect(screen.getByText("Sections in this recording")).toBeInTheDocument();
    const selected = screen.getByRole("button", {
      name: "Billing page, needs your attention",
    });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(selected).toHaveClass("border-flag");

    fireEvent.click(selected);
    expect(onSelect).toHaveBeenCalledWith("billing");
    expect(onSeek).toHaveBeenCalledWith(30);
  });

  it("renders lazy thumbnails and waveform data, with a fallback when peaks are missing", () => {
    const { container } = render(
      <Timeline
        duration={120}
        playhead={0}
        tracks={[
          { ...tracks[1], waveform: { rate: 50, peaks: [0, 0.5, 1] } },
          {
            id: "your-voice",
            label: "Your voice",
            sublabel: "Removed parts shown faded",
            items: [],
            waveform: null,
          },
        ]}
        onSeek={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const thumbnail = container.querySelector("img");
    expect(thumbnail).toHaveAttribute("loading", "lazy");
    expect(thumbnail).toHaveAttribute("alt", "");
    expect(container.querySelector("svg[data-waveform='true'] path")).toBeInTheDocument();
    expect(screen.getByText("Waveform not available")).toBeInTheDocument();
  });
});
