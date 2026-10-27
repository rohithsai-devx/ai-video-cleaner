import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RadioGroup } from "./radio-group";

describe("RadioGroup", () => {
  it("labels each choice and keeps the side action outside the label", () => {
    const onChange = vi.fn();
    render(
      <RadioGroup
        name="voice"
        legend="Voice"
        options={[
          {
            value: "coral",
            label: "Coral",
            hint: "Warm, calm",
            action: <button>Play sample</button>,
          },
          { value: "ash", label: "Ash", hint: "Clear, steady" },
        ]}
        value="coral"
        onChange={onChange}
      />,
    );

    const coral = screen.getByRole("radio", { name: "Coral" });
    expect(screen.getByRole("radiogroup", { name: "Voice" })).toBeInTheDocument();
    expect(coral).toHaveAccessibleDescription("Warm, calm");
    expect(coral).toBeChecked();
    expect(screen.getByRole("button", { name: "Play sample" }).closest("label")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Ash" }));
    expect(onChange).toHaveBeenCalledWith("ash");
  });

  it("supports arrow-key selection", () => {
    const onChange = vi.fn();
    render(
      <RadioGroup
        name="voice"
        legend="Voice"
        options={[
          { value: "coral", label: "Coral" },
          { value: "ash", label: "Ash" },
        ]}
        value="coral"
        onChange={onChange}
      />,
    );

    const coral = screen.getByRole("radio", { name: "Coral" });
    const ash = screen.getByRole("radio", { name: "Ash" });
    fireEvent.keyDown(coral, { key: "ArrowRight" });
    expect(ash).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith("ash");
  });
});
