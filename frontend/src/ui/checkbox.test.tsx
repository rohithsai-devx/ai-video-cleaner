import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("exposes the label and hint, and reports native changes", () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        label="Remove filler words"
        hint="um, uh, so, you know"
        checked={false}
        onChange={onChange}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Remove filler words" });
    expect(checkbox).toHaveAccessibleDescription("um, uh, so, you know");
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps disabled state native", () => {
    render(<Checkbox label="Remove pauses" checked disabled onChange={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "Remove pauses" })).toBeDisabled();
  });
});
