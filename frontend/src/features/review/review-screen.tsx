"use client";

import { CaretLeft, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { $api, fetchClient } from "@/api/client";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { cx } from "@/ui/cx";
import { Skeleton } from "@/ui/skeleton";
import {
  conflictCode,
  isReviewable,
  actionLabel,
  effectiveEntries,
  emptyDraft,
  entryLength,
  failedProposalChecks,
  failingChecks,
  flagHeading,
  flaggedRefIds,
  formatClock,
  isDirty,
  outputLength,
  spanLabel,
  toUpdate,
  type Draft,
  type ProposalDoc,
} from "./review-model";

const BAR: Record<string, string> = {
  keep: "bg-ink",
  speed: "bg-accent-strong",
  freeze: "bg-flag",
  cut: "border border-dashed border-line-strong bg-sunken",
};

const LEGEND: [string, string][] = [
  ["keep", "Keep"],
  ["speed", "Speed up"],
  ["freeze", "Hold"],
  ["cut", "Cut"],
];

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
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [notice, setNotice] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);

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
  const keyframes = view.data?.keyframes ?? [];
  const dirty = proposal ? isDirty(proposal, draft) : false;
  const entries = proposal ? effectiveEntries(proposal, draft) : [];
  const total = entries.reduce((s, e) => s + entryLength(e), 0);
  const flagged = proposal ? failedProposalChecks(proposal) : [];
  const flaggedIds = flaggedRefIds(flagged);
  const playbackUrl = video.data?.playback_url ?? null;
  const runKey = $api.queryOptions("get", "/runs/{run_id}", params).queryKey;
  // Edits and approval only while the run awaits review; otherwise the screen is read-only.
  const editable = isReviewable(run.data?.status);
  const NEWER_VERSION =
    "Someone else saved a newer version. Your edits were dropped and the latest version is loaded.";

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
      <header className="flex min-h-16 flex-wrap items-center gap-4 border-b border-line bg-surface px-4 py-2 sm:px-8">
        <Link
          href={`/runs/${id}`}
          className="inline-flex items-center gap-2 text-sm text-muted no-underline hover:text-ink"
        >
          <CaretLeft size={16} aria-hidden="true" />
          Back
        </Link>
        <span className="text-line-strong">/</span>
        <span className="truncate text-sm font-medium">{video.data?.title ?? ""}</span>
        {proposal && <span className="text-xs text-muted">Version {proposal.version}</span>}
        <div className="ml-auto flex flex-wrap items-center gap-3">
          {proposal && (
            <span className="text-sm text-muted">
              {formatClock(total)} to {formatClock(outputLength(entries))}
            </span>
          )}
          {editable && (
            <>
              <Button variant="secondary" disabled={!dirty || busy} onClick={onSave}>
                Save edits
              </Button>
              <Button disabled={!proposal || dirty || busy} onClick={() => setConfirmApprove(true)}>
                Approve and render
              </Button>
            </>
          )}
          <ConfirmDialog
            open={confirmApprove}
            title="Approve and render?"
            description="The video renders from this version. You cannot edit the script or cuts after this."
            confirmLabel="Approve and render"
            cancelLabel="Keep reviewing"
            onCancel={() => setConfirmApprove(false)}
            onConfirm={() => {
              setConfirmApprove(false);
              void onApprove();
            }}
          />
        </div>
      </header>

      <main className="mx-auto flex max-w-[1120px] flex-col gap-8 px-4 py-8 sm:px-8">
        <div aria-live="polite" className="flex flex-col gap-2">
          {notice && <p className="m-0 rounded-xl bg-sunken px-4 py-3 text-sm">{notice}</p>}
          {failures.length > 0 && (
            <div className="rounded-xl border border-danger px-4 py-3 text-sm text-danger">
              <p className="m-0 font-medium">This cannot be completed yet. Failing checks:</p>
              <ul className="m-0 mt-1 list-disc pl-5">
                {failures.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          {run.data && !editable && (
            <p className="m-0 rounded-xl bg-sunken px-4 py-3 text-sm">
              This run is {run.data.status.replace("_", " ")}, so the proposal is read-only.
            </p>
          )}
          {editable && dirty && (
            <p className="m-0 text-sm text-muted">
              You have unsaved edits. Save them before approving.
            </p>
          )}
        </div>

        {view.isError ? (
          <p role="alert" className="m-0 text-sm text-danger">
            Could not load this proposal.
          </p>
        ) : !proposal ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <>
            {flagged.length > 0 || proposal.flags.length > 0 ? (
              <section
                role="status"
                className="flex gap-3 rounded-2xl border border-warning/30 bg-warning-soft p-4 text-sm"
              >
                <WarningCircle size={20} aria-hidden="true" />
                <div>
                  <p className="m-0 font-medium">
                    {flagHeading(flagged.length || proposal.flags.length)}
                  </p>
                  {flagged.length > 0 ? (
                    <ul className="m-0 mt-1 list-disc pl-5">
                      {flagged.map((c) => (
                        <li key={`${c.name}-${c.ref_id}`}>{c.message || c.name}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="m-0 mt-1">Check the script and cuts before you approve.</p>
                  )}
                </div>
              </section>
            ) : null}

            {keyframes.length > 0 && (
              <section aria-label="Keyframes" className="flex gap-2 overflow-x-auto">
                {keyframes.map((k) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={k.frame_id}
                    src={k.url}
                    alt={`Frame at ${formatClock(k.t)}`}
                    className="h-20 rounded-lg border border-line"
                  />
                ))}
              </section>
            )}

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:items-start">
              <div className="flex min-w-0 flex-col gap-8">
                <section aria-label="Video preview">
                  {playbackUrl ? (
                    <video
                      src={playbackUrl}
                      controls
                      className="aspect-video w-full rounded-2xl bg-ink"
                    />
                  ) : (
                    <div className="flex aspect-video w-full items-center justify-center rounded-2xl bg-ink text-sm text-white">
                      Preview not available yet
                    </div>
                  )}
                </section>

                <section className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-6">
                  <h2 className="m-0 text-lg">Timeline</h2>
                  <div
                    className="flex h-6 gap-px overflow-hidden rounded-md"
                    role="img"
                    aria-label="Timeline of kept, sped up, held and cut parts"
                  >
                    {entries.map((e) => (
                      <div
                        key={e.seg_id}
                        title={`${spanLabel(e)} ${actionLabel(e)}`}
                        style={{ flexGrow: Math.max(entryLength(e), 0.5), flexBasis: 0 }}
                        className={BAR[e.action]}
                      />
                    ))}
                  </div>
                  <ul className="m-0 flex list-none flex-wrap gap-4 p-0 text-xs text-muted">
                    {LEGEND.map(([key, label]) => (
                      <li key={key} className="flex items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className={cx("inline-block h-3 w-3 rounded-sm", BAR[key])}
                        />
                        {label}
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="flex flex-col gap-3">
                  <div className="flex items-baseline justify-between">
                    <h2 className="m-0 text-lg">Cuts and why</h2>
                    <span className="text-sm text-muted">Flip any cut back to keep</span>
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0">
                    {proposal.edit_plan.entries.map((orig) => {
                      const kept = orig.action === "cut" && draft.kept[orig.seg_id];
                      const action = kept ? "keep" : orig.action;
                      const flag = flaggedIds.has(orig.seg_id);
                      return (
                        <li
                          key={orig.seg_id}
                          className={cx(
                            "flex flex-col gap-2 rounded-xl border bg-surface p-4",
                            flag ? "border-warning/40 bg-warning-soft" : "border-line",
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <span className="text-sm tabular-nums">{spanLabel(orig)}</span>
                            <span className="rounded-full bg-sunken px-2 py-0.5 text-xs">
                              {actionLabel({ ...orig, action })}
                            </span>
                            {flag ? <FlaggedTag /> : null}
                            {editable && orig.action === "cut" && (
                              <Button
                                variant="secondary"
                                className="ml-auto aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-white"
                                aria-pressed={Boolean(kept)}
                                aria-label={`Keep instead: ${spanLabel(orig)}`}
                                onClick={() =>
                                  setDraft((d) => ({
                                    ...d,
                                    kept: { ...d.kept, [orig.seg_id]: !d.kept[orig.seg_id] },
                                  }))
                                }
                              >
                                Keep instead
                              </Button>
                            )}
                          </div>
                          <p className="m-0 text-sm leading-normal text-muted">{orig.reasoning}</p>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </div>

              <section className="flex flex-col gap-3">
                <h2 className="m-0 text-lg">Script</h2>
                <ul className="m-0 flex list-none flex-col gap-3 p-0">
                  {proposal.script.blocks.map((b, i) => {
                    const text = draft.texts[b.block_id] ?? b.text;
                    const flag = flaggedIds.has(b.block_id);
                    return (
                      <li
                        key={b.block_id}
                        className={cx(
                          "flex flex-col gap-2 rounded-xl border bg-surface p-4",
                          flag ? "border-warning/40 bg-warning-soft" : "border-line",
                        )}
                      >
                        <label
                          htmlFor={`block-${b.block_id}`}
                          className="flex justify-between text-xs text-muted"
                        >
                          <span className="flex items-center gap-2">
                            Script block {i + 1}
                            {flag ? <FlaggedTag /> : null}
                          </span>
                          <span>
                            {b.est_dur.toFixed(1)} s, target {b.target_min} to {b.target_max} s
                          </span>
                        </label>
                        <textarea
                          id={`block-${b.block_id}`}
                          value={text}
                          rows={3}
                          readOnly={!editable}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              texts: { ...d.texts, [b.block_id]: e.target.value },
                            }))
                          }
                          className="w-full resize-y rounded-lg border border-line-strong bg-surface p-3 text-sm"
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function FlaggedTag() {
  return (
    <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
      Flagged
    </span>
  );
}
