import type { components } from "@/api/generated/schema";
import type { Step } from "@/ui/stepper";
import type { RunEvent } from "@/api/events";

type Run = components["schemas"]["Run"];
type Chapter = components["schemas"]["Chapter"];

export function isTerminal(status: Run["status"]): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** Pure reducer over the cached run: the TanStack Query cache is the only copy of run state. */
export function applyRunEvent(run: Run, event: RunEvent): Run {
  switch (event.type) {
    case "run.status":
      return { ...run, status: event.data.status, stage: event.data.stage ?? null };
    case "run.proposal_ready":
      return { ...run, flags: event.data.flags };
    case "run.progress":
      return run;
    case "run.failed":
      return { ...run, status: "failed", error: event.data };
    case "run.done":
      return { ...run, status: "done" };
  }
}

const DONE_DETAILS = [
  "Found what you said and when you said it.",
  "Found the parts of your screen recording.",
  "Chose what to remove, speed up or keep.",
  "Lined every change up on the timeline.",
];

const LABELS = [
  "Listening to your narration",
  "Watching your screen",
  "Planning the cuts",
  "Getting it ready for you",
];

function failureStep(stage: string | null | undefined): number {
  if (stage === "preprocess" || stage === "pre-cpu") return 1;
  if (stage === "agent") return 3;
  if (stage === "render" || stage === "post-io" || stage === "approved") return 4;
  const step = Number(stage);
  return Number.isInteger(step) && step >= 1 && step <= 4 ? step : 1;
}

function cancelledDoneCount(stage: string | null | undefined): number {
  if (stage === "agent") return 2;
  if (stage === "review") return 4;
  if (stage === "approved" || stage === "render" || stage === "post-io") return 3;
  return 0;
}

function stateFor(run: Run, index: number): Step["state"] {
  switch (run.status) {
    case "queued":
    case "preprocessing":
      return index < 2 ? "current" : "next";
    case "agent_running":
      return index < 2 ? "done" : index === 2 ? "current" : "next";
    case "awaiting_review":
    case "done":
      return "done";
    case "approved":
    case "postprocessing":
      return index < 3 ? "done" : "current";
    case "failed": {
      const failedAt = failureStep(run.error?.stage ?? run.stage) - 1;
      return index < failedAt ? "done" : index === failedAt ? "failed" : "next";
    }
    case "cancelled":
      return index < cancelledDoneCount(run.stage) ? "done" : "next";
  }
}

function detailFor(
  index: number,
  state: Step["state"],
  chapters: Chapter[],
  remainingTime?: string | null,
): string {
  if (state === "done") {
    if (index === 1 && chapters.length > 0) {
      const titles = chapters.map((chapter) => chapter.title.toLowerCase()).join(", ");
      return `Found ${chapters.length} chapters: ${titles}.`;
    }
    return DONE_DETAILS[index];
  }
  if (state === "failed") return "This step stopped. Nothing you did caused it.";
  if (state === "next") return "Next";
  const currentDetail =
    index === 2
      ? "Choosing what to remove, speed up or keep"
      : index === 3
        ? "Rendering your video"
        : "Working on it";
  return remainingTime ? `${currentDetail}, ${remainingTime}.` : `${currentDetail}.`;
}

/** Maps API states onto the four plain-language steps shown to the viewer. */
export function buildSteps(
  run: Run,
  chapters: Chapter[] = [],
  remainingTime?: string | null,
): Step[] {
  return LABELS.map((label, index) => {
    const state = stateFor(run, index);
    return { label, detail: detailFor(index, state, chapters, remainingTime), state };
  });
}

export function remainingTimeLabel(
  estimateSeconds: number | null | undefined,
  startedAt: string | null | undefined,
  nowMs: number,
): string | null {
  if (
    estimateSeconds == null ||
    !Number.isFinite(estimateSeconds) ||
    !startedAt ||
    !Number.isFinite(nowMs)
  ) {
    return null;
  }

  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return null;

  const elapsedSeconds = Math.max(0, (nowMs - startMs) / 1000);
  const remainingSeconds = Math.max(0, estimateSeconds - elapsedSeconds);
  if (remainingSeconds < 30) return "almost done";

  const minutes = Math.ceil(remainingSeconds / 60);
  return `about ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
}

export function runHeader(run: Run): { title: string; detail: string } {
  switch (run.status) {
    case "queued":
    case "preprocessing":
      return { title: "Cleaning your video", detail: "Step 1 of 4" };
    case "agent_running":
      return { title: "Cleaning your video", detail: "Step 3 of 4" };
    case "awaiting_review":
      return { title: "Ready for you", detail: "Nothing renders until you approve." };
    case "approved":
    case "postprocessing":
      return { title: "Cleaning your video", detail: "Step 4 of 4" };
    case "done":
      return { title: "Ready for you", detail: "Your video is ready." };
    case "failed":
      return {
        title: "Cleaning stopped",
        detail: `Step ${failureStep(run.error?.stage ?? run.stage)} of 4 didn't finish.`,
      };
    case "cancelled":
      return { title: "Cleaning stopped", detail: "You stopped this run. The recording is safe." };
  }
}

export function runChoicesLabel(run: Run): string {
  const voice = run.voice === "ai" ? "AI voice" : "My voice";
  const mode = run.mode === "review" ? "I review first" : "Renders straight away";
  return `${voice} · ${mode}`;
}
