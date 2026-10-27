import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Stepper } from "./stepper";

describe("Stepper", () => {
  it("shows each step state and marks the current step", () => {
    render(
      <Stepper
        steps={[
          { label: "Listening to your narration", detail: "Found what you said.", state: "done" },
          { label: "Planning the cuts", detail: "Working on it.", state: "current" },
          { label: "Getting it ready", detail: "Next.", state: "next" },
          { label: "Rendering", detail: "Could not finish.", state: "failed" },
        ]}
      />,
    );

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getByText("Planning the cuts").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText("done")).toHaveClass("sr-only");
    expect(screen.getByText("in progress")).toHaveClass("sr-only");
    expect(screen.getByText("failed")).toHaveClass("sr-only");
    expect(screen.getByText("next")).toHaveClass("sr-only");
  });
});
