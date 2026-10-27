import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Banner } from "./banner";

describe("Banner", () => {
  it("uses a polite status role for informational content", () => {
    render(<Banner tone="info">18 changes ready.</Banner>);
    expect(screen.getByRole("status")).toHaveTextContent("18 changes ready.");
  });

  it("uses an alert role for danger and renders the action", () => {
    render(
      <Banner tone="danger" action={<button>Try again</button>}>
        We could not finish.
      </Banner>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("We could not finish.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
