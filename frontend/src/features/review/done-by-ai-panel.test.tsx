import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { components } from "@/api/generated/schema";
import { DoneByAiPanel } from "./done-by-ai-panel";

type Entry = components["schemas"]["EDLEntry"];
type Change = components["schemas"]["Change"];

const entries: Entry[] = [
  {
    seg_id: "pause-segment",
    action: "cut",
    src: [12, 20],
    speed: 1,
    freeze_s: 0,
    reasoning: "The pause made the walkthrough harder to follow.",
    block_id: null,
  },
  {
    seg_id: "filler-segment",
    action: "keep",
    src: [22, 24],
    speed: 1,
    freeze_s: 0,
    reasoning: "You chose to keep this word.",
    block_id: null,
  },
];

const changes: Change[] = [
  {
    change_id: "pause-segment",
    kind: "pause",
    span: [12, 20],
    speed: null,
    hold_s: null,
    reason: "The pause made the walkthrough harder to follow.",
    undone: false,
  },
  {
    change_id: "filler-segment",
    kind: "filler",
    span: [22, 24],
    speed: null,
    hold_s: null,
    reason: "You chose to keep this word.",
    undone: true,
  },
];

describe("DoneByAiPanel", () => {
  it("lists changes with plain labels and provides undo and redo actions", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    render(
      <DoneByAiPanel
        changes={changes}
        entries={entries}
        editable
        onUndo={onUndo}
        onRedo={onRedo}
      />,
    );

    expect(screen.getByText("Pause removed")).toBeInTheDocument();
    expect(screen.getByText("0:12 to 0:20")).toBeInTheDocument();
    expect(
      screen.getByText("The pause made the walkthrough harder to follow."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(onUndo).toHaveBeenCalledWith(changes[0]);
    expect(onRedo).toHaveBeenCalledWith(changes[1]);
    expect(screen.queryByText(/pause-segment|filler-segment/)).not.toBeInTheDocument();
  });

  it("hides undo and redo while the proposal is read-only", () => {
    render(
      <DoneByAiPanel
        changes={changes}
        entries={entries}
        editable={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Redo" })).not.toBeInTheDocument();
  });

  it("selects and seeks to the active change row", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <DoneByAiPanel
        changes={changes}
        entries={entries}
        editable
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        activeId="change-pause-segment"
        onSelect={onSelect}
      />,
    );
    const row = container.querySelector('[data-follow-id="change-pause-segment"]');

    expect(row).toHaveAttribute("aria-current", "true");
    fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalledWith("pause-segment", 12);
  });
});
