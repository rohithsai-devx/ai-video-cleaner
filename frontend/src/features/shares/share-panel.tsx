"use client";

import { useRef, useState } from "react";
import { $api } from "@/api/client";
import { Button } from "@/ui/button";
import { cx } from "@/ui/cx";
import {
  absoluteShareUrl,
  EXPIRY_OPTIONS,
  expiryToIso,
  VISIBILITY_OPTIONS,
  type Expiry,
  type Visibility,
} from "./share-options";

export function SharePanel({
  videoId,
  playbackUrl,
}: {
  videoId: string;
  playbackUrl?: string | null;
}) {
  const create = $api.useMutation("post", "/videos/{video_id}/shares");
  const [visibility, setVisibility] = useState<Visibility>("link");
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const linkRef = useRef<HTMLInputElement>(null);

  const link = create.data ? absoluteShareUrl(create.data.url, window.location.origin) : null;

  function createLink() {
    setCopy("idle");
    create.mutate({
      params: { path: { video_id: videoId } },
      body: { kind: "cleaned", visibility, expires_at: expiryToIso(expiry) },
    });
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopy("copied");
    } catch {
      setCopy("failed");
      linkRef.current?.focus();
      linkRef.current?.select();
    }
  }

  return (
    <aside
      data-slot="share-panel"
      className="flex min-w-0 flex-[1_1_360px] flex-col gap-5 rounded-3xl border border-line bg-surface p-8"
    >
      <h2 className="m-0 text-3xl font-semibold">Share</h2>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2.5 text-sm font-medium">Who can watch</legend>
        {VISIBILITY_OPTIONS.map((o) => (
          <label
            key={o.id}
            className={cx(
              "flex cursor-pointer flex-col gap-0.5 rounded-xl border-2 px-3.5 py-3",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink",
              visibility === o.id ? "border-ink" : "border-line",
            )}
          >
            <input
              type="radio"
              name="visibility"
              className="sr-only"
              checked={visibility === o.id}
              onChange={() => setVisibility(o.id)}
            />
            <span className="text-[15px] font-medium">{o.label}</span>
            <span className="text-[13px] text-muted">{o.hint}</span>
          </label>
        ))}
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor="share-expiry" className="text-sm font-medium">
          Link expires
        </label>
        <select
          id="share-expiry"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value as Expiry)}
          className="h-11 rounded-xl border border-line-strong bg-surface px-2.5 text-sm"
        >
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <Button onClick={createLink} disabled={create.isPending}>
        {create.isPending ? "Creating link…" : link ? "Share a new link" : "Share link"}
      </Button>
      {create.isError ? (
        <p role="alert" className="m-0 text-sm text-danger">
          Could not create the link. Try again.
        </p>
      ) : null}

      {link ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="share-link" className="text-sm font-medium">
            Link
          </label>
          <div className="flex gap-2">
            <input
              ref={linkRef}
              id="share-link"
              readOnly
              value={link}
              className="h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-canvas px-3 font-mono text-[13px]"
            />
            <Button onClick={copyLink}>Copy link</Button>
          </div>
          <p aria-live="polite" className="m-0 min-h-5 text-[13px] text-muted">
            {copy === "copied"
              ? "Copied"
              : copy === "failed"
                ? "Could not copy. The link is selected, so press Ctrl+C or ⌘C."
                : ""}
          </p>
        </div>
      ) : null}

      {playbackUrl ? (
        <a
          href={playbackUrl}
          download
          className="inline-flex min-h-11 items-center justify-center rounded-xl border border-line-strong bg-surface px-5 text-sm font-medium text-ink no-underline hover:bg-canvas"
        >
          Download MP4
        </a>
      ) : null}
    </aside>
  );
}
