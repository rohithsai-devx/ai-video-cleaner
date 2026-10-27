import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScriptPanel } from "./script-panel";

const blocks = [
  {
    block_id: "internal-block-id",
    text: "Welcome to the project.",
    est_dur: 3,
    seg_ids: ["internal-segment-id"],
    source_span: [0, 3] as [number, number],
    target_min: 2,
    target_max: 5,
  },
];

describe("ScriptPanel", () => {
  it("shows editable script text without exposing internal ids", () => {
    const onTextChange = vi.fn();
    render(
      <ScriptPanel
        blocks={blocks}
        draftTexts={{}}
        flaggedIds={new Set(["internal-block-id"])}
        editable
        onTextChange={onTextChange}
      />,
    );

    const text = screen.getByRole("textbox", { name: /Script block 1/ });
    expect(text).toHaveValue("Welcome to the project.");
    expect(screen.getByText("Flagged")).toBeInTheDocument();
    expect(screen.queryByText(/internal-(block|segment)-id/)).not.toBeInTheDocument();
    fireEvent.change(text, { target: { value: "Welcome back." } });
    expect(onTextChange).toHaveBeenCalledWith("internal-block-id", "Welcome back.");
  });

  it("uses saved draft text and makes the script read-only when the run cannot be edited", () => {
    render(
      <ScriptPanel
        blocks={blocks}
        draftTexts={{ "internal-block-id": "Saved draft." }}
        flaggedIds={new Set()}
        editable={false}
        onTextChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: /Script block 1/ })).toHaveValue("Saved draft.");
    expect(screen.getByRole("textbox", { name: /Script block 1/ })).toHaveAttribute("readonly");
  });

  it("selects the script row and seeks to its narration start", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ScriptPanel
        blocks={blocks}
        draftTexts={{}}
        flaggedIds={new Set()}
        editable
        onTextChange={vi.fn()}
        activeId="script-internal-block-id"
        startTimes={{ "internal-block-id": 18 }}
        onSelect={onSelect}
      />,
    );
    const row = container.querySelector('[data-follow-id="script-internal-block-id"]');

    expect(row).toHaveAttribute("aria-current", "true");
    fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalledWith("internal-block-id", 18);
  });
});
