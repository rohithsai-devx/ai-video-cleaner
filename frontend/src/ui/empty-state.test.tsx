import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("centres its message and optional action", () => {
    render(
      <EmptyState action={<button>Upload a video</button>}>Your library is empty.</EmptyState>,
    );
    expect(screen.getByText("Your library is empty.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload a video" })).toBeInTheDocument();
  });
});
