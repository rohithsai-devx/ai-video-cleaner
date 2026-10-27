import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  mutate: vi.fn(),
  video: {
    id: "v1",
    title: "Demo",
    status: "uploaded" as string,
    duration_s: 60,
    width: 1920 as number | null,
    height: 1080 as number | null,
    playback_url: null as string | null,
    original_url: null as string | null,
    poster_url: null as string | null,
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/api/client", () => ({
  $api: {
    useQuery: () => ({
      isPending: false,
      isError: false,
      data: mock.video,
    }),
    useMutation: () => ({ mutate: mock.mutate, isPending: false, isError: false }),
  },
}));

import { VideoScreen } from "./video-screen";

function renderScreen(
  renderShare?: (data: {
    videoId: string;
    status: string;
    title: string;
    playbackUrl?: string | null;
    originalUrl?: string | null;
  }) => React.ReactNode,
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <VideoScreen id="v1" renderShare={renderShare} />
    </QueryClientProvider>,
  );
}

describe("VideoScreen start run", () => {
  beforeEach(() => {
    mock.mutate.mockClear();
    Object.assign(mock.video, {
      status: "uploaded",
      width: 1920,
      height: 1080,
      playback_url: null,
      original_url: null,
    });
  });

  it("shows the clean panel and explains the review switch", () => {
    renderScreen();

    expect(screen.getByRole("heading", { name: "Clean this video" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Pick what the AI may change. You'll see every change on a timeline before anything is final.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Keep my voice" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "AI voice" })).toBeInTheDocument();

    const review = screen.getByRole("switch", { name: "Show me before it renders" });
    expect(review).toBeChecked();
    expect(
      screen.getByText(
        "You get the editor with every change marked. Nothing renders until you say so.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(review);
    expect(review).not.toBeChecked();
    expect(
      screen.getByText(
        "Renders straight away. If the AI is unsure about something, it stops and asks you first.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clean this video" }));
    expect(mock.mutate.mock.calls[0][0].body.mode).toBe("auto");
  });

  it("sends unchecked fix options with the run request", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("checkbox", { name: "Remove filler words" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean this video" }));

    expect(mock.mutate.mock.calls[0][0].body.fix_options).toEqual({
      pauses: true,
      filler: false,
      retakes: true,
      slow_parts: true,
    });
  });

  it("sends the selected voice as voice_id", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: "AI voice" }));
    const select = screen.getByLabelText("Workspace voice") as HTMLSelectElement;
    expect(select.value).toBe("default");
    fireEvent.click(screen.getByRole("button", { name: "Clean this video" }));
    expect(mock.mutate).toHaveBeenCalledTimes(1);
    expect(mock.mutate.mock.calls[0][0].body).toEqual({
      mode: "review",
      voice: "ai",
      voice_id: select.value,
      fix_options: { pauses: true, filler: true, retakes: true, slow_parts: true },
    });
  });

  it("sends no voice_id for my voice", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Clean this video" }));
    expect(mock.mutate.mock.calls[0][0].body).toEqual({
      mode: "review",
      voice: "original",
      fix_options: { pauses: true, filler: true, retakes: true, slow_parts: true },
    });
  });

  it("shows the original label, duration and dimensions", () => {
    renderScreen();

    expect(screen.getByText("Original recording")).toBeInTheDocument();
    expect(screen.getByText("1:00 · 1920 × 1080")).toBeInTheDocument();
  });

  it("passes the C9 data to the share slot for a ready video", () => {
    mock.video.status = "ready";
    mock.video.playback_url = "/clean.mp4";
    mock.video.original_url = "/original.mp4";
    const renderShare = vi.fn(() => <div>Share slot</div>);

    renderScreen(renderShare);

    expect(renderShare).toHaveBeenCalledWith({
      videoId: "v1",
      status: "ready",
      title: "Demo",
      playbackUrl: "/clean.mp4",
      originalUrl: "/original.mp4",
    });
    expect(screen.getByText("Share slot")).toBeInTheDocument();
  });

  it("shows the player error copy when playback fails", () => {
    mock.video.original_url = "/original.mp4";
    const { container } = renderScreen();

    fireEvent.error(container.querySelector("video")!);

    expect(screen.getByText("Could not load this video.")).toBeInTheDocument();
  });
});
