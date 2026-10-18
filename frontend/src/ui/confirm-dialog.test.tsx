import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./confirm-dialog";

function setup(open: boolean) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ConfirmDialog
      open={open}
      title="Cancel this run?"
      description="The agent stops and nothing is rendered."
      confirmLabel="Cancel run"
      cancelLabel="Keep running"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel, ...utils };
}

describe("ConfirmDialog", () => {
  it("renders nothing visible while closed", () => {
    setup(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a labelled dialog with its description when open", () => {
    setup(true);
    const dialog = screen.getByRole("dialog", { name: "Cancel this run?" });
    expect(dialog).toHaveAccessibleDescription("The agent stops and nothing is rendered.");
  });

  it("calls onConfirm from the confirm button", () => {
    const { onConfirm, onCancel } = setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("calls onCancel from the cancel button and from Escape", () => {
    const { onCancel, onConfirm } = setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
