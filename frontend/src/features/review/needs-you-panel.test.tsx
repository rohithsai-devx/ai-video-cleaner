import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import demo from "../../../e2e/fixtures/proposal-demo.json";
import type { components } from "@/api/generated/schema";
import { NeedsYouPanel } from "./needs-you-panel";

type ProposalView = components["schemas"]["ProposalView"];
const fixture = demo as unknown as ProposalView;

function Harness({
  playhead = 0,
  onChoose = () => undefined,
}: {
  playhead?: number;
  onChoose?: (spot: components["schemas"]["Spot"], fix: components["schemas"]["Fix"]) => void;
}) {
  const [chosenFixes, setChosenFixes] = useState<Record<string, string>>({});
  return (
    <NeedsYouPanel
      spots={fixture.spots}
      chapters={fixture.chapters}
      chosenFixes={chosenFixes}
      editable
      playhead={playhead}
      onChooseFix={(spot, fix) => {
        onChoose(spot, fix);
        setChosenFixes((current) => ({ ...current, [spot.spot_id]: fix.fix_id }));
      }}
    />
  );
}

describe("NeedsYouPanel", () => {
  it("shows the empty state when no spots need a decision", () => {
    render(
      <NeedsYouPanel
        spots={[]}
        chapters={[]}
        chosenFixes={{}}
        editable
        playhead={0}
        onChooseFix={vi.fn()}
      />,
    );
    expect(screen.getByText("Nothing needs you.")).toBeInTheDocument();
  });

  it("shows the chapter, question and first fix, then marks a chosen fix as decided", () => {
    const onChoose = vi.fn();
    render(<Harness playhead={43} onChoose={onChoose} />);

    expect(screen.getByText("0:42 · Create the project")).toBeInTheDocument();
    expect(
      screen.getByText("The narration runs about 4 seconds longer than the screen here."),
    ).toBeInTheDocument();
    expect(screen.getByText("Playing")).toBeInTheDocument();
    const fixes = screen.getAllByRole("button", {
      name: /Shorten the narration|Hold the last frame|Slow the screen/,
    });
    expect(fixes.map((button) => button.textContent)).toEqual([
      "Shorten the narration",
      "Hold the last frame 4 s",
      "Slow the screen to 0.7×",
    ]);
    expect(fixes[0]).toHaveClass("bg-ink");

    fireEvent.click(fixes[0]!);
    expect(onChoose).toHaveBeenCalledWith(fixture.spots[0], fixture.spots[0]?.fixes[0]);
    expect(screen.getByText("You chose: Shorten the narration")).toBeInTheDocument();
    expect(screen.getByText("Decided")).toBeInTheDocument();
  });

  it("lets the user change a saved or draft choice", () => {
    render(
      <NeedsYouPanel
        spots={fixture.spots}
        chapters={fixture.chapters}
        chosenFixes={{ "spot-narration": "hold" }}
        editable
        playhead={0}
        onChooseFix={vi.fn()}
      />,
    );

    expect(screen.getByText("You chose: Hold the last frame 4 s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: "Shorten the narration" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hold the last frame 4 s" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Slow the screen to 0.7×" })).toBeInTheDocument();
  });
});
