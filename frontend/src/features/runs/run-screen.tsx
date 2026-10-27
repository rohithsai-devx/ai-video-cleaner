"use client";

import { CaretLeft } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { $api, fetchClient } from "@/api/client";
import { Banner } from "@/ui/banner";
import { Button } from "@/ui/button";
import { ConfirmDialog } from "@/ui/confirm-dialog";
import { Skeleton } from "@/ui/skeleton";
import { Stepper } from "@/ui/stepper";
import { buildSteps, isTerminal, runChoicesLabel, runHeader } from "./run-progress";
import { useRunEvents } from "./use-run-events";

export function RunScreen({ id }: { id: string }) {
  const router = useRouter();
  const { run: query, live } = useRunEvents(id);
  const run = query.data;
  const video = $api.useQuery(
    "get",
    "/videos/{video_id}",
    { params: { path: { video_id: run?.video_id ?? "" } } },
    { enabled: Boolean(run) },
  );
  const cancel = $api.useMutation("post", "/runs/{run_id}/cancel");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [retryMessage, setRetryMessage] = useState<"conflict" | "generic" | null>(null);
  const retry = useMutation({
    mutationFn: async () => {
      const response = await fetchClient.POST("/runs/{run_id}/retry", {
        params: { path: { run_id: id } },
      });
      return { status: response.response.status, data: response.data };
    },
  });

  const queryClient = useQueryClient();
  const terminal = run ? isTerminal(run.status) : false;
  const videoId = run?.video_id;
  useEffect(() => {
    if (!terminal || !videoId) return;
    void queryClient.invalidateQueries({
      queryKey: $api.queryOptions("get", "/videos/{video_id}", {
        params: { path: { video_id: videoId } },
      }).queryKey,
    });
    void queryClient.invalidateQueries({ queryKey: ["videos", "list"] });
  }, [terminal, videoId, queryClient]);

  useEffect(() => {
    if (run?.status === "done") router.replace(`/videos/${run.video_id}`);
  }, [run, router]);

  const steps = run ? buildSteps(run) : [];
  const header = run ? runHeader(run) : null;
  const ready = run?.status === "awaiting_review";
  const failed = run?.status === "failed";
  const cancelled = run?.status === "cancelled";
  const canStop = Boolean(
    run && live && run.status !== "awaiting_review" && run.status !== "postprocessing",
  );

  async function tryAgain() {
    setRetryMessage(null);
    const result = await retry.mutateAsync().catch(() => null);
    if (result?.status === 409) {
      setRetryMessage("conflict");
    } else if (result?.data) {
      await queryClient.invalidateQueries({
        queryKey: $api.queryOptions("get", "/runs/{run_id}", {
          params: { path: { run_id: id } },
        }).queryKey,
      });
    } else {
      setRetryMessage("generic");
    }
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
        <span className="truncate text-sm font-medium">{video.data?.title ?? ""}</span>
        <span className="text-line-strong">/</span>
        <span className="text-sm text-muted">Cleaning</span>
      </header>

      <main className="mx-auto flex max-w-[1120px] flex-wrap items-start gap-8 px-4 py-8 sm:px-8 sm:py-10">
        <section className="flex min-w-0 flex-[999_1_520px] flex-col gap-7 rounded-3xl border border-line bg-surface p-6 sm:p-8">
          {query.isError ? (
            <p role="alert" className="m-0 text-sm text-danger">
              Could not load this run.
            </p>
          ) : !run || !header ? (
            <>
              <Skeleton className="h-8 w-1/2" />
              <Skeleton className="h-48" />
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                  <h1 className="m-0 text-[32px] font-semibold leading-tight">{header.title}</h1>
                  <p aria-live="polite" className="m-0 text-[15px] text-muted">
                    {header.detail}
                  </p>
                </div>
                <span className="rounded-full bg-sunken px-2.5 py-1 text-[13px] text-ink-2">
                  {runChoicesLabel(run)}
                </span>
              </div>

              <Stepper steps={steps} />

              {ready ? (
                <Banner
                  tone="info"
                  action={
                    <Link
                      href={`/runs/${run.id}/review`}
                      className="inline-flex min-h-11 items-center rounded-xl bg-ink px-5 text-sm font-medium text-white no-underline hover:bg-ink-2"
                    >
                      Open the editor
                    </Link>
                  }
                >
                  Ready for you.
                </Banner>
              ) : null}

              {failed ? (
                <Banner
                  tone="danger"
                  action={
                    run.error?.retryable && retryMessage !== "conflict" ? (
                      <Button
                        variant="danger"
                        disabled={retry.isPending}
                        onClick={() => void tryAgain()}
                      >
                        {retry.isPending ? "Trying again…" : "Try again"}
                      </Button>
                    ) : undefined
                  }
                >
                  {run.error?.message ?? "Something went wrong on our side."} Your recording is
                  safe.
                </Banner>
              ) : null}

              {retryMessage === "conflict" && run ? (
                <p role="alert" className="m-0 text-sm text-danger">
                  This run can&apos;t be retried. Start a new one from the{" "}
                  <Link href={`/videos/${run.video_id}`} className="text-link underline">
                    video page
                  </Link>
                  .
                </p>
              ) : null}
              {retryMessage === "generic" ? (
                <p role="alert" className="m-0 text-sm text-danger">
                  Could not retry this run. Try again.
                </p>
              ) : null}

              {canStop || cancelled ? (
                <div className="flex flex-wrap items-center gap-3">
                  {canStop ? (
                    <Button
                      variant="secondary"
                      disabled={cancel.isPending}
                      onClick={() => setConfirmCancel(true)}
                    >
                      Stop cleaning
                    </Button>
                  ) : null}
                  {cancelled ? (
                    <Link
                      href={`/videos/${run.video_id}`}
                      className="inline-flex min-h-11 items-center rounded-xl bg-ink px-5 text-sm font-medium text-white no-underline hover:bg-ink-2"
                    >
                      Clean again
                    </Link>
                  ) : null}
                </div>
              ) : null}

              {canStop ? (
                <p className="m-0 text-[13px] leading-normal text-muted">
                  You can close this tab. We&apos;ll keep going and the library shows progress.
                </p>
              ) : null}

              <ConfirmDialog
                open={confirmCancel}
                title="Stop cleaning?"
                description="The recording stays as it is."
                confirmLabel="Stop cleaning"
                cancelLabel="Keep going"
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
                  Could not stop cleaning. Try again.
                </p>
              ) : null}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
