"use client";

import { CaretLeft, Sparkle } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { $api } from "@/api/client";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { cx } from "@/ui/cx";
import { runRequestBody, type Mode, type Voice } from "./run-request";
import { formatDuration, statusBadge } from "./video-status";

const VOICES = [{ id: "default", label: "Default narrator" }] as const;

const MODES: { id: Mode; label: string; hint: string }[] = [
  {
    id: "review",
    label: "Let me review first",
    hint: "See the script and every cut with its reason. Edit, then approve.",
  },
  {
    id: "auto",
    label: "Render automatically",
    hint: "Skip review unless the agent flags something it is unsure about.",
  },
];

export function VideoScreen({
  id,
  renderShare,
}: {
  id: string;
  renderShare?: (v: { videoId: string; playbackUrl?: string | null }) => ReactNode;
}) {
  const router = useRouter();
  const video = $api.useQuery("get", "/videos/{video_id}", { params: { path: { video_id: id } } });
  const start = $api.useMutation("post", "/videos/{video_id}/runs");
  const [mode, setMode] = useState<Mode>("review");
  const [voice, setVoice] = useState<Voice>("original");
  const [voiceId, setVoiceId] = useState<string>(VOICES[0].id);

  const v = video.data;
  const badge = v ? statusBadge(v) : null;

  const queryClient = useQueryClient();

  function submit() {
    start.mutate(
      {
        params: { path: { video_id: id } },
        body: runRequestBody({ mode, voice, voiceId }),
      },
      {
        onSuccess: (run) => {
          // The video now has a live run; drop the cached "uploaded" copy so returning here is fresh.
          void queryClient.invalidateQueries({
            queryKey: $api.queryOptions("get", "/videos/{video_id}", {
              params: { path: { video_id: id } },
            }).queryKey,
          });
          void queryClient.invalidateQueries({ queryKey: ["videos", "list"] });
          router.push(`/runs/${run.run_id}`);
        },
      },
    );
  }

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="flex min-h-16 items-center gap-4 border-b border-line bg-surface px-4 sm:px-8">
        <Link
          href="/library"
          className="inline-flex items-center gap-2 text-sm text-muted no-underline hover:text-ink"
        >
          <CaretLeft size={16} aria-hidden="true" />
          Library
        </Link>
        <span className="text-line-strong">/</span>
        <span className="truncate text-sm font-medium">{v?.title ?? ""}</span>
      </header>

      <main className="mx-auto flex max-w-[1280px] flex-wrap items-start gap-8 px-4 py-8 sm:px-8">
        <section className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
          {video.isPending ? (
            <>
              <Skeleton className="aspect-video rounded-3xl" />
              <Skeleton className="h-6 w-1/2" />
            </>
          ) : video.isError || !v ? (
            <p role="alert" className="text-sm text-danger">
              Could not load this video.
            </p>
          ) : (
            <>
              <div className="aspect-video overflow-hidden rounded-3xl bg-player">
                {v.playback_url ? (
                  <video
                    src={v.playback_url}
                    poster={v.poster_url ?? undefined}
                    controls
                    preload="metadata"
                    className="size-full"
                  />
                ) : (
                  <div className="relative flex size-full items-center justify-center text-sm text-white/70">
                    {v.poster_url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived GCS URL; next/image cannot cache it
                      <img
                        src={v.poster_url}
                        alt=""
                        width={1280}
                        height={720}
                        className="absolute inset-0 size-full object-cover opacity-50"
                      />
                    ) : null}
                    <span className="relative">Video is not available yet</span>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
                <h1 className="m-0 flex-[1_1_320px] text-[22px] text-ink">{v.title}</h1>
                {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
                <span className="font-mono">
                  {[
                    formatDuration(v.duration_s),
                    v.width && v.height ? `${v.width} × ${v.height}` : "",
                    v.fps ? `${Math.round(v.fps)} fps` : "",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </span>
              </div>
              {v.status === "uploaded" ? (
                <p className="m-0 text-sm text-muted">
                  This is your raw recording. Nothing has been changed yet.
                </p>
              ) : null}
            </>
          )}
        </section>

        {v?.status === "ready" ? (
          renderShare?.({ videoId: id, playbackUrl: v.playback_url })
        ) : v?.status === "uploaded" ? (
          <aside className="flex min-w-0 flex-[1_1_360px] flex-col gap-6 rounded-3xl bg-accent p-8">
            <div className="flex flex-col gap-1.5">
              <h2 className="m-0 text-3xl">Process with AI</h2>
              <p className="m-0 text-sm leading-normal text-ink/80">
                The agent writes a clean script and a cut plan from what you said and showed.
              </p>
            </div>

            <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
              <legend className="mb-2.5 text-sm font-medium">After the agent finishes</legend>
              {MODES.map((m) => (
                <label
                  key={m.id}
                  className={cx(
                    "flex cursor-pointer flex-col gap-1 rounded-xl border-2 p-4",
                    "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink",
                    mode === m.id ? "border-ink bg-white" : "border-transparent bg-white/45",
                  )}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={m.id}
                    checked={mode === m.id}
                    onChange={() => setMode(m.id)}
                    className="sr-only"
                  />
                  <span className="text-[15px] font-medium">{m.label}</span>
                  <span className="text-[13px] leading-snug text-ink/80">{m.hint}</span>
                </label>
              ))}
            </fieldset>

            <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
              <legend className="mb-2.5 text-sm font-medium">Voice</legend>
              <div className="flex gap-1 rounded-xl bg-white/40 p-1">
                {(
                  [
                    { id: "original", label: "My voice" },
                    { id: "ai", label: "AI voiceover" },
                  ] as const
                ).map((o) => (
                  <label
                    key={o.id}
                    className={cx(
                      "flex min-h-11 flex-1 cursor-pointer items-center justify-center rounded-lg px-3 text-sm font-medium",
                      "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink",
                      voice === o.id ? "bg-white text-ink" : "text-ink/80",
                    )}
                  >
                    <input
                      type="radio"
                      name="voice"
                      value={o.id}
                      checked={voice === o.id}
                      onChange={() => setVoice(o.id)}
                      className="sr-only"
                    />
                    {o.label}
                  </label>
                ))}
              </div>
              {voice === "ai" ? (
                <>
                  <label htmlFor="voice-id" className="text-[13px] text-ink/80">
                    Workspace voice
                  </label>
                  <select
                    id="voice-id"
                    value={voiceId}
                    onChange={(e) => setVoiceId(e.target.value)}
                    className="h-11 rounded-xl border border-line-strong bg-white px-2.5 text-sm text-ink"
                  >
                    {VOICES.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
            </fieldset>

            {start.isError ? (
              <p role="alert" className="m-0 text-sm text-danger">
                Could not start processing. Try again.
              </p>
            ) : null}
            <Button onClick={submit} disabled={start.isPending} className="h-12 text-[15px]">
              <Sparkle size={18} aria-hidden="true" />
              {start.isPending ? "Starting…" : "Process with AI"}
            </Button>
            <p className="m-0 text-[13px] text-ink/80">
              Usually a few minutes for a recording this long.
            </p>
          </aside>
        ) : null}
      </main>
    </div>
  );
}
