import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/api/client", () => ({
  $api: {
    useQuery: () => ({
      isPending: false,
      isError: false,
      data: { id: "v1", title: "Demo", status: "uploaded", duration_s: 60 },
    }),
    useMutation: () => ({ mutate, isPending: false, isError: false }),
  },
}));

import { VideoScreen } from "./video-screen";

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <VideoScreen id="v1" />
    </QueryClientProvider>,
  );
}

describe("VideoScreen start run", () => {
  beforeEach(() => mutate.mockClear());

  it("sends the selected workspace voice as voice_id", () => {
    renderScreen();
    fireEvent.click(screen.getByLabelText("AI voiceover"));
    const select = screen.getByLabelText("Workspace voice") as HTMLSelectElement;
    expect(select.value).toBe("default");
    fireEvent.click(screen.getByRole("button", { name: "Process with AI" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].body).toEqual({
      mode: "review",
      voice: "ai",
      voice_id: select.value,
    });
  });

  it("sends no voice_id for my voice", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Process with AI" }));
    expect(mutate.mock.calls[0][0].body).toEqual({ mode: "review", voice: "original" });
  });
});
