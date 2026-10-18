"use client";

import { CaretLeft, Check, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { $api } from "@/api/client";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { cx } from "@/ui/cx";
import { Skeleton } from "@/ui/skeleton";
import { buildSteps, isTerminal } from "./run-progress";
import { useRunEvents } from "./use-run-events";

export function RunScreen({ id }: { id: string }) {
  const router = useRouter();
  const { run: query, log, live } = useRunEvents(id);
  const run = query.data;
  const video = $api.useQuery(
    "get",
    "/videos/{video_id}",
    { params: { path: { video_id: run?.video_id ?? "" } } },
    { enabled: Boolean(run) },
  );
  const cancel = $api.useMutation("post", "/runs/{run_id}/cancel");
  const [confirmCancel, setConfirmCancel] = useState(false);

  const queryClient = useQueryClient();
  const terminal = run ? ["done", "failed", "cancelled"].includes(run.status) : false;
  const videoId = run?.video_id;
  // A finished run changes its video (status, output, poster); refetch it before anyone shows it.
  useEffect(() => {
    if (!terminal || !videoId) return;
    void queryClient.invalidateQueries({
      queryKey: $api.queryOptions("get", "/videos/{video_id}", {
        params: { path: { video_id: videoId } },
      }).queryKey,
    });
    void queryClient.invalidateQueries({ queryKey: ["videos", "list"] });
  }, [terminal, videoId, queryClient]);

  const finishedAuto = run?.status === "done" && run.mode === "auto";
  useEffect(() => {
    if (finishedAuto && run) router.replace(`/videos/${run.video_id}`);
  }, [finishedAuto, run, router]);

  const steps = run ? buildSteps(run) : [];
  const failed = run?.status === "failed";
  // Only a render-stage failure happens after a saved proposal.
  const rendering = /render|post/i.test(run?.error?.stage ?? "");
  const ready = run?.status === "awaiting_review";
  const stepNo = Math.min(steps.filter((s) => s.state === "done").length + 1, steps.length);

  const headline = !run
    ? "Loading…"
    : failed
      ? "Something went wrong"
      : run.status === "cancelled"
        ? "Run cancelled"
        : run.status === "done"
          ? "Done"
          : ready
            ? "Ready for your review"
            : "Cleaning up your video";
  const sub = !run
    ? ""
    : failed
      ? "One step failed. Nothing is lost."
      : run.status === "cancelled"
        ? "This run was stopped."
        : ready
          ? "The agent finished. Nothing renders until you approve."
          : run.status === "done"
            ? "Your cleaned video is ready."
            : `Step ${stepNo} of ${steps.length}`;

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
        <span className="truncate text-sm font-medium">{video.data?.title ?? ""}</span>
      </header>

      <main className="mx-auto flex max-w-[1120px] flex-wrap items-start gap-8 px-4 py-8 sm:px-8 sm:py-10">
        <section className="flex min-w-0 flex-[999_1_520px] flex-col gap-7 rounded-3xl border border-line bg-surface p-6 sm:p-8">
          {query.isError ? (
            <p role="alert" className="m-0 text-sm text-danger">
              Could not load this run.
            </p>
          ) : !run ? (
            <>
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-48" />
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <h1 aria-live="polite" className="m-0 text-2xl">
                    {headline}
                  </h1>
                  <p className="m-0 text-[15px] text-muted">{sub}</p>
                </div>
                <span className="rounded-full bg-sunken px-2.5 py-1 text-[13px] text-ink-2">
                  {run.mode === "auto" ? "Auto mode" : "Review mode"}
                </span>
              </div>

              <ol className="m-0 flex list-none flex-col p-0">
                {steps.map((s, i) => (
                  <li
                    key={s.label}
                    className="flex gap-4"
                    aria-current={s.state === "active" ? "step" : undefined}
                  >
                    <div className="flex flex-col items-center">
                      <span
                        className={cx(
                          "inline-flex size-6 items-center justify-center rounded-full text-white",
                          s.state === "failed" && "bg-danger",
                          (s.state === "done" || s.state === "active") && "bg-ink",
                          s.state === "todo" && "border-2 border-line-strong bg-surface",
                          s.state === "active" &&
                            !s.waiting &&
                            "animate-pulse motion-reduce:animate-none",
                        )}
                      >
                        {s.state === "done" ? (
                          <Check size={14} weight="bold" aria-hidden="true" />
                        ) : null}
                        {s.state === "failed" ? (
                          <WarningCircle size={14} weight="bold" aria-hidden="true" />
                        ) : null}
                      </span>
                      {i < steps.length - 1 ? (
                        <span
                          className={cx(
                            "min-h-5 w-0.5 flex-1",
                            s.state === "done" ? "bg-ink" : "bg-line",
                          )}
                        />
                      ) : null}
                    </div>
                    <div className="flex flex-col gap-0.5 pb-5">
                      <span
                        className={cx(
                          "text-[15px] font-medium",
                          s.state === "todo" && "text-muted",
                        )}
                      >
                        {s.label}
                        <span className="sr-only">
                          {s.state === "done" ? " (done)" : s.state === "failed" ? " (failed)" : ""}
                        </span>
                      </span>
                      <span className="text-[13px] leading-snug text-muted">{s.detail}</span>
                    </div>
                  </li>
                ))}
              </ol>

              {ready ? (
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl bg-accent px-5 py-4">
                  <div className="text-sm leading-normal">
                    <strong className="font-semibold">Proposal ready.</strong>{" "}
                    {run.flags.length > 0
                      ? `${run.flags.length} ${run.flags.length === 1 ? "flag" : "flags"} for you to check.`
                      : "Nothing was flagged."}
                  </div>
                  <Link
                    href={`/runs/${run.id}/review`}
                    className="inline-flex min-h-11 items-center rounded-xl bg-ink px-5 text-sm font-medium text-white no-underline hover:bg-ink-2"
                  >
                    Open review
                  </Link>
                </div>
              ) : null}

              {failed ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-danger/30 bg-danger-soft px-5 py-4 text-danger"
                >
                  <div className="text-sm leading-normal">
                    <strong className="font-semibold">
                      {rendering ? "Rendering stopped." : "Processing stopped."}
                    </strong>{" "}
                    {run.error?.message ?? "The run failed."}
                    {rendering ? " Your proposal and edits are saved." : ""}
                  </div>
                  {run.error?.retryable ? (
                    <span className="text-sm font-medium">Retry is coming soon</span>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                {live && run.status !== "postprocessing" ? (
                  <Button
                    variant="secondary"
                    disabled={cancel.isPending}
                    onClick={() => setConfirmCancel(true)}
                  >
                    {cancel.isPending ? "Cancelling…" : "Cancel run"}
                  </Button>
                ) : null}
                {run.status === "done" && run.mode === "review" ? (
                  <Link
                    href={`/videos/${run.video_id}`}
                    className="inline-flex min-h-11 items-center rounded-xl bg-ink px-5 text-sm font-medium text-white no-underline hover:bg-ink-2"
                  >
                    View video
                  </Link>
                ) : null}
              </div>
              <ConfirmDialog
                open={confirmCancel}
                title="Cancel this run?"
                description="The agent stops now and nothing is rendered. Your recording stays as it is."
                confirmLabel="Cancel run"
                cancelLabel="Keep running"
                danger
                onCancel={() => setConfirmCancel(false)}
                onConfirm={() => {
                  setConfirmCancel(false);
                  cancel.mutate(
                    { params: { path: { run_id: id } } },
                    { onSettled: () => void query.refetch() },
                  );
                }}
              />
              {cancel.isError ? (
                <p role="alert" className="m-0 text-sm text-danger">
                  Could not cancel this run.
                </p>
              ) : null}
            </>
          )}
        </section>

        <aside className="flex min-w-0 flex-[1_1_340px] flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="m-0 text-[15px] font-semibold">Activity</h2>
            {run && !isTerminal(run.status) ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-success">
                <span className="size-[7px] animate-pulse rounded-full bg-success motion-reduce:animate-none" />
                Live
              </span>
            ) : null}
          </div>
          <div
            role="log"
            aria-label="Run activity"
            className="flex flex-col gap-0.5 rounded-2xl bg-ink px-[18px] py-4 font-mono text-[12.5px] leading-[1.7] text-[#E5E5E5]"
          >
            {log.length === 0 ? <span className="text-[#8A8A8A]">Waiting for events</span> : null}
            {log.map((l, i) => (
              <div key={i} className="flex gap-3">
                <span className="flex-none text-[#8A8A8A]">{l.t}</span>
                <span>{l.msg}</span>
              </div>
            ))}
          </div>
          <p className="m-0 text-[13px] leading-normal text-muted">
            You can close this tab. The run keeps going, and the library shows where it is.
          </p>
        </aside>
      </main>
    </div>
  );
}
