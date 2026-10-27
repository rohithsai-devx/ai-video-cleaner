import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { segmentsFromChanges, toSourceTime } from "@/lib/cut-map";
import type { components } from "@/api/generated/schema";

const mock = vi.hoisted(() => ({
  run: {
    data: {
      attempt: 1,
      created_at: "2026-10-27T00:00:00Z",
      flags: [],
      id: "run-1",
      mode: "review",
      status: "done",
      video_id: "video-1",
      voice: "ai",
      voice_id: "coral",
    },
  },
  proposal: {
    data: {
      changes: [
        { change_id: "p1", kind: "pause", span: [60, 67], reason: "Pause", undone: false },
        { change_id: "p2", kind: "pause", span: [68, 75], reason: "Pause", undone: false },
        { change_id: "p3", kind: "pause", span: [76, 83], reason: "Pause", undone: false },
        { change_id: "p4", kind: "pause", span: [84, 91], reason: "Pause", undone: false },
        { change_id: "p5", kind: "pause", span: [92, 98], reason: "Pause", undone: false },
        { change_id: "p6", kind: "pause", span: [99, 105], reason: "Pause", undone: false },
        { change_id: "p7", kind: "pause", span: [106, 120], reason: "Pause", undone: true },
        { change_id: "r1", kind: "retake", span: [120, 140], reason: "Retake", undone: false },
        { change_id: "r2", kind: "retake", span: [141, 161], reason: "Retake", undone: false },
        { change_id: "r3", kind: "retake", span: [162, 182], reason: "Retake", undone: false },
        { change_id: "r4", kind: "retake", span: [183, 200], reason: "Retake", undone: true },
        {
          change_id: "s1",
          kind: "speed",
          span: [250, 290],
          speed: 2,
          reason: "Wait",
          undone: false,
        },
        {
          change_id: "s2",
          kind: "speed",
          span: [291, 312],
          speed: 1.5,
          reason: "Wait",
          undone: false,
        },
        {
          change_id: "s3",
          kind: "speed",
          span: [313, 330],
          speed: 2,
          reason: "Wait",
          undone: true,
        },
      ],
      chapters: [{ start: 0, end: 120, title: "Introduction" }],
      spots: [
        { spot_id: "spot-1", span: [20, 21], question: "Keep this?", fixes: [], chosen_by: "user" },
        { spot_id: "spot-2", span: [40, 41], question: "Keep this?", fixes: [], chosen_by: "user" },
        { spot_id: "spot-3", span: [50, 51], question: "Keep this?", fixes: [], chosen_by: "user" },
        {
          spot_id: "spot-4",
          span: [55, 56],
          question: "Keep this?",
          fixes: [],
          chosen_by: "default",
        },
      ],
    },
  },
  voices: { data: { default_voice_id: "coral", voices: [{ id: "coral", label: "Coral" }] } },
  shares: { data: [] as { kind: "cleaned" | "raw"; url: string }[] },
  create: { isPending: false, isError: false, mutate: vi.fn() },
}));

vi.mock("@/api/client", () => ({
  $api: {
    queryOptions: vi.fn((_method: string, path: string) => ({ queryKey: [path] })),
    useQuery: vi.fn((_method: string, path: string) => {
      if (path === "/runs/{run_id}") return mock.run;
      if (path === "/runs/{run_id}/proposal") return mock.proposal;
      if (path === "/voices") return mock.voices;
      if (path === "/videos/{video_id}/shares") return mock.shares;
      throw new Error(`Unexpected query ${path}`);
    }),
    useMutation: vi.fn(() => mock.create),
  },
}));

vi.mock("@/ui/media-player", () => ({
  MediaPlayer: (props: {
    src: string;
    duration: number;
    mode: string;
    seekTo?: { time: number };
    onTime?: (time: number) => void;
  }) => (
    <div
      data-testid="done-player"
      data-src={props.src}
      data-duration={props.duration}
      data-mode={props.mode}
      data-seek={props.seekTo?.time ?? "unset"}
    >
      <button onClick={() => props.onTime?.(60)}>Move player to one minute</button>
    </div>
  ),
}));

import { DoneScreen } from "./done-screen";

const video = {
  id: "video-1",
  title: "Setting up a new project",
  status: "ready",
  created_at: "2026-10-27T00:00:00Z",
  updated_at: "2026-10-27T00:00:00Z",
  workspace_id: "workspace-1",
  current_run: { run_id: "run-1", status: "done" },
  duration_s: 372,
  playback_url: "/cleaned.mp4",
  original_url: "/original.mp4",
  download_url: "/cleaned-download.mp4",
  original_download_url: "/original-download.mp4",
} as components["schemas"]["Video"];

function renderDoneScreen(
  currentVideo: components["schemas"]["Video"] = video,
  onRefreshVideo = vi.fn(),
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DoneScreen video={currentVideo} onRefreshVideo={onRefreshVideo} />
    </QueryClientProvider>,
  );
}

describe("DoneScreen", () => {
  beforeEach(() => {
    mock.shares.data = [];
    mock.create.mutate.mockClear();
  });

  it("shows duration, change counts, narration and spots the user chose", () => {
    renderDoneScreen();

    expect(screen.getByText("2:07")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText("pauses removed")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("retakes removed")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("waits sped up")).toBeInTheDocument();
    expect(
      screen.getByText("Narrated by the AI voice (Coral). 3 spots were your call."),
    ).toBeInTheDocument();
  });

  it("creates cleaned and original links with the link-only share contract", () => {
    renderDoneScreen();

    fireEvent.click(screen.getAllByRole("button", { name: "Create link" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Create link" })[1]);

    expect(mock.create.mutate.mock.calls[0][0].body).toEqual({
      kind: "cleaned",
      visibility: "link",
      expires_at: null,
    });
    expect(mock.create.mutate.mock.calls[1][0].body).toEqual({
      kind: "raw",
      visibility: "link",
      expires_at: null,
    });
  });

  it("switches between files at the matching source position", () => {
    renderDoneScreen();
    const player = screen.getByTestId("done-player");
    const changes = mock.proposal.data.changes as components["schemas"]["Change"][];
    const segments = segmentsFromChanges(changes);

    expect(player).toHaveAttribute("data-src", "/cleaned.mp4");
    expect(player).toHaveAttribute("data-mode", "file");
    fireEvent.click(screen.getByRole("button", { name: "Move player to one minute" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Play this version" })[1]);
    expect(screen.getByTestId("done-player")).toHaveAttribute("data-src", "/original.mp4");
    expect(Number(screen.getByTestId("done-player").getAttribute("data-seek"))).toBeCloseTo(
      toSourceTime(60, segments),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Play this version" })[0]);
    expect(screen.getByTestId("done-player")).toHaveAttribute("data-src", "/cleaned.mp4");
    expect(Number(screen.getByTestId("done-player").getAttribute("data-seek"))).toBeCloseTo(60);
  });

  it("shows a retry action when downloads are unavailable", () => {
    const onRefreshVideo = vi.fn();
    renderDoneScreen({ ...video, download_url: null, original_download_url: null }, onRefreshVideo);

    expect(screen.getByText("Download unavailable.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRefreshVideo).toHaveBeenCalledOnce();
  });

  it("omits the user-choice line when no spots were chosen by the user", () => {
    mock.proposal.data.spots = [
      {
        spot_id: "spot-1",
        span: [20, 21],
        question: "Keep this?",
        fixes: [],
        chosen_by: "default",
      },
    ];

    renderDoneScreen();

    expect(screen.queryByText(/spots? (were|was) your call/)).not.toBeInTheDocument();
  });
});
