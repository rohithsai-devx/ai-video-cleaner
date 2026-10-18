import type { RunEvent } from "@/api/events";
import type { components } from "@/api/generated/schema";

type Run = components["schemas"]["Run"];
type Status = Run["status"];

export type StepState = "done" | "active" | "failed" | "todo";
export type Step = { label: string; detail: string; state: StepState; waiting: boolean };

export function isTerminal(status: Status): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** Pure reducer over the cached run: the TanStack Query cache is the only copy of run state. */
export function applyRunEvent(run: Run, event: RunEvent): Run {
  switch (event.type) {
    case "run.status":
      return { ...run, status: event.data.status, stage: event.data.stage ?? null };
    case "run.proposal_ready":
      return { ...run, flags: event.data.flags };
    case "run.failed":
      return { ...run, status: "failed", error: event.data };
    case "run.done":
      return { ...run, status: "done" };
  }
}

// Steps: 0 Uploaded, 1 Preparing, 2 Writing the plan, 3 Review, 4 Rendering.
const REVIEW = 3;
const RENDER = 4;

function statusIndex(status: Status): number {
  switch (status) {
    case "queued":
      return 1;
    case "preprocessing":
      return 1;
    case "agent_running":
      return 2;
    case "awaiting_review":
      return REVIEW;
    case "approved":
    case "postprocessing":
      return RENDER;
    case "done":
      return 5;
    default:
      return -1;
  }
}

function stageIndex(stage: string | null | undefined): number {
  if (stage === "preprocess" || stage === "pre-cpu") return 1;
  if (stage === "agent") return 2;
  if (stage === "review") return REVIEW;
  return RENDER;
}

export function buildSteps(run: Run): Step[] {
  const auto = run.mode === "auto";
  const defs: [string, string][] = [
    ["Uploaded", "Your recording is in."],
    ["Preparing", "Transcribing speech and finding scene changes."],
    ["Writing the plan", "The agent writes the script and chooses what to cut."],
    [
      auto ? "Your review (skipped)" : "Your review",
      auto ? "Auto mode, nothing needed a check." : "Check the script and cuts, then approve.",
    ],
    ["Rendering", "Cutting the video and adding the voiceover."],
  ];
  const failed = run.status === "failed";
  const at = failed
    ? stageIndex(run.error?.stage ?? run.stage)
    : run.status === "cancelled"
      ? -1
      : statusIndex(run.status);
  return defs.map(([label, detail], i) => {
    const state: StepState =
      failed && i === at ? "failed" : i < at ? "done" : i === at ? "active" : "todo";
    return {
      label,
      detail: state === "todo" ? "" : detail,
      state,
      waiting: state === "active" && i === REVIEW && run.status === "awaiting_review",
    };
  });
}

export function logLine(event: RunEvent): string {
  switch (event.type) {
    case "run.status":
      return `run.status ${event.data.status}${event.data.stage ? ` / ${event.data.stage}` : ""}`;
    case "run.proposal_ready": {
      const n = event.data.flags.length;
      return `run.proposal_ready v${event.data.version}, ${n} ${n === 1 ? "flag" : "flags"}${event.data.auto_approved ? ", auto-approved" : ""}`;
    }
    case "run.done":
      return "run.done";
    case "run.failed":
      return `run.failed ${event.data.stage}${event.data.retryable ? ", retryable" : ""}`;
  }
}
