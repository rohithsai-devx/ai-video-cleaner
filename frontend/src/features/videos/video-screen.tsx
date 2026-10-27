"use client";

import { CaretLeft, Sparkle } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { $api } from "@/api/client";
import type { components } from "@/api/generated/schema";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/checkbox";
import { RadioGroup } from "@/ui/radio-group";
import { SegmentedControl } from "@/ui/segmented-control";
import { Skeleton } from "@/ui/skeleton";
import { Switch } from "@/ui/switch";
import {
  DEFAULT_FIX_OPTIONS,
  runRequestBody,
  type FixOptions,
  type Mode,
  type Voice,
} from "./run-request";
import { formatDuration } from "./video-status";
import { PastAttempts } from "./past-attempts";

export type ShareSlot = (video: {
  videoId: string;
  status: components["schemas"]["Video"]["status"];
  title: string;
  playbackUrl?: string | null;
  originalUrl?: string | null;
}) => ReactNode;

const NARRATION = {
  original: "Your own audio, with the cut parts removed. Nothing is re-recorded.",
  ai: "The AI writes a clean script from what you said and reads it out. You can edit every line first.",
} as const;

const FIX_OPTION_ROWS: { key: keyof FixOptions; label: string; hint: string }[] = [
  {
    key: "pauses",
    label: "Remove long pauses",
    hint: "Silences over a second, while nothing changes on screen",
  },
  { key: "filler", label: "Remove filler words", hint: "um, uh, so, you know" },
  {
    key: "retakes",
    label: "Remove retakes",
    hint: "When you restart a sentence, it keeps the last try",
  },
  {
    key: "slow_parts",
    label: "Speed up slow parts",
    hint: "Page loads and long waits play faster",
  },
];

export function VideoScreen({ id, renderShare }: { id: string; renderShare?: ShareSlot }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("review");
  const [voice, setVoice] = useState<Voice>("original");
  const [voiceId, setVoiceId] = useState("");
  const [fixOptions, setFixOptions] = useState<FixOptions>(() => ({ ...DEFAULT_FIX_OPTIONS }));
  const [failedPlaybackUrl, setFailedPlaybackUrl] = useState<string | null>(null);
  const [playingSampleId, setPlayingSampleId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const video = $api.useQuery("get", "/videos/{video_id}", { params: { path: { video_id: id } } });
  const voiceList = $api.useQuery("get", "/voices", undefined, { enabled: voice === "ai" });
  const start = $api.useMutation("post", "/videos/{video_id}/runs");

  const v = video.data;
  const voices = voiceList.data?.voices ?? [];
  const selectedVoiceId = voices.some((item) => item.id === voiceId)
    ? voiceId
    : (voiceList.data?.default_voice_id ?? "");
  const activeSample = voices.find((item) => item.id === playingSampleId);
  const sourceUrl = v
    ? v.status === "ready"
      ? v.playback_url
      : (v.original_url ?? v.playback_url)
    : null;

  const queryClient = useQueryClient();

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeSample) return;
    audio.src = activeSample.sample_path;
    audio.load();
    void audio.play().catch(() => setPlayingSampleId(null));
    return () => audio.pause();
  }, [activeSample]);

  function toggleSample(voiceOptionId: string) {
    setPlayingSampleId((current) => (current === voiceOptionId ? null : voiceOptionId));
  }

  function submit() {
    start.mutate(
      {
        params: { path: { video_id: id } },
        body: runRequestBody({ mode, voice, voiceId: selectedVoiceId, fixOptions }),
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

      <main className="mx-auto flex max-w-[1280px] flex-wrap items-start gap-8 px-6 py-8">
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
              <div className="aspect-video overflow-hidden rounded-[20px] bg-player">
                {sourceUrl ? (
                  failedPlaybackUrl === sourceUrl ? (
                    <div className="relative flex size-full items-center justify-center text-sm text-white/70">
                      Could not load this video.
                    </div>
                  ) : (
                    <video
                      src={sourceUrl}
                      poster={v.poster_url ?? undefined}
                      controls
                      preload="metadata"
                      className="size-full"
                      onError={() => setFailedPlaybackUrl(sourceUrl)}
                    />
                  )
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
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="m-0 text-[26px] font-semibold text-ink">{v.title}</h1>
                {v.status !== "ready" ? <Badge tone="neutral">Original recording</Badge> : null}
                {v.duration_s != null || (v.width != null && v.height != null) ? (
                  <span className="font-mono text-sm text-muted">
                    {[
                      formatDuration(v.duration_s),
                      v.width != null && v.height != null ? `${v.width} × ${v.height}` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
              </div>
              <p className="m-0 text-sm text-muted">
                Your recording is saved as it is. Cleaning makes a new version and never changes
                this one.
              </p>
              {v.status === "uploaded" ? (
                <PastAttempts videoId={id} currentRunId={v.current_run?.run_id ?? null} />
              ) : null}
              {v.status === "ready"
                ? renderShare?.({
                    videoId: id,
                    status: v.status,
                    title: v.title,
                    playbackUrl: v.playback_url,
                    originalUrl: v.original_url,
                  })
                : null}
            </>
          )}
        </section>

        {v?.status === "uploaded" ? (
          <aside className="flex min-w-0 flex-[1_1_380px] flex-col gap-6 rounded-3xl border border-line bg-surface p-7">
            <div className="flex flex-col gap-1.5">
              <h2 className="m-0 text-[28px] font-semibold">Clean this video</h2>
              <p className="m-0 text-sm leading-normal text-muted">
                Pick what the AI may change. You&apos;ll see every change on a timeline before
                anything is final.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <p className="m-0 text-[13px] font-medium uppercase tracking-wide text-muted">
                The AI will
              </p>
              {FIX_OPTION_ROWS.map((option) => (
                <Checkbox
                  key={option.key}
                  name={option.key}
                  label={option.label}
                  hint={option.hint}
                  checked={fixOptions[option.key]}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setFixOptions((current) => ({
                      ...current,
                      [option.key]: checked,
                    }));
                  }}
                />
              ))}
            </div>

            <div className="flex flex-col gap-2">
              <p className="m-0 text-[13px] font-medium uppercase tracking-wide text-muted">
                Narration
              </p>
              <SegmentedControl
                name="voice"
                legend="Narration"
                value={voice}
                onChange={(value) => setVoice(value as Voice)}
                options={[
                  { value: "original", label: "Keep my voice" },
                  { value: "ai", label: "AI voice" },
                ]}
              />
              <p className="m-0 text-[13px] leading-normal text-muted">{NARRATION[voice]}</p>
              {voice === "ai" ? (
                voiceList.isPending || !voiceList.data ? (
                  <p role="status" className="m-0 text-[13px] text-muted">
                    Loading voice options…
                  </p>
                ) : voiceList.isError ? (
                  <p role="alert" className="m-0 text-[13px] text-danger">
                    Voice options could not be loaded.
                  </p>
                ) : (
                  <RadioGroup
                    name="voice-id"
                    legend="Choose an AI voice"
                    value={selectedVoiceId}
                    onChange={setVoiceId}
                    options={voices.map((voiceOption) => ({
                      value: voiceOption.id,
                      label: voiceOption.label,
                      hint: voiceOption.hint,
                      action: (
                        <Button
                          variant="secondary"
                          aria-label={
                            playingSampleId === voiceOption.id
                              ? `Stop sample of ${voiceOption.label}`
                              : `Play a sample of ${voiceOption.label}`
                          }
                          onClick={() => toggleSample(voiceOption.id)}
                        >
                          {playingSampleId === voiceOption.id ? "Stop" : "Play sample"}
                        </Button>
                      ),
                    }))}
                  />
                )
              ) : null}
            </div>

            <Switch
              label="Show me before it renders"
              hint={
                mode === "review"
                  ? "You get the editor with every change marked. Nothing renders until you say so."
                  : "Renders straight away. If the AI is unsure about something, it stops and asks you first."
              }
              checked={mode === "review"}
              onChange={(event) => setMode(event.currentTarget.checked ? "review" : "auto")}
            />

            {start.isError ? (
              <p role="alert" className="m-0 text-sm text-danger">
                Could not start processing. Try again.
              </p>
            ) : null}
            <audio
              ref={audioRef}
              aria-hidden="true"
              preload="none"
              className="hidden"
              onEnded={() => setPlayingSampleId(null)}
              onError={() => setPlayingSampleId(null)}
            />
            <Button
              onClick={submit}
              disabled={
                start.isPending ||
                (voice === "ai" && (!voiceList.data || voices.length === 0 || !selectedVoiceId))
              }
              className="h-12 text-[15px]"
            >
              <Sparkle size={18} aria-hidden="true" />
              {start.isPending ? "Starting…" : "Clean this video"}
            </Button>
          </aside>
        ) : null}
      </main>
    </div>
  );
}
