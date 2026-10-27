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
    estimated_run_seconds: null as number | null,
    width: 1920 as number | null,
    height: 1080 as number | null,
    playback_url: null as string | null,
    original_url: null as string | null,
    poster_url: null as string | null,
  },
  voices: {
    isPending: true,
    isError: false,
    data: null as null | {
      default_voice_id: string;
      voices: { id: string; label: string; hint: string; sample_path: string }[];
    },
  },
  runs: { isPending: false, isError: false, data: [] as unknown[] },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/api/client", () => ({
  $api: {
    useQuery: (_method: string, path: string) => {
      if (path === "/voices") return mock.voices;
      if (path === "/videos/{video_id}/runs") return mock.runs;
      return { isPending: false, isError: false, data: mock.video };
    },
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
  forceClean = false,
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <VideoScreen id="v1" renderShare={renderShare} forceClean={forceClean} />
    </QueryClientProvider>,
  );
}

describe("VideoScreen start run", () => {
  beforeEach(() => {
    mock.mutate.mockClear();
    Object.assign(mock.video, {
      status: "uploaded",
      duration_s: 60,
      estimated_run_seconds: null,
      width: 1920,
      height: 1080,
      playback_url: null,
      original_url: null,
    });
    mock.voices.isPending = true;
    mock.voices.isError = false;
    mock.voices.data = null;
    mock.runs = { isPending: false, isError: false, data: [] };
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

  it("shows the clean panel for a ready video when forced", () => {
    mock.video.status = "ready";

    const defaultView = renderScreen();
    expect(screen.queryByRole("heading", { name: "Clean this video" })).not.toBeInTheDocument();
    defaultView.unmount();

    renderScreen(undefined, true);

    expect(screen.getByRole("heading", { name: "Clean this video" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clean this video" })).toBeEnabled();
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

  it("loads provider voices and uses the selected voice id", () => {
    mock.voices.isPending = false;
    mock.voices.data = {
      default_voice_id: "coral",
      voices: [
        {
          id: "coral",
          label: "Coral",
          hint: "Warm, calm",
          sample_path: "/voice-samples/coral.mp3",
        },
        {
          id: "sage",
          label: "Sage",
          hint: "Clear, steady",
          sample_path: "/voice-samples/sage.mp3",
        },
      ],
    };
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: "AI voice" }));

    expect(screen.getByRole("radio", { name: "Coral" })).toBeChecked();
    expect(screen.getByText("Warm, calm")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Sage" }));
    fireEvent.click(screen.getByRole("button", { name: "Clean this video" }));

    expect(mock.mutate.mock.calls[0][0].body.voice_id).toBe("sage");
  });

  it("disables starting while the AI voice list is loading", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: "AI voice" }));

    expect(screen.getByRole("button", { name: "Clean this video" })).toBeDisabled();
  });

  it("shows a helpful error when provider voices cannot be loaded", () => {
    mock.voices.isPending = false;
    mock.voices.isError = true;
    renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: "AI voice" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Voice options could not be loaded.");
    expect(screen.getByRole("button", { name: "Clean this video" })).toBeDisabled();
  });

  it("plays and stops voice samples through one shared audio element", () => {
    mock.voices.isPending = false;
    mock.voices.data = {
      default_voice_id: "coral",
      voices: [
        {
          id: "coral",
          label: "Coral",
          hint: "Warm, calm",
          sample_path: "/voice-samples/coral.mp3",
        },
        {
          id: "sage",
          label: "Sage",
          hint: "Clear, steady",
          sample_path: "/voice-samples/sage.mp3",
        },
      ],
    };
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const { container, unmount } = renderScreen();
    fireEvent.click(screen.getByRole("radio", { name: "AI voice" }));

    fireEvent.click(screen.getByRole("button", { name: "Play a sample of Coral" }));
    const audio = container.querySelector("audio");
    expect(container.querySelectorAll("audio")).toHaveLength(1);
    expect(audio?.src).toContain("/voice-samples/coral.mp3");
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Stop sample of Coral" })).toHaveTextContent("Stop");

    fireEvent.click(screen.getByRole("button", { name: "Stop sample of Coral" }));
    expect(pause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Play a sample of Sage" }));
    expect(container.querySelectorAll("audio")).toHaveLength(1);
    expect(audio?.src).toContain("/voice-samples/sage.mp3");
    expect(play).toHaveBeenCalledTimes(2);
    unmount();
    vi.restoreAllMocks();
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

  it("hides the estimate when the backend has no estimate yet", () => {
    renderScreen();

    expect(screen.queryByText(/About .* for a .* recording\./)).not.toBeInTheDocument();
  });

  it("shows the rounded recording length and estimated minutes", () => {
    mock.video.duration_s = 372;
    mock.video.estimated_run_seconds = 61;
    renderScreen();

    expect(screen.getByText("About 2 minutes for a 6-minute recording.")).toBeInTheDocument();
  });

  it("uses singular minute when the estimate is one minute", () => {
    mock.video.duration_s = 59;
    mock.video.estimated_run_seconds = 30;
    renderScreen();

    expect(screen.getByText("About 1 minute for a 1-minute recording.")).toBeInTheDocument();
  });

  it.each([
    ["uploaded", "uploaded"],
    ["processing", "processing"],
    ["awaiting_review", "processing"],
    ["rendering", "rendering"],
    ["failed", "failed"],
  ])("passes the C9 data to the share slot for %s", (videoStatus, shareStatus) => {
    mock.video.status = videoStatus;
    mock.video.original_url = "/original.mp4";
    const renderShare = vi.fn(() => <div>Share slot</div>);

    renderScreen(renderShare);

    expect(renderShare).toHaveBeenCalledWith({
      videoId: "v1",
      status: shareStatus,
      title: "Demo",
      playbackUrl: null,
      originalUrl: "/original.mp4",
    });
    expect(screen.getByText("Share slot")).toBeInTheDocument();
  });

  it.each(["uploading", "ready"])(
    "does not render the original share slot for %s",
    (videoStatus) => {
      mock.video.status = videoStatus;
      mock.video.original_url = "/original.mp4";
      const renderShare = vi.fn(() => <div>Share slot</div>);

      renderScreen(renderShare);

      expect(renderShare).not.toHaveBeenCalled();
      expect(screen.queryByText("Share slot")).not.toBeInTheDocument();
    },
  );

  it("does not render the original share slot when the original URL is unavailable", () => {
    const renderShare = vi.fn(() => <div>Share slot</div>);

    renderScreen(renderShare);

    expect(renderShare).not.toHaveBeenCalled();
    expect(screen.queryByText("Share slot")).not.toBeInTheDocument();
  });

  it("shows the player error copy when playback fails", () => {
    mock.video.original_url = "/original.mp4";
    const { container } = renderScreen();

    fireEvent.error(container.querySelector("video")!);

    expect(screen.getByText("Could not load this video.")).toBeInTheDocument();
  });
});
