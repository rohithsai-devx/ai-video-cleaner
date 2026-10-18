"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "./button";

// A small modal confirm on the native <dialog>: Escape cancels, focus returns to the opener.
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Go back",
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof el.showModal === "function") {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute("open", "");
    }
    return () => {
      if (typeof el.close === "function" && el.open) el.close();
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(92vw,420px)] rounded-2xl border border-line bg-surface p-6 text-ink shadow-xl backdrop:bg-ink/40"
    >
      <h2 id={titleId} className="m-0 text-xl">
        {title}
      </h2>
      {description ? (
        <p id={descId} className="mt-2 mb-0 text-sm leading-normal text-muted">
          {description}
        </p>
      ) : null}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button onClick={onConfirm} variant={danger ? "danger" : "primary"}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
