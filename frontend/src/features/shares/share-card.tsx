import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { cx } from "@/ui/cx";

export type ShareCardProps = {
  title: string;
  meta?: string;
  url: string | null;
  onCreate?: () => void;
  creating: boolean;
  onPlay?: () => void;
  downloadUrl?: string | null;
  downloadLabel: string;
  selected: boolean;
};

export function ShareCard({
  title,
  meta,
  url,
  onCreate,
  creating,
  onPlay,
  downloadUrl,
  downloadLabel,
  selected,
}: ShareCardProps) {
  const id = useId();
  const linkRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function copyLink() {
    if (!url) return;
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    setCopy("idle");
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
      copyTimer.current = setTimeout(() => setCopy("idle"), 2000);
    } catch {
      setCopy("failed");
      linkRef.current?.focus();
      linkRef.current?.select();
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      data-slot="share-card"
      className={cx(
        "flex min-w-0 flex-col gap-3 rounded-2xl p-5",
        selected ? "border-2 border-link bg-accent-soft" : "border border-line bg-surface",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={`${id}-title`} className="m-0 break-words text-pretty text-base font-semibold">
            {title}
          </h3>
          {meta ? <p className="m-0 break-words text-[13px] text-muted">{meta}</p> : null}
        </div>
        {onPlay ? (
          <Button variant="secondary" aria-pressed={selected} onClick={onPlay}>
            Play this version
          </Button>
        ) : null}
      </div>

      {url ? (
        <div className="flex min-w-0 flex-wrap gap-2">
          <label htmlFor={`${id}-link`} className="sr-only">
            {title} link
          </label>
          <input
            ref={linkRef}
            id={`${id}-link`}
            name={`${id}-share-link`}
            type="url"
            autoComplete="off"
            readOnly
            value={url}
            className="h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-canvas px-3 font-mono text-[13px]"
          />
          <Button
            variant={copy === "copied" ? "secondary" : "primary"}
            className={
              copy === "copied"
                ? "border-success bg-success-soft text-success hover:bg-success-soft"
                : undefined
            }
            onClick={copyLink}
          >
            {copy === "copied" ? "Copied" : "Copy link"}
          </Button>
        </div>
      ) : onCreate ? (
        <Button onClick={onCreate} disabled={creating}>
          {creating ? "Creating link…" : "Create link"}
        </Button>
      ) : null}

      {url ? (
        <p aria-live="polite" className="m-0 min-h-5 text-[13px] text-muted">
          {copy === "copied"
            ? "Copied"
            : copy === "failed"
              ? "Could not copy. The link is selected, so press Cmd+C to copy."
              : ""}
        </p>
      ) : null}

      {downloadUrl ? (
        <a
          href={downloadUrl}
          download
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-line-strong bg-surface px-5 text-sm font-medium text-ink no-underline hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {downloadLabel}
        </a>
      ) : null}
    </section>
  );
}
