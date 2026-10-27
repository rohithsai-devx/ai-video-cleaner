import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { components } from "@/api/generated/schema";
import { FoundSoFar, readySummary } from "./found-so-far";

type Progress = components["schemas"]["RunProgressEvent"];
type ProposalView = components["schemas"]["ProposalView"];

function expectTile(label: string, count: number | string) {
  expect(screen.getByText(label).parentElement?.textContent).toContain(String(count));
}

describe("FoundSoFar", () => {
  it("stays hidden before progress arrives", () => {
    const { container } = render(<FoundSoFar progress={null} ready={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows four progress counts and the known chapter list", () => {
    const progress: Progress = {
      pauses: 6,
      filler: 3,
      retakes: 3,
      slow_parts: 2,
      chapters: [
        { title: "Sign in", start: 0, end: 31 },
        { title: "Create the project", start: 31, end: 66 },
      ],
    };

    render(<FoundSoFar progress={progress} ready={false} />);

    expect(screen.getByRole("heading", { name: "Found so far" })).toBeTruthy();
    expectTile("long pauses", 6);
    expectTile("filler words", 3);
    expectTile("retakes", 3);
    expectTile("slow loads", 2);
    expect(screen.getByText("long pauses")).toBeTruthy();
    expect(screen.getByText("filler words")).toBeTruthy();
    expect(screen.getByText("retakes")).toBeTruthy();
    expect(screen.getByText("slow loads")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Chapters it sees" })).toBeTruthy();
    expect(screen.getByText("0:00")).toBeTruthy();
    expect(screen.getByText("0:31")).toBeTruthy();
    expect(screen.getByText("Create the project")).toBeTruthy();
  });

  it("shows dashes for unknown counts and uses proposal changes after ready", () => {
    const proposal = {
      changes: [
        { change_id: "p1", kind: "pause", span: [0, 2], reason: "", undone: false },
        { change_id: "f1", kind: "filler", span: [2, 3], reason: "", undone: true },
        { change_id: "r1", kind: "retake", span: [3, 4], reason: "", undone: false },
        { change_id: "s1", kind: "speed", span: [4, 8], reason: "", undone: false },
      ],
      chapters: [{ title: "Billing page", start: 10, end: 20 }],
    } as ProposalView;

    const { rerender } = render(<FoundSoFar progress={{ pauses: 99 }} ready={false} />);
    expect(screen.getAllByText("–")).toHaveLength(3);

    rerender(<FoundSoFar progress={null} proposal={proposal} ready />);
    expectTile("long pauses", 1);
    expectTile("filler words", 1);
    expectTile("retakes", 1);
    expectTile("slow loads", 1);
    expect(screen.getByText("Billing page")).toBeTruthy();
    expect(screen.queryByText("99")).toBeNull();
  });
});

describe("readySummary", () => {
  it("counts all proposal changes and only open spots as needing the viewer", () => {
    const proposal = {
      changes: Array.from({ length: 15 }).map(() => ({ kind: "cut" as const })),
      spots: [{ chosen_fix_id: null }, { chosen_fix_id: "fix-1" }, { chosen_fix_id: undefined }],
    };

    expect(readySummary(proposal)).toBe(
      "18 changes ready. 15 are applied already. 2 need your call.",
    );
  });

  it("uses the all-applied message when there are no spots", () => {
    expect(readySummary({ changes: [{ kind: "cut" }], spots: [] })).toBe(
      "1 changes ready. All are applied already.",
    );
  });
});
