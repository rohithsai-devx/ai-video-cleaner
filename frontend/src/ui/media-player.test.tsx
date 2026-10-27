import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPlayer } from "./media-player";

const segments = [
  { start: 10, end: 20, kind: "removed" as const, label: "Long pause removed" },
  { start: 30, end: 50, kind: "speed" as const, speed: 2, label: "Slow page sped up" },
];

let currentTime = 0;
const media = vi.hoisted(() => ({ play: vi.fn(), pause: vi.fn() }));

function setCurrentTime(video: HTMLVideoElement, time: number) {
  currentTime = time;
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
    },
  });
}

describe("MediaPlayer", () => {
  beforeEach(() => {
    currentTime = 0;
    media.play.mockReset().mockResolvedValue(undefined);
    media.pause.mockReset();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(media.play);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(media.pause);
  });

  it("uses custom transport and exposes named play controls without native controls", () => {
    render(
      <MediaPlayer src="/recording.mp4" duration={60} mode="file" badge="Original recording" />,
    );
    const video = screen.getByLabelText("Original recording") as HTMLVideoElement;

    expect(video).not.toHaveAttribute("controls");
    expect(screen.getByRole("button", { name: "Back 5 seconds" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Forward 5 seconds" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(media.play).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });

  it("supports Space and K play keys and arrow-key seeks from the video", () => {
    render(<MediaPlayer src="/recording.mp4" duration={60} mode="file" onTime={vi.fn()} />);
    const video = screen.getByLabelText("Video player") as HTMLVideoElement;
    setCurrentTime(video, 20);
    fireEvent.timeUpdate(video);

    fireEvent.keyDown(video, { key: " " });
    expect(media.play).toHaveBeenCalledOnce();
    fireEvent.keyDown(video, { key: "k" });
    expect(media.pause).toHaveBeenCalledOnce();

    fireEvent.keyDown(video, { key: "ArrowLeft" });
    expect(video.currentTime).toBe(15);
    fireEvent.keyDown(video, { key: "ArrowRight" });
    expect(video.currentTime).toBe(20);
  });

  it("skips removed spans, applies speed spans, and maps the clock to output time", () => {
    const onTime = vi.fn();
    const props = {
      src: "/recording.mp4",
      duration: 100,
      segments,
      onTime,
    };
    const { rerender } = render(<MediaPlayer {...props} mode="cleaned-preview" />);
    const video = screen.getByLabelText("Video player") as HTMLVideoElement;
    setCurrentTime(video, 15);
    fireEvent.timeUpdate(video);
    expect(video.currentTime).toBe(20);
    expect(onTime).toHaveBeenLastCalledWith(20);

    setCurrentTime(video, 40);
    fireEvent.timeUpdate(video);
    expect(video.playbackRate).toBe(2);
    expect(screen.getByText("0:25 of the cleaned video · skips removed parts")).toBeInTheDocument();
    expect(onTime).toHaveBeenLastCalledWith(40);
    expect(screen.getByText("2×")).toBeInTheDocument();

    rerender(<MediaPlayer {...props} mode="file" />);
    expect(video.playbackRate).toBe(1);
    expect(video.currentTime).toBe(40);
  });

  it("maps cleaned-preview seeks back to source time and seeks to chapter marks", () => {
    render(
      <MediaPlayer
        src="/recording.mp4"
        duration={100}
        mode="cleaned-preview"
        segments={segments}
        chapters={[{ title: "Billing page", start: 30 }]}
      />,
    );
    const video = screen.getByLabelText("Video player") as HTMLVideoElement;
    const seek = screen.getByRole("slider", { name: "Seek" });

    fireEvent.change(seek, { target: { value: "25" } });
    expect(video.currentTime).toBe(40);

    fireEvent.click(screen.getByRole("button", { name: "Jump to Billing page at 0:30" }));
    expect(video.currentTime).toBe(30);
  });

  it("shows removed-span shading and hold guidance in file mode without skipping", () => {
    render(
      <MediaPlayer
        src="/recording.mp4"
        duration={60}
        mode="file"
        segments={[segments[0], { start: 40, end: 40, kind: "hold", label: "Hold last frame" }]}
      />,
    );
    const video = screen.getByLabelText("Video player") as HTMLVideoElement;
    const removed = screen.getByLabelText("Removed in the cleaned version · long pause removed");
    setCurrentTime(video, 15);
    fireEvent.timeUpdate(video);

    expect(removed).toBeInTheDocument();
    expect(video.currentTime).toBe(15);
    expect(screen.getByText("Hold applied when rendered")).toBeInTheDocument();
  });

  it("seeks again when the same time is requested twice", () => {
    const { rerender } = render(
      <MediaPlayer src="/recording.mp4" duration={60} mode="file" seekTo={{ time: 12 }} />,
    );
    const video = screen.getByLabelText("Video player") as HTMLVideoElement;
    setCurrentTime(video, 12);
    rerender(<MediaPlayer src="/recording.mp4" duration={60} mode="file" seekTo={{ time: 12 }} />);
    video.currentTime = 30;
    rerender(<MediaPlayer src="/recording.mp4" duration={60} mode="file" seekTo={{ time: 12 }} />);
    expect(video.currentTime).toBe(12);
  });

  it("uses the played file's own length once its metadata loads", () => {
    render(<MediaPlayer src="/cleaned.mp4" duration={40} mode="file" />);
    const video = screen.getByLabelText("Video player") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 52 });
    fireEvent.loadedMetadata(video);
    expect(screen.getByRole("slider", { name: "Seek" })).toHaveAttribute("max", "52");
  });
});
