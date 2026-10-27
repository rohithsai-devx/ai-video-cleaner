"use client";

import { useQueryClient } from "@tanstack/react-query";
import { $api } from "@/api/client";
import type { components } from "@/api/generated/schema";
import { ShareCard } from "./share-card";

const RAW_SHARE_COPY =
  "No AI, no waiting. The link plays this recording with your own voice, uncut. You can still clean it later; this link keeps showing the original.";

type VideoStatus = components["schemas"]["Video"]["status"];

export function RawShareCard({
  videoId,
  status,
  title,
  originalUrl,
}: {
  videoId: string;
  status: VideoStatus;
  title: string;
  originalUrl?: string | null;
}) {
  const params = { params: { path: { video_id: videoId } } } as const;
  const shares = $api.useQuery("get", "/videos/{video_id}/shares", params, {
    enabled: originalUrl != null && isRawShareStatus(status),
  });
  const create = $api.useMutation("post", "/videos/{video_id}/shares");
  const queryClient = useQueryClient();
  const queryKey = $api.queryOptions("get", "/videos/{video_id}/shares", params).queryKey;
  const url = shares.data?.find((share) => share.kind === "raw")?.url ?? null;

  if (!originalUrl || !isRawShareStatus(status)) return null;

  return (
    <div className="flex flex-col gap-2">
      <ShareCard
        title="Share it as is"
        meta={RAW_SHARE_COPY}
        url={url}
        onCreate={() =>
          create.mutate(
            {
              params: { path: { video_id: videoId } },
              body: { kind: "raw", visibility: "link", expires_at: null },
            },
            {
              onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey });
              },
            },
          )
        }
        creating={create.isPending}
        downloadLabel="Download original"
        selected={false}
      />
      {shares.isError || create.isError ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {create.isError ? "Could not create the link. Try again." : "Could not load share links."}
        </p>
      ) : null}
    </div>
  );
}

function isRawShareStatus(status: VideoStatus): boolean {
  return ["uploaded", "processing", "awaiting_review", "rendering", "failed"].includes(status);
}
