"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { $api } from "@/api/client";
import { openRunEvents } from "@/api/events";
import type { components } from "@/api/generated/schema";
import { applyRunEvent, isTerminal } from "./run-progress";

type Run = components["schemas"]["Run"];
type Progress = components["schemas"]["RunProgressEvent"];

/** Seeds from GET /runs/{id}, then folds SSE events into that same query's cache. */
export function useRunEvents(runId: string) {
  const queryClient = useQueryClient();
  const run = $api.useQuery("get", "/runs/{run_id}", { params: { path: { run_id: runId } } });
  const [latestProgress, setLatestProgress] = useState<{ runId: string; data: Progress } | null>(
    null,
  );
  // Bumped to reopen a stream the browser gave up on; capped so an expired session cannot loop forever.
  const [reopen, setReopen] = useState(0);

  const status = run.data?.status;
  const live = status !== undefined && !isTerminal(status);
  const progress = latestProgress?.runId === runId ? latestProgress.data : null;

  useEffect(() => {
    if (!live) return;
    const queryKey = $api.queryOptions("get", "/runs/{run_id}", {
      params: { path: { run_id: runId } },
    }).queryKey;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = openRunEvents(runId, {
      onEvent: (event) => {
        if (event.type === "run.progress") setLatestProgress({ runId, data: event.data });
        queryClient.setQueryData(queryKey, (old: Run | undefined) =>
          old ? applyRunEvent(old, event) : old,
        );
      },
      // Missed events are possible while disconnected; the REST snapshot is the truth.
      onError: (closed) => {
        void queryClient.invalidateQueries({ queryKey });
        if (closed && reopen < 5) timer = setTimeout(() => setReopen((n) => n + 1), 3000);
      },
    });
    return () => {
      clearTimeout(timer);
      close();
      // A terminal run.status can end `live` before run.failed (with its message) arrives; re-read the run.
      void queryClient.invalidateQueries({ queryKey });
    };
  }, [live, runId, queryClient, reopen]);

  return { run, live, progress };
}
