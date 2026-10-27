"use client";

import Link from "next/link";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { $api } from "@/api/client";
import type { components } from "@/api/generated/schema";
import { formatShorter } from "@/lib/clock";
import { outputLength, segmentsFromChanges, toOutputTime, toSourceTime } from "@/lib/cut-map";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { MediaPlayer } from "@/ui/media-player";
import { SegmentedControl } from "@/ui/segmented-control";
import { ShareCard } from "./share-card";

type Video = components["schemas"]["Video"];
type ShareKind = components["schemas"]["ShareLink"]["kind"];

export function DoneScreen({
  video,
  onRefreshVideo,
}: {
  video: Video;
  onRefreshVideo: () => void;
}) {
  const [version, setVersion] = useState<ShareKind>("cleaned");
  const [sourceTime, setSourceTime] = useState(0);
  const [pendingSeek, setPendingSeek] = useState<{ time: number } | undefined>();
  const queryClient = useQueryClient();

  const runId = video.current_run?.run_id;
  const runParams = { params: { path: { run_id: runId ?? "" } } } as const;
  const run = $api.useQuery("get", "/runs/{run_id}", runParams, { enabled: Boolean(runId) });
  const proposal = $api.useQuery("get", "/runs/{run_id}/proposal", runParams, {
    enabled: Boolean(runId),
  });
  const voices = $api.useQuery("get", "/voices");
  const shareParams = { params: { path: { video_id: video.id } } } as const;
  const shares = $api.useQuery("get", "/videos/{video_id}/shares", shareParams);
  const createCleaned = $api.useMutation("post", "/videos/{video_id}/shares");
  const createRaw = $api.useMutation("post", "/videos/{video_id}/shares");
  const shareQueryKey = $api.queryOptions("get", "/videos/{video_id}/shares", shareParams).queryKey;

  const changes = (proposal.data?.changes ?? []) as unknown as components["schemas"]["Change"][];
  const segments = segmentsFromChanges(changes);
  const originalDuration = video.duration_s ?? 0;
  const cleanedDuration = outputLength(originalDuration, segments);
  const cleanedDurationText = formatDuration(cleanedDuration);
  const originalDurationText = formatDuration(video.duration_s);
  const selectedUrl = version === "cleaned" ? video.playback_url : video.original_url;
  const selectedDuration = version === "cleaned" ? cleanedDuration : originalDuration;
  const selectedChapters = (proposal.data?.chapters ?? []).map((chapter) => ({
    title: chapter.title,
    start: version === "cleaned" ? toOutputTime(chapter.start, segments) : chapter.start,
  }));
  const activeChanges = changes.filter((change) => !change.undone);
  const pauseCount = activeChanges.filter((change) => change.kind === "pause").length;
  const retakeCount = activeChanges.filter((change) => change.kind === "retake").length;
  const speedCount = activeChanges.filter((change) => change.kind === "speed").length;
  const userChoiceCount = (proposal.data?.spots ?? []).filter(
    (spot) => spot.chosen_by === "user",
  ).length;
  const narrator =
    run.data?.voice === "ai"
      ? `Narrated by the AI voice (${voices.data?.voices.find((voice) => voice.id === run.data?.voice_id)?.label ?? "AI voice"}).`
      : "Narrated by your voice.";
  const voiceMeta = run.data?.voice === "ai" ? "AI voice" : "your voice";
  const cleanedBadge = run.data?.voice === "ai" ? "Cleaned · AI voice" : "Cleaned · your voice";
  const shorter = formatShorter(originalDuration, cleanedDuration).replace(/ shorter$/, "");
  const cleanedLink = shares.data?.find((share) => share.kind === "cleaned");
  const rawLink = shares.data?.find((share) => share.kind === "raw");
  const downloadUnavailable = video.download_url == null || video.original_download_url == null;

  function onTime(time: number) {
    setSourceTime(version === "cleaned" ? toSourceTime(time, segments) : time);
    if (pendingSeek !== undefined) setPendingSeek(undefined);
  }

  function selectVersion(next: ShareKind) {
    if (next === version) return;
    setPendingSeek({ time: next === "cleaned" ? toOutputTime(sourceTime, segments) : sourceTime });
    setVersion(next);
  }

  function createShare(kind: ShareKind) {
    const mutation = kind === "cleaned" ? createCleaned : createRaw;
    mutation.mutate(
      {
        params: { path: { video_id: video.id } },
        body: { kind, visibility: "link", expires_at: null },
      },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: shareQueryKey });
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
          Library
        </Link>
        <span className="text-line-strong">/</span>
        <span className="truncate text-sm font-medium">{video.title}</span>
      </header>

      <main className="mx-auto flex max-w-[1280px] flex-wrap items-start gap-8 px-6 py-8">
        <section className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
          <SegmentedControl
            name="done-version"
            legend="Video version"
            size="sm"
            value={version}
            onChange={(value) => selectVersion(value as ShareKind)}
            options={[
              { value: "cleaned", label: joinMeta("Cleaned", cleanedDurationText) },
              { value: "raw", label: joinMeta("Original", originalDurationText) },
            ]}
          />

          {selectedUrl ? (
            <MediaPlayer
              src={selectedUrl}
              duration={selectedDuration}
              mode="file"
              segments={version === "raw" ? segments : []}
              chapters={selectedChapters}
              badge={version === "cleaned" ? cleanedBadge : "Original recording · your voice"}
              onTime={onTime}
              seekTo={pendingSeek}
            />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-3xl bg-player text-sm text-white/70">
              This version is not available yet.
            </div>
          )}

          <p className="m-0 text-sm leading-normal text-muted">
            {version === "cleaned"
              ? "Cleaned version: pauses and retakes are gone, slow parts play faster."
              : "The full recording with your own voice, exactly as recorded."}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <h1 className="m-0 text-[26px] font-semibold">{video.title}</h1>
            <Badge tone="success">Ready</Badge>
          </div>

          <section
            aria-labelledby="what-changed-title"
            className="rounded-2xl border border-line bg-surface p-5"
          >
            <h2 id="what-changed-title" className="m-0 text-base font-semibold">
              What changed
            </h2>
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat value={shorter} label="shorter" />
              <Stat value={String(pauseCount)} label="pauses removed" />
              <Stat value={String(retakeCount)} label="retakes removed" />
              <Stat value={String(speedCount)} label="waits sped up" />
            </div>
          </section>

          {run.data ? (
            <p className="m-0 text-sm text-muted">
              {narrator}
              {userChoiceCount > 0
                ? ` ${userChoiceCount} ${userChoiceCount === 1 ? "spot was" : "spots were"} your call.`
                : ""}
            </p>
          ) : null}
        </section>

        <aside className="flex min-w-0 flex-[1_1_360px] flex-col gap-4 rounded-3xl border border-line bg-surface p-7">
          <div className="flex flex-col gap-1.5">
            <h2 className="m-0 text-[26px] font-semibold">Share</h2>
            <p className="m-0 text-sm text-muted">
              Each version has its own link. Anyone with a link can watch that version.
            </p>
          </div>

          <ShareCard
            title="Cleaned video"
            meta={joinMeta(cleanedDurationText, voiceMeta)}
            url={cleanedLink?.url ?? null}
            onCreate={() => createShare("cleaned")}
            creating={createCleaned.isPending}
            onPlay={() => selectVersion("cleaned")}
            downloadUrl={video.download_url}
            downloadLabel="Download MP4"
            selected={version === "cleaned"}
          />
          {createCleaned.isError ? (
            <p role="alert" className="m-0 text-sm text-danger">
              Could not create the link. Try again.
            </p>
          ) : null}

          {video.original_url ? (
            <ShareCard
              title="Original recording"
              meta={joinMeta(originalDurationText, "your voice, uncut")}
              url={rawLink?.url ?? null}
              onCreate={() => createShare("raw")}
              creating={createRaw.isPending}
              onPlay={() => selectVersion("raw")}
              downloadUrl={video.original_download_url}
              downloadLabel="Download original"
              selected={version === "raw"}
            />
          ) : null}
          {video.original_url && createRaw.isError ? (
            <p role="alert" className="m-0 text-sm text-danger">
              Could not create the link. Try again.
            </p>
          ) : null}
          {shares.isError ? (
            <p role="alert" className="m-0 text-sm text-danger">
              Could not load share links.
            </p>
          ) : null}

          {downloadUnavailable ? (
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted">
              <span>Download unavailable.</span>
              <Button variant="secondary" onClick={onRefreshVideo}>
                Try again
              </Button>
            </div>
          ) : null}

          <Link
            href={`/videos/${video.id}?clean=1`}
            className="border-t border-line pt-4 text-sm font-medium text-ink underline underline-offset-4"
          >
            Clean again with other settings
          </Link>
        </aside>
      </main>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-1">
      <strong className="font-display text-[26px] font-bold leading-none">{value}</strong>
      <span className="text-[13px] text-muted">{label}</span>
    </div>
  );
}

/** Joins label parts with " · ", leaving out an unknown (empty) length. */
function joinMeta(...parts: string[]): string {
  return parts.filter(Boolean).join(" · ");
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const roundedSeconds = Math.max(0, Math.round(seconds));
  return `${Math.floor(roundedSeconds / 60)}:${String(roundedSeconds % 60).padStart(2, "0")}`;
}
