import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { components } from "@/api/generated/schema";
import { RunScreen } from "./run-screen";

type Run = components["schemas"]["Run"];

const mocks = vi.hoisted(() => ({
  run: undefined as Run | undefined,
  post: vi.fn(),
  invalidateQueries: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/api/client", () => ({
  $api: {
    useQuery: () => ({ data: { title: "A new project" } }),
    useMutation: () => ({ mutate: mocks.cancel, isPending: false, isError: false }),
    queryOptions: () => ({ queryKey: ["run", "retry-test"] }),
  },
  fetchClient: { POST: mocks.post },
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: { mutationFn: () => Promise<unknown> }) => ({
    isPending: false,
    mutateAsync: () => options.mutationFn(),
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));

vi.mock("./use-run-events", () => ({
  useRunEvents: () => ({
    run: { data: mocks.run, isError: false, refetch: vi.fn() },
    live: false,
  }),
}));

const failedRun = (retryable: boolean): Run => ({
  id: "retry-test",
  video_id: "video-test",
  status: "failed",
  stage: "agent",
  error: {
    stage: "3",
    message: "The AI service didn't answer in time. Trying again usually works.",
    retryable,
  },
  mode: "review",
  voice: "original",
  attempt: 1,
  flags: [],
  created_at: "2026-10-18T10:00:00Z",
});

describe("RunScreen retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.run = failedRun(true);
  });

  it("shows Try again only when the failure is retryable", () => {
    const { rerender } = render(<RunScreen id="retry-test" />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    mocks.run = failedRun(false);
    rerender(<RunScreen id="retry-test" />);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("posts a retry and refreshes the run query after success", async () => {
    mocks.post.mockResolvedValueOnce({
      response: { status: 202 },
      data: { run_id: "retry-test", status: "preprocessing", stage: "preprocess" },
    });
    render(<RunScreen id="retry-test" />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith("/runs/{run_id}/retry", {
        params: { path: { run_id: "retry-test" } },
      });
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["run", "retry-test"],
      });
    });
  });

  it("shows the video-page recovery link when retry returns 409", async () => {
    mocks.post.mockResolvedValueOnce({
      response: { status: 409 },
      error: { detail: { code: "not_retryable", message: "run failure cannot be retried" } },
    });
    render(<RunScreen id="retry-test" />);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    const videoLink = await screen.findByRole("link", { name: "video page" });
    expect(videoLink.parentElement?.textContent).toBe(
      "This run can't be retried. Start a new one from the video page.",
    );
    expect(videoLink.getAttribute("href")).toBe("/videos/video-test");
  });
});
