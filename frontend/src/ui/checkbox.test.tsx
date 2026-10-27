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

  it("keeps caller descriptions alongside the hint", () => {
    render(
      <>
        <p id="checkbox-help">This setting affects every clip.</p>
        <Checkbox
          label="Remove filler words"
          hint="um, uh, so, you know"
          aria-describedby="checkbox-help"
          checked={false}
          onChange={() => {}}
        />
      </>,
    );

    expect(
      screen.getByRole("checkbox", { name: "Remove filler words" }),
    ).toHaveAccessibleDescription("This setting affects every clip. um, uh, so, you know");
  });

  it("keeps Space available for native checkbox activation", () => {
    const onKeyDown = vi.fn();
    render(
      <Checkbox
        label="Remove filler words"
        checked={false}
        onChange={() => {}}
        onKeyDown={onKeyDown}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Remove filler words" });
    checkbox.focus();
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    checkbox.dispatchEvent(event);

    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
    expect(checkbox).toHaveFocus();
  });
});
