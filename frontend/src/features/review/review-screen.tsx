"use client";

import { CaretLeft, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { $api, fetchClient } from "@/api/client";
import type { components } from "@/api/generated/schema";
import { fetchWaveformPeaks } from "@/api/waveform";
import { formatClock } from "@/lib/clock";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Skeleton } from "@/ui/skeleton";
import { Tabs, type TabsProps } from "@/ui/tabs";
import { MediaPlayer } from "@/ui/media-player";
import { Timeline } from "@/ui/timeline";
import { SegmentedControl } from "@/ui/segmented-control";
import { DoneByAiPanel } from "./done-by-ai-panel";
import {
  conflictCode,
  applyFixToDraft,
  emptyDraft,
  effectiveEntries,
  effectiveTexts,
  failedProposalChecks,
  failingChecks,
  flaggedRefIds,
  isDirty,
  isReviewable,
  outputLength,
  toUpdate,
  withoutFixesOn,
  type Draft,
  type ProposalDoc,
} from "./review-model";
import { ScriptPanel } from "./script-panel";
import { initialUndoState, undoReducer } from "./undo-model";
import { buildReviewTracks, playerSegmentsFromEntries } from "./review-track-model";
import { NeedsYouPanel } from "./needs-you-panel";
import { getPlaybackContext, usePlaybackFollow, type FollowTarget } from "./use-playback-follow";

type ProposalChange = components["schemas"]["Change"];

/** "AI voice (Coral)", or plain "AI voice" until the voice list loads. */
function voiceLabel(name: string | undefined): string {
  return name ? `AI voice (${name})` : "AI voice";
}

export function ReviewScreen({ id }: { id: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = { params: { path: { run_id: id } } };
  const view = $api.useQuery("get", "/runs/{run_id}/proposal", params);
  const run = $api.useQuery("get", "/runs/{run_id}", params);
  const video = $api.useQuery(
    "get",
    "/videos/{video_id}",
    { params: { path: { video_id: run.data?.video_id ?? "" } } },
    { enabled: Boolean(run.data) },
  );
  const waveform = useQuery({
    queryKey: ["review-waveform", id],
    queryFn: ({ signal }) => {
      const url = view.data?.waveform_url;
      if (!url) throw new Error("Waveform URL is unavailable");
      return fetchWaveformPeaks(url, signal);
    },
    enabled: Boolean(view.data?.waveform_url),
    staleTime: Infinity,
    retry: false,
  });
  const voices = $api.useQuery("get", "/voices", {}, { enabled: run.data?.voice === "ai" });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [undoState, dispatchUndo] = useReducer(undoReducer, initialUndoState);
  const [notice, setNotice] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState("needs-you");
  const [playhead, setPlayhead] = useState(0);
  const [seekTo, setSeekTo] = useState<{ time: number }>();
  const [playerMode, setPlayerMode] = useState<"cleaned-preview" | "file">("cleaned-preview");
  const [selectedTimelineId, setSelectedTimelineId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  const proposalKey = $api.queryOptions("get", "/runs/{run_id}/proposal", params).queryKey;
  // Plain mutations so the HTTP status is visible (409 and 422 mean different things).
  const save = useMutation({
    mutationFn: async (body: ReturnType<typeof toUpdate>) => {
      const r = await fetchClient.PUT("/runs/{run_id}/proposal", { ...params, body });
      return {
        status: r.response.status,
        data: r.data,
        error: r.error as { detail?: unknown } | undefined,
      };
    },
  });
  const approve = useMutation({
    mutationFn: async (base_version: number) => {
      const r = await fetchClient.POST("/runs/{run_id}/approve", {
        ...params,
        body: { base_version },
      });
      return { status: r.response.status, error: r.error as { detail?: unknown } | undefined };
    },
  });

  // The generated response type loosens tuples to number[]; the shapes are identical.
  const proposal = view.data?.proposal as ProposalDoc | undefined;
  const changes = (view.data?.changes ?? []) as unknown as ProposalChange[];
  const dirty = proposal ? isDirty(proposal, draft) : false;
  const entries = proposal ? effectiveEntries(proposal, draft) : [];
  const texts = proposal ? effectiveTexts(proposal, draft) : {};
  const outputDuration = proposal ? outputLength(entries) : 0;
  const duration = video.data?.duration_s ?? outputDuration;
  const flagged = proposal ? failedProposalChecks(proposal) : [];
  const flaggedIds = flaggedRefIds(flagged);
  const playerSrc = video.data?.original_url ?? null;
  const runKey = $api.queryOptions("get", "/runs/{run_id}", params).queryKey;
  // Edits and approval only while the run awaits review; otherwise the screen is read-only.
  const editable = isReviewable(run.data?.status);
  const NEWER_VERSION =
    "Someone else saved a newer version. Your edits were dropped and the latest version is loaded.";
  const narration =
    run.data?.voice === "ai"
      ? voiceLabel(voices.data?.voices.find((voice) => voice.id === run.data?.voice_id)?.label)
      : "my voice";
  const chapters = (view.data?.chapters ?? []) as unknown as components["schemas"]["Chapter"][];
  const spots = useMemo(
    () => (view.data?.spots ?? []) as unknown as components["schemas"]["Spot"][],
    [view.data?.spots],
  );
  const scriptLines = useMemo(
    () => (view.data?.script_lines ?? []) as unknown as components["schemas"]["ScriptLine"][],
    [view.data?.script_lines],
  );
  const segments = playerSegmentsFromEntries(entries, changes);
  const tracks = buildReviewTracks({
    duration,
    voice: run.data?.voice ?? "original",
    entries,
    changes,
    spots,
    chapters,
    keyframes: view.data?.keyframes ?? [],
    scriptLines,
    waveform: waveform.data ?? null,
  });
  const openSpotCount = spots.filter(
    (spot) => !spot.chosen_fix_id && !draft.chosenFixes?.[spot.spot_id],
  ).length;
  const followTargets: FollowTarget[] = [
    ...spots.map((spot) => ({
      id: `spot-${spot.spot_id}`,
      tab: "needs-you" as const,
      start: spot.span[0],
      end: spot.span[1],
      open: !spot.chosen_fix_id && !draft.chosenFixes?.[spot.spot_id],
    })),
    ...changes.map((change) => ({
      id: `change-${change.change_id}`,
      tab: "done-by-ai" as const,
      start: change.span[0],
      end: change.span[1],
    })),
    ...scriptLines.map((line) => ({
      id: `script-${line.block_id}`,
      tab: "script" as const,
      start: line.start,
      end: line.end,
    })),
  ];
  const activeFollowId = usePlaybackFollow({
    playhead,
    activeTab,
    targets: followTargets,
    panelRef,
  });
  const playbackContext = getPlaybackContext(playhead, chapters, followTargets, segments);
  const scriptStartTimes = Object.fromEntries(
    scriptLines.map((line) => [line.block_id, line.start]),
  );
  const selectedItem = tracks
    .flatMap((track) => track.items)
    .find((item) => item.id === selectedTimelineId);
  const selectedId =
    activeFollowId ??
    (selectedItem && playhead >= selectedItem.start && playhead < selectedItem.end
      ? selectedItem.id
      : null);

  const handlePlayerTime = useCallback(
    (time: number) => {
      setPlayhead(time);
      const openSpot = spots.find(
        (spot) =>
          !spot.chosen_fix_id &&
          !draft.chosenFixes?.[spot.spot_id] &&
          time >= spot.span[0] &&
          time < spot.span[1],
      );
      if (openSpot) setActiveTab("needs-you");
    },
    [draft.chosenFixes, spots],
  );
  const selectAndSeek = (id: string, time: number, tab?: string) => {
    if (tab) setActiveTab(tab);
    setSelectedTimelineId(id);
    setPlayhead(time);
    setSeekTo({ time });
  };
  const selectTimelineItem = (id: string) => {
    const target = followTargets.find((item) => item.id === id);
    if (target) setActiveTab(target.tab);
    setSelectedTimelineId(id);
  };
  const chooseFix = (spot: components["schemas"]["Spot"], fix: components["schemas"]["Fix"]) => {
    if (!proposal) return;
    if (fix.patch.entry) {
      dispatchUndo({ type: "forget", changeId: fix.patch.entry.seg_id });
    }
    setDraft((current) => applyFixToDraft(current, proposal, spot, fix));
  };
  const setChangeUndone = (change: (typeof changes)[number], type: "undo" | "redo") => {
    if (!proposal) return;
    const current =
      draft.entryOverrides?.[change.change_id] ??
      proposal.edit_plan.entries.find((entry) => entry.seg_id === change.change_id);
    if (!current) return;
    const action =
      type === "undo"
        ? ({ type: "undo", change, current } as const)
        : ({ type: "redo", change, current } as const);
    const next = undoReducer(undoState, action);
    dispatchUndo(action);
    setDraft((value) => ({
      ...withoutFixesOn(value, proposal, change.change_id),
      entryOverrides: next.entries,
    }));
  };
  const tabs: TabsProps = {
    label: "Review sections",
    tabs: [
      { id: "needs-you", label: "Needs you", count: openSpotCount },
      { id: "done-by-ai", label: "Done by AI", count: changes.length },
      { id: "script", label: "Script" },
    ],
    value: activeTab,
    onChange: setActiveTab,
    children: {
      "needs-you": (
        <NeedsYouPanel
          spots={spots}
          chapters={chapters}
          chosenFixes={draft.chosenFixes ?? {}}
          editable={editable}
          playhead={playhead}
          onChooseFix={chooseFix}
          activeId={activeFollowId}
          onSelect={(spotId, start) => selectAndSeek(`spot-${spotId}`, start, "needs-you")}
        />
      ),
      "done-by-ai": (
        <DoneByAiPanel
          changes={changes}
          entries={entries}
          editable={editable}
          onUndo={(change) => setChangeUndone(change, "undo")}
          onRedo={(change) => setChangeUndone(change, "redo")}
          activeId={activeFollowId}
          onSelect={(changeId, start) => selectAndSeek(`change-${changeId}`, start, "done-by-ai")}
        />
      ),
      script: (
        <ScriptPanel
          blocks={proposal?.script.blocks ?? []}
          draftTexts={texts}
          flaggedIds={flaggedIds}
          editable={editable}
          activeId={activeFollowId}
          startTimes={scriptStartTimes}
          onSelect={(blockId, start) => selectAndSeek(`script-${blockId}`, start, "script")}
          onTextChange={(blockId, text) =>
            setDraft((current) => ({
              ...current,
              texts: { ...current.texts, [blockId]: text },
            }))
          }
        />
      ),
    },
  };

  async function onSave() {
    if (!proposal) return;
    setNotice(null);
    setFailures([]);
    const r = await save.mutateAsync(toUpdate(proposal, draft)).catch(() => null);
    if (r?.data) {
      queryClient.setQueryData(proposalKey, r.data as unknown as typeof view.data);
      setDraft(emptyDraft);
      dispatchUndo({ type: "reset" });
      setNotice(`Saved as version ${r.data.proposal.version}.`);
    } else if (r?.status === 409 && conflictCode(r.error?.detail) === "version_conflict") {
      setDraft(emptyDraft);
      dispatchUndo({ type: "reset" });
      setNotice(NEWER_VERSION);
      await queryClient.invalidateQueries({ queryKey: proposalKey });
    } else if (r?.status === 409 && conflictCode(r.error?.detail) === "not_awaiting_review") {
      // keep the draft; the refreshed run status makes the screen read-only
      setNotice("This run is no longer waiting for review. Your edits were not saved.");
      await queryClient.invalidateQueries({ queryKey: runKey });
    } else {
      setFailures(r ? failingChecks(r.error?.detail) : ["Could not save. Try again."]);
    }
  }

  async function onApprove() {
    setNotice(null);
    setFailures([]);
    if (!proposal) return;
    const r = await approve.mutateAsync(proposal.version).catch(() => null);
    const code = r?.status === 409 ? conflictCode(r.error?.detail) : null;
    if (r && r.status === 202) router.push(`/runs/${id}`);
    else if (code === "version_conflict") {
      setDraft(emptyDraft);
      dispatchUndo({ type: "reset" });
      setNotice(NEWER_VERSION);
      await queryClient.invalidateQueries({ queryKey: proposalKey });
    } else if (code === "not_awaiting_review") {
      setNotice("This run is no longer waiting for review.");
      router.push(`/runs/${id}`);
    } else setFailures(r ? failingChecks(r.error?.detail) : ["Could not approve. Try again."]);
  }

  const busy = save.isPending || approve.isPending;
  const [confirmApprove, setConfirmApprove] = useState(false);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="flex min-h-16 flex-wrap items-center gap-x-4 gap-y-3 border-b border-line bg-surface px-4 py-3 sm:px-8">
        <Link
          href={`/runs/${id}`}
          className="inline-flex min-h-11 items-center gap-2 text-sm text-muted no-underline hover:text-ink"
        >
          <CaretLeft size={16} aria-hidden="true" />
          Back
        </Link>
        <span aria-hidden="true" className="text-line-strong">
          /
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {video.data?.title ?? "Review"}
        </span>
        {proposal && <span className="text-xs text-muted">Version {proposal.version}</span>}
        <span className="text-sm text-muted">Narration: {narration}</span>
        <SegmentedControl
          name="review-preview"
          legend="Preview version"
          options={[
            { value: "cleaned-preview", label: "Cleaned" },
            { value: "file", label: "Original" },
          ]}
          value={playerMode}
          onChange={(value) => setPlayerMode(value === "file" ? "file" : "cleaned-preview")}
          size="sm"
        />
        {proposal && (
          <span className="font-mono text-sm tabular-nums text-ink-2">
            {formatClock(duration)} → {formatClock(outputDuration)}
          </span>
        )}
        <Badge tone={openSpotCount > 0 ? "warning" : "success"}>
          {openSpotCount === 0
            ? "All decided"
            : openSpotCount === 1
              ? "1 needs you"
              : `${openSpotCount} need you`}
        </Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {editable && (
            <>
              <Button variant="secondary" disabled={!dirty || busy} onClick={onSave}>
                Save edits
              </Button>
              <Button disabled={!proposal || dirty || busy} onClick={() => setConfirmApprove(true)}>
                Render video
              </Button>
            </>
          )}
          <ConfirmDialog
            open={confirmApprove}
            title="Render this version?"
            description="You can still share the original any time."
            confirmLabel="Render video"
            cancelLabel="Keep editing"
            onCancel={() => setConfirmApprove(false)}
            onConfirm={() => {
              setConfirmApprove(false);
              void onApprove();
            }}
          />
        </div>
      </header>

      <div
        aria-live="polite"
        className="mx-auto flex max-w-[1600px] flex-col gap-2 px-3 pt-3 sm:px-6"
      >
        {notice && <p className="m-0 rounded-xl bg-sunken px-4 py-3 text-sm">{notice}</p>}
        {failures.length > 0 && (
          <div className="rounded-xl border border-danger px-4 py-3 text-sm text-danger">
            <p className="m-0 font-medium">This cannot be completed yet. Failing checks:</p>
            <ul className="m-0 mt-1 list-disc pl-5">
              {failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          </div>
        )}
        {run.data && !editable && (
          <p className="m-0 rounded-xl bg-sunken px-4 py-3 text-sm">
            This proposal can no longer be edited.
          </p>
        )}
        {editable && dirty && (
          <p className="m-0 text-sm text-muted">
            You have unsaved edits. Save them before rendering.
          </p>
        )}
      </div>

      {view.isError ? (
        <p role="alert" className="m-4 text-sm text-danger">
          Could not load this proposal.
        </p>
      ) : !proposal ? (
        <Skeleton className="mx-3 mt-3 h-64 w-auto sm:mx-6" />
      ) : (
        <main className="mx-auto grid max-w-[1600px] grid-cols-1 gap-3 px-3 py-3 sm:px-6 lg:grid-cols-[minmax(340px,420px)_minmax(560px,1fr)]">
          {flagged.length > 0 || proposal.flags.length > 0 ? (
            <section
              role="status"
              className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-soft p-4 text-sm lg:col-span-2"
            >
              <WarningCircle size={20} aria-hidden="true" />
              <div>
                <p className="m-0 font-medium">Check the script and cuts before you render.</p>
                {flagged.length > 0 ? (
                  <ul className="m-0 mt-1 list-disc pl-5">
                    {flagged.map((check, index) => (
                      <li key={`${check.name}-${index}`}>
                        {check.message || "Review this change."}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="rounded-2xl border border-line bg-surface p-3 lg:col-start-2 lg:row-start-1 lg:p-4">
            {playerSrc ? (
              <MediaPlayer
                src={playerSrc}
                duration={duration}
                mode={playerMode}
                segments={segments}
                chapters={chapters}
                badge={`${playerMode === "file" ? "Original" : "Cleaned"} · ${run.data?.voice === "ai" ? "AI voice" : "my voice"}`}
                onTime={handlePlayerTime}
                seekTo={seekTo}
              />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-player text-sm text-white">
                Preview not available yet
              </div>
            )}
          </section>

          <section
            ref={panelRef}
            className="min-w-0 rounded-2xl border border-line bg-surface p-4 lg:col-start-1 lg:row-start-1"
          >
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-sunken px-3 py-2 text-sm">
              <span className="font-medium">Now</span>
              <span className="font-mono tabular-nums">{formatClock(playhead)}</span>
              <span aria-hidden="true" className="text-muted">
                ·
              </span>
              <span className="min-w-0 flex-1 truncate">{playbackContext.chapter}</span>
              <Badge tone={playbackContext.state === "Needs you" ? "warning" : "neutral"}>
                {playbackContext.state}
              </Badge>
            </div>
            <Tabs {...tabs} />
          </section>

          <section className="lg:col-span-2">
            <Timeline
              duration={duration}
              playhead={playhead}
              tracks={tracks}
              selectedId={selectedId}
              onSeek={(time) => {
                setPlayhead(time);
                setSeekTo({ time });
              }}
              onSelect={selectTimelineItem}
            />
            <ul className="m-0 mt-3 flex list-none flex-wrap gap-4 p-0 text-xs text-muted">
              <li className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block h-3 w-3 rounded-sm border border-dashed border-line-strong bg-sunken"
                />
                Removed
              </li>
              <li className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-flex h-5 min-w-7 items-center justify-center rounded bg-accent-soft px-1 font-mono text-[10px] text-ink"
                >
                  2×
                </span>
                Sped up
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="inline-block size-3 rounded-sm bg-flag" />
                Needs you
              </li>
              <li className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block size-3 rounded-sm border-2 border-ink"
                />
                Selected
              </li>
            </ul>
            <p className="m-0 mt-3 text-xs text-muted">
              {playerMode === "file"
                ? "Original: plays everything, removed parts are shaded."
                : "Cleaned: playback jumps over removed parts."}{" "}
              Click anything on the timeline to jump there.
            </p>
          </section>
        </main>
      )}
    </div>
  );
}
