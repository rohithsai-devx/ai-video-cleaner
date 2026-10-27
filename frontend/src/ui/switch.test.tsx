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

  it("keeps caller descriptions alongside the hint", () => {
    render(
      <>
        <p id="switch-help">This preference can be changed later.</p>
        <Switch
          label="Show me before it renders"
          hint="You get the editor."
          aria-describedby="switch-help"
          checked={false}
          onChange={() => {}}
        />
      </>,
    );

    expect(
      screen.getByRole("switch", { name: "Show me before it renders" }),
    ).toHaveAccessibleDescription("This preference can be changed later. You get the editor.");
  });

  it("keeps Space available for native switch activation", () => {
    const onKeyDown = vi.fn();
    render(
      <Switch
        label="Show me before it renders"
        hint="You get the editor."
        checked={false}
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );

    const control = screen.getByRole("switch", { name: "Show me before it renders" });
    control.focus();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    control.dispatchEvent(event);

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(control).toHaveFocus();
  });
});
