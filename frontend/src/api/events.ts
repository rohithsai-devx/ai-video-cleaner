import type { components } from "./generated/schema";

type Schemas = components["schemas"];

export type RunEvent =
  | { type: "run.status"; data: Schemas["RunStatusEvent"] }
  | { type: "run.proposal_ready"; data: Schemas["RunProposalReadyEvent"] }
  | { type: "run.done"; data: Schemas["RunDoneEvent"] }
  | { type: "run.failed"; data: Schemas["RunFailedEvent"] };

const NAMES: RunEvent["type"][] = ["run.status", "run.proposal_ready", "run.done", "run.failed"];

type Handlers = {
  onEvent: (event: RunEvent) => void;
  /**
   * The connection dropped. With `closed` false, EventSource reconnects by itself; with `closed` true
   * (a non-2xx reconnect, e.g. 401 or 404) it has given up and the caller must reopen or show stale state.
   */
  onError: (closed: boolean) => void;
};

/** Opens the run's SSE stream through the same-origin /api proxy. Returns a function that closes it. */
export function openRunEvents(runId: string, { onEvent, onError }: Handlers): () => void {
  const source = new EventSource(`/api/runs/${runId}/events`);
  let open = true;
  const close = () => {
    open = false;
    source.close();
  };

  for (const type of NAMES) {
    source.addEventListener(type, (message) => {
      if (!open) return;
      let data: unknown;
      try {
        data = JSON.parse((message as MessageEvent<string>).data);
      } catch {
        return;
      }
      onEvent({ type, data } as RunEvent);
      const cancelled =
        type === "run.status" && (data as { status?: string }).status === "cancelled";
      if (type === "run.done" || type === "run.failed" || cancelled) close();
    });
  }
  source.onerror = () => {
    if (open) onError(source.readyState === EventSource.CLOSED);
  };
  return close;
}
