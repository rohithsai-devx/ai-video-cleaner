import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "./tabs";

describe("Tabs", () => {
  it("keeps labelled panels mounted and exposes the selected panel", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        label="Review sections"
        tabs={[
          { id: "needs-you", label: "Needs you", count: 3 },
          { id: "done", label: "Done by AI", count: 15 },
          { id: "script", label: "Script" },
        ]}
        value="needs-you"
        onChange={onChange}
      >
        {{
          "needs-you": <p>Needs-you panel</p>,
          done: <p>Done panel</p>,
          script: <p>Script panel</p>,
        }}
      </Tabs>,
    );

    const tablist = screen.getByRole("tablist", { name: "Review sections" });
    const first = screen.getByRole("tab", { name: "Needs you 3" });
    const done = screen.getByRole("tab", { name: "Done by AI 15" });
    expect(tablist).toBeInTheDocument();
    expect(first).toHaveAttribute("aria-selected", "true");
    expect(first).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tabpanel", { name: "Needs you 3" })).toHaveTextContent(
      "Needs-you panel",
    );
    expect(screen.getByText("Done panel").closest("[role=tabpanel]")).toHaveAttribute("hidden");
    expect(first).toHaveClass("border-ink");
    fireEvent.click(done);
    expect(onChange).toHaveBeenCalledWith("done");
  });

  it("moves and selects tabs with arrows, Home, and End", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        label="Sections"
        tabs={[
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
          { id: "three", label: "Three" },
        ]}
        value="one"
        onChange={onChange}
      >
        {{ one: <p>One panel</p>, two: <p>Two panel</p>, three: <p>Three panel</p> }}
      </Tabs>,
    );

    const one = screen.getByRole("tab", { name: "One" });
    const two = screen.getByRole("tab", { name: "Two" });
    const three = screen.getByRole("tab", { name: "Three" });
    fireEvent.keyDown(one, { key: "ArrowRight" });
    expect(two).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("two");
    fireEvent.keyDown(two, { key: "End" });
    expect(three).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("three");
    fireEvent.keyDown(three, { key: "Home" });
    expect(one).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("one");
  });
});
