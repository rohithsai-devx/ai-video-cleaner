"use client";

import Link from "next/link";
import { $api } from "@/api/client";
import type { components } from "@/api/generated/schema";
import { Badge } from "@/ui/badge";

type RunListItem = components["schemas"]["RunListItem"];
type StatusPresentation = {
  label: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  action: { label: string; href?: string };
};

function statusPresentation(
  run: RunListItem,
  videoId: string,
  currentRunId: string | null,
): StatusPresentation {
  switch (run.status) {
    case "awaiting_review":
      return {
        label: "Waiting for you",
        tone: "warning",
        action: { label: "Open editor", href: `/runs/${run.run_id}/review` },
      };
    case "queued":
    case "preprocessing":
    case "agent_running":
    case "approved":
    case "postprocessing":
      return {
        label: "In progress",
        tone: "accent",
        action: { label: "See progress", href: `/runs/${run.run_id}` },
      };
    case "done":
      return run.run_id === currentRunId
        ? { label: "Done", tone: "success", action: { label: "Watch", href: `/videos/${videoId}` } }
        : {
            label: "Done",
            tone: "success",
            action: { label: "Replaced by a newer version" },
          };
    case "failed":
      return {
        label: "Failed",
        tone: "danger",
        action: { label: "See what happened", href: `/runs/${run.run_id}` },
      };
    case "cancelled":
      return {
        label: "Stopped",
        tone: "neutral",
        action: { label: "No video made" },
      };
  }
}

export function formatRunCreatedAt(createdAt: string, now = new Date()): string {
  const date = new Date(createdAt);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const createdDay = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round((today - createdDay) / 86_400_000);
  const dayLabel =
    dayDifference === 0
      ? "Today"
      : dayDifference === 1
        ? "Yesterday"
        : new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
          }).format(date);
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    date,
  );
  return `${dayLabel}, ${time}`;
}

export function PastAttempts({
  videoId,
  currentRunId,
}: {
  videoId: string;
  currentRunId: string | null;
}) {
  const runs = $api.useQuery("get", "/videos/{video_id}/runs", {
    params: { path: { video_id: videoId } },
  });
  const attempts = runs.data ?? [];
  if (runs.isPending || runs.isError || attempts.length === 0) return null;

  return (
    <section
      aria-labelledby="past-attempts-heading"
      className="rounded-2xl border border-line bg-surface p-5"
    >
      <h2 id="past-attempts-heading" className="m-0 text-base font-semibold">
        Past attempts
      </h2>
      <ul className="m-0 list-none p-0">
        {attempts.map((run) => {
          const presentation = statusPresentation(run, videoId, currentRunId);
          const voice = run.voice === "original" ? "My voice" : "AI voice";
          return (
            <li
              key={run.run_id}
              className="flex flex-wrap items-center gap-2.5 border-t border-line py-3 first:mt-3"
            >
              <Badge tone={presentation.tone}>{presentation.label}</Badge>
              <p className="m-0 min-w-0 flex-1 text-sm text-muted">
                {formatRunCreatedAt(run.created_at)} · {voice}
                {run.status === "awaiting_review" && run.needs_you > 0 ? (
                  <span> · {run.needs_you} to check</span>
                ) : null}
              </p>
              {presentation.action.href ? (
                <Link
                  href={presentation.action.href}
                  className="min-h-11 content-center text-sm font-medium text-link no-underline hover:underline"
                >
                  {presentation.action.label}
                </Link>
              ) : (
                <span className="text-sm text-muted">{presentation.action.label}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
