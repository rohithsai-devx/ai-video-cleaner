import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  result: { isPending: false, isError: false, data: [] as unknown[] },
}));

vi.mock("@/api/client", () => ({ $api: { useQuery: () => mock.result } }));

import { PastAttempts, formatRunCreatedAt } from "./past-attempts";

const statuses = [
  "awaiting_review",
  "queued",
  "preprocessing",
  "agent_running",
  "approved",
  "postprocessing",
  "done",
  "done",
  "failed",
  "cancelled",
] as const;

const attempts = statuses.map((status, index) => ({
  run_id: `run-${index}`,
  status,
  created_at: "2026-10-27T10:05:00.000Z",
  voice: index % 2 === 0 ? "original" : "ai",
  voice_id: index % 2 === 0 ? null : "coral",
  needs_you: index === 0 ? 3 : 0,
}));

describe("PastAttempts", () => {
  beforeEach(() => {
    mock.result = { isPending: false, isError: false, data: attempts };
  });

  it("renders the action and tone copy for each run status", () => {
    render(<PastAttempts videoId="v1" currentRunId="run-6" />);

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(attempts.length);
    expect(within(rows[0]).getByText("Waiting for you")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Waiting for you")).toHaveClass("bg-warning-soft");
    expect(within(rows[0]).getByText("· 3 to check")).toBeInTheDocument();
    expect(within(rows[0]).getByRole("link", { name: "Open editor" })).toHaveAttribute(
      "href",
      "/runs/run-0/review",
    );

    for (const index of [1, 2, 3, 4, 5]) {
      expect(within(rows[index]).getByText("In progress")).toBeInTheDocument();
      expect(within(rows[index]).getByText("In progress")).toHaveClass("bg-accent-soft");
      expect(within(rows[index]).getByRole("link", { name: "See progress" })).toHaveAttribute(
        "href",
        `/runs/run-${index}`,
      );
    }

    expect(within(rows[6]).getByText("Done")).toBeInTheDocument();
    expect(within(rows[6]).getByText("Done")).toHaveClass("bg-success-soft");
    expect(within(rows[6]).getByRole("link", { name: "Watch" })).toHaveAttribute(
      "href",
      "/videos/v1",
    );
    expect(within(rows[7]).getByText("Replaced by a newer version")).toBeInTheDocument();
    expect(within(rows[8]).getByText("Failed")).toBeInTheDocument();
    expect(within(rows[8]).getByText("Failed")).toHaveClass("bg-danger-soft");
    expect(within(rows[8]).getByRole("link", { name: "See what happened" })).toHaveAttribute(
      "href",
      "/runs/run-8",
    );
    expect(within(rows[9]).getByText("Stopped")).toBeInTheDocument();
    expect(within(rows[9]).getByText("Stopped")).toHaveClass("bg-sunken");
    expect(within(rows[9]).getByText("No video made")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/My voice/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/AI voice/)).toBeInTheDocument();
  });

  it("hides the section when there are no runs", () => {
    mock.result.data = [];
    render(<PastAttempts videoId="v1" currentRunId={null} />);

    expect(screen.queryByRole("heading", { name: "Past attempts" })).not.toBeInTheDocument();
  });
});

describe("formatRunCreatedAt", () => {
  it("uses Today, Yesterday and a date for older runs", () => {
    const today = new Date(2026, 9, 27, 12, 0);
    const sameDay = new Date(2026, 9, 27, 10, 5);
    const yesterday = new Date(2026, 9, 26, 10, 5);
    const older = new Date(2026, 9, 20, 10, 5);
    const time = (date: Date) =>
      new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);

    expect(formatRunCreatedAt(sameDay.toISOString(), today)).toBe(`Today, ${time(sameDay)}`);
    expect(formatRunCreatedAt(yesterday.toISOString(), today)).toBe(
      `Yesterday, ${time(yesterday)}`,
    );
    expect(formatRunCreatedAt(older.toISOString(), today)).toContain(", ");
    expect(formatRunCreatedAt(older.toISOString(), today)).toBe(
      `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(older)}, ${time(older)}`,
    );
    expect(formatRunCreatedAt(older.toISOString(), today)).not.toMatch(/^Today|^Yesterday/);
  });
});
