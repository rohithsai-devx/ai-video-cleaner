import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShareCard } from "./share-card";

afterEach(() => {
  vi.useRealTimers();
});

describe("ShareCard", () => {
  it("offers create and disables the action while a link is being created", () => {
    const onCreate = vi.fn();
    const { rerender } = render(
      <ShareCard
        title="Cleaned video"
        url={null}
        creating={false}
        onCreate={onCreate}
        downloadLabel="Download MP4"
        selected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    expect(onCreate).toHaveBeenCalledOnce();

    rerender(
      <ShareCard
        title="Cleaned video"
        url={null}
        creating
        onCreate={onCreate}
        downloadLabel="Download MP4"
        selected={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Creating link…" })).toBeDisabled();
  });

  it("copies the link and returns the button to its idle label after two seconds", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <ShareCard
        title="Cleaned video"
        meta="4:05 · AI voice"
        url="https://stepwise.app/s/abc"
        creating={false}
        downloadUrl="https://storage.test/cleaned.mp4"
        downloadLabel="Download MP4"
        selected={false}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("https://stepwise.app/s/abc");
    expect(screen.getByRole("button", { name: "Copied" })).toHaveClass(
      "bg-success-soft",
      "text-success",
    );
    expect(screen.getByText("Copied", { selector: "p" })).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download MP4" })).toHaveAttribute(
      "href",
      "https://storage.test/cleaned.mp4",
    );
  });

  it("selects the link and announces copy instructions when clipboard access fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <ShareCard
        title="Original recording"
        url="https://stepwise.app/s/raw"
        creating={false}
        downloadLabel="Download original"
        selected={false}
      />,
    );

    const linkInput = screen.getByRole("textbox", {
      name: "Original recording link",
    }) as HTMLInputElement;
    const select = vi.spyOn(linkInput, "select");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    expect(
      await screen.findByText("Could not copy. The link is selected, so press Cmd+C to copy."),
    ).toBeInTheDocument();
    expect(select).toHaveBeenCalledOnce();
  });

  it("marks the selected card and calls its play action", () => {
    const onPlay = vi.fn();
    render(
      <ShareCard
        title="Cleaned video"
        url="https://stepwise.app/s/clean"
        creating={false}
        onPlay={onPlay}
        downloadLabel="Download MP4"
        selected
      />,
    );

    const card = screen.getByRole("region", { name: "Cleaned video" });
    expect(card).toHaveClass("border-link", "bg-accent-soft");
    const playButton = screen.getByRole("button", { name: "Play this version" });
    expect(playButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(playButton);
    expect(onPlay).toHaveBeenCalledOnce();
  });
});
