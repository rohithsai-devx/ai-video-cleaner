import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  list: {
    data: [] as { kind: "cleaned" | "raw"; url: string }[],
    isPending: false,
    isError: false,
  },
  create: {
    data: undefined as { kind: "raw"; url: string } | undefined,
    isPending: false,
    isError: false,
    mutate: vi.fn(),
  },
}));

vi.mock("@/api/client", () => ({
  $api: {
    queryOptions: vi.fn(() => ({ queryKey: ["shares"] })),
    useQuery: vi.fn(() => mock.list),
    useMutation: vi.fn(() => mock.create),
  },
}));

import { RawShareCard } from "./raw-share-card";

function renderCard(status = "uploaded", originalUrl: string | null = "/original.mp4") {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RawShareCard videoId="v1" status={status as "uploaded"} originalUrl={originalUrl} />
    </QueryClientProvider>,
  );
}

describe("RawShareCard", () => {
  beforeEach(() => {
    mock.list.data = [];
    mock.create.data = undefined;
    mock.create.mutate.mockClear();
  });

  it("creates a raw link from the share card", () => {
    renderCard();

    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    expect(mock.create.mutate).toHaveBeenCalledWith(
      {
        params: { path: { video_id: "v1" } },
        body: { kind: "raw", visibility: "link", expires_at: null },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(
      screen.getByText(
        "No AI, no waiting. The link plays this recording with your own voice, uncut. You can still clean it later; this link keeps showing the original.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an existing raw link and ignores the cleaned link", () => {
    mock.list.data = [
      { kind: "cleaned", url: "https://stepwise.app/s/clean" },
      { kind: "raw", url: "https://stepwise.app/s/raw" },
    ];

    renderCard();

    expect(screen.getByRole("textbox", { name: "Share it as is link" })).toHaveValue(
      "https://stepwise.app/s/raw",
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).not.toBeInTheDocument();
  });

  it("does not render without an original recording URL", () => {
    const { container } = renderCard("uploaded", null);

    expect(container).toBeEmptyDOMElement();
  });
});
