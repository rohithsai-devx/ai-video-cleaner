"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { $api } from "@/api/client";
import { openRunEvents } from "@/api/events";
import type { components } from "@/api/generated/schema";
import { applyRunEvent, isTerminal, logLine } from "./run-progress";

type Run = components["schemas"]["Run"];

export type LogEntry = { t: string; msg: string };

/** Seeds from GET /runs/{id}, then folds SSE events into that same query's cache. */
export function useRunEvents(runId: string) {
  const queryClient = useQueryClient();
  const run = $api.useQuery("get", "/runs/{run_id}", { params: { path: { run_id: runId } } });
  const [log, setLog] = useState<LogEntry[]>([]);
  // Bumped to reopen a stream the browser gave up on; capped so an expired session cannot loop forever.
  const [reopen, setReopen] = useState(0);
  // The server sends a run.status snapshot on every (re)connect; skip repeats in the feed.
  const lastStatus = useRef<string | null>(null);

  const status = run.data?.status;
  const live = status !== undefined && !isTerminal(status);

  useEffect(() => {
    if (!live) return;
    const queryKey = $api.queryOptions("get", "/runs/{run_id}", {
      params: { path: { run_id: runId } },
    }).queryKey;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = openRunEvents(runId, {
      onEvent: (event) => {
        queryClient.setQueryData(queryKey, (old: Run | undefined) =>
          old ? applyRunEvent(old, event) : old,
        );
        const msg = logLine(event);
        if (event.type === "run.status") {
          if (msg === lastStatus.current) return;
          lastStatus.current = msg;
        }
        setLog((l) => [...l, { t: new Date().toLocaleTimeString("en-GB"), msg }]);
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

  return { run, log, live };
}
