"use client";

import { $api } from "@/api/client";
import { ShareCard } from "./share-card";

export function SharePanel({
  videoId,
  playbackUrl,
}: {
  videoId: string;
  playbackUrl?: string | null;
}) {
  const create = $api.useMutation("post", "/videos/{video_id}/shares");

  return (
    <aside
      data-slot="share-panel"
      className="flex min-w-0 flex-[1_1_360px] flex-col gap-5 rounded-3xl border border-line bg-surface p-8"
    >
      <h2 className="m-0 text-3xl font-semibold">Share</h2>
      <ShareCard
        title="Cleaned video"
        url={create.data?.url ?? null}
        onCreate={() =>
          create.mutate({
            params: { path: { video_id: videoId } },
            body: { kind: "cleaned", visibility: "link", expires_at: null },
          })
        }
        creating={create.isPending}
        downloadUrl={playbackUrl}
        downloadLabel="Download MP4"
        selected={false}
      />
      {create.isError ? (
        <p role="alert" className="m-0 text-sm text-danger">
          Could not create the link. Try again.
        </p>
      ) : null}
    </aside>
  );
}
