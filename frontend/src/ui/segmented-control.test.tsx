import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./segmented-control";

const options = [
  { value: "original", label: "Keep my voice" },
  { value: "ai", label: "AI voice" },
];

describe("SegmentedControl", () => {
  it("renders a labelled native radio group and changes selection", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        name="voice"
        legend="Voice"
        options={options}
        value="original"
        onChange={onChange}
      />,
    );

    const group = screen.getByRole("group", { name: "Voice" });
    const original = screen.getByRole("radio", { name: "Keep my voice" });
    const ai = screen.getByRole("radio", { name: "AI voice" });
    expect(group).toBeInTheDocument();
    expect(original).toBeChecked();
    expect(ai).not.toBeChecked();
    fireEvent.click(ai);
    expect(onChange).toHaveBeenCalledWith("ai");
  });

  it("moves focus and selection with arrow keys", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        name="voice"
        legend="Voice"
        options={options}
        value="original"
        onChange={onChange}
      />,
    );
    const original = screen.getByRole("radio", { name: "Keep my voice" });
    const ai = screen.getByRole("radio", { name: "AI voice" });

    fireEvent.keyDown(original, { key: "ArrowRight" });

    expect(ai).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith("ai");
  });
});
