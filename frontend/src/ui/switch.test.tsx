import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

describe("Switch", () => {
  it("has switch semantics, a described hint, and reports changes", () => {
    const onChange = vi.fn();
    render(
      <Switch
        label="Show me before it renders"
        hint="You get the editor."
        checked
        onChange={onChange}
      />,
    );

    const control = screen.getByRole("switch", { name: "Show me before it renders" });
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control).toHaveAccessibleDescription("You get the editor.");
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("respects disabled state", () => {
    render(
      <Switch
        label="Review first"
        hint="See changes."
        checked={false}
        disabled
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("switch", { name: "Review first" })).toBeDisabled();
  });
});
