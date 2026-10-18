import type { components } from "@/api/generated/schema";

type Video = components["schemas"]["Video"];
type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export type StatusBadge = { label: string; tone: Tone };

export function statusBadge(video: Pick<Video, "status">): StatusBadge {
  switch (video.status) {
    case "uploading":
      return { label: "Uploading", tone: "neutral" };
    case "uploaded":
      return { label: "Uploaded", tone: "neutral" };
    case "processing":
      return { label: "Processing", tone: "accent" };
    case "awaiting_review":
      return { label: "Needs review", tone: "warning" };
    case "rendering":
      return { label: "Rendering", tone: "accent" };
    case "ready":
      return { label: "Ready", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "danger" };
  }
}

export function statusHint(video: Pick<Video, "status">): string {
  switch (video.status) {
    case "uploading":
      return "Still uploading";
    case "uploaded":
      return "Not processed yet";
    case "processing":
      return "Agent writing the script";
    case "awaiting_review":
      return "Waiting for your review";
    case "rendering":
      return "Rendering the video";
    case "ready":
      return "Ready to share";
    case "failed":
      return "Something went wrong";
  }
}

/** Where a library card leads: the run screen while a run is live, the video page otherwise. */
export function videoHref(video: Pick<Video, "id" | "status" | "current_run">): string {
  const run = video.current_run;
  switch (video.status) {
    case "processing":
    case "awaiting_review":
    case "rendering":
      return run ? `/runs/${run.run_id}` : `/videos/${video.id}`;
    case "failed":
      return run ? `/runs/${run.run_id}` : `/videos/${video.id}`;
    default:
      return `/videos/${video.id}`;
  }
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
