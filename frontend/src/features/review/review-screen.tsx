"use client";

import { CaretLeft, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { $api, fetchClient } from "@/api/client";
import { formatClock } from "@/lib/clock";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Skeleton } from "@/ui/skeleton";
import { Tabs, type TabsProps } from "@/ui/tabs";
import { MediaPlayer } from "@/ui/media-player";
import { Timeline } from "@/ui/timeline";
import {
  conflictCode,
  emptyDraft,
  effectiveEntries,
  failedProposalChecks,
  failingChecks,
  flaggedRefIds,
  isDirty,
  isReviewable,
  outputLength,
  toUpdate,
  type Draft,
  type ProposalDoc,
} from "./review-model";
import { ScriptPanel } from "./script-panel";

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
  const voices = $api.useQuery("get", "/voices", {}, { enabled: run.data?.voice === "ai" });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [notice, setNotice] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState("needs-you");
  const [playhead, setPlayhead] = useState(0);
  const [seekTo, setSeekTo] = useState<number>();

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
  const dirty = proposal ? isDirty(proposal, draft) : false;
  const entries = proposal ? effectiveEntries(proposal, draft) : [];
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
      ? `AI voice (${voices.data?.voices.find((voice) => voice.id === run.data?.voice_id)?.label ?? "AI voice"})`
      : "my voice";
  const tabs: TabsProps = {
    label: "Review sections",
    tabs: [
      { id: "needs-you", label: "Needs you" },
      { id: "done-by-ai", label: "Done by AI" },
      { id: "script", label: "Script" },
    ],
    value: activeTab,
    onChange: setActiveTab,
    children: {
      "needs-you": <Skeleton className="h-32 w-full" />,
      "done-by-ai": <Skeleton className="h-32 w-full" />,
      script: (
        <ScriptPanel
          blocks={proposal?.script.blocks ?? []}
          draftTexts={draft.texts}
          flaggedIds={flaggedIds}
          editable={editable}
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
      setNotice(`Saved as version ${r.data.proposal.version}.`);
    } else if (r?.status === 409 && conflictCode(r.error?.detail) === "version_conflict") {
      setDraft(emptyDraft);
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
        {proposal && (
          <span className="font-mono text-sm tabular-nums text-ink-2">
            {formatClock(duration)} → {formatClock(outputDuration)}
          </span>
        )}
        <Badge tone="success">All decided</Badge>
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
                mode="cleaned-preview"
                badge={`Cleaned · ${run.data?.voice === "ai" ? "AI voice" : "my voice"}`}
                onTime={setPlayhead}
                seekTo={seekTo}
              />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-player text-sm text-white">
                Preview not available yet
              </div>
            )}
          </section>

          <section className="min-w-0 rounded-2xl border border-line bg-surface p-4 lg:col-start-1 lg:row-start-1">
            <Tabs {...tabs} />
          </section>

          <section className="lg:col-span-2">
            <Timeline
              duration={duration}
              playhead={playhead}
              tracks={[]}
              onSeek={setSeekTo}
              onSelect={() => undefined}
            />
          </section>
        </main>
      )}
    </div>
  );
}
