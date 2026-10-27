"use client";

import { RawShareCard } from "@/features/shares/raw-share-card";
import { DoneScreen } from "@/features/shares/done-screen";
import { VideoScreen } from "@/features/videos/video-screen";
import { $api } from "@/api/client";

export function VideoWithShare({ id, clean }: { id: string; clean: boolean }) {
  const video = $api.useQuery("get", "/videos/{video_id}", {
    params: { path: { video_id: id } },
  });

  if (video.data?.status === "ready" && !clean) {
    return <DoneScreen video={video.data} onRefreshVideo={() => void video.refetch()} />;
  }

  return (
    <VideoScreen
      id={id}
      forceClean={clean && video.data?.status === "ready"}
      renderShare={({ videoId, status, originalUrl }) => (
        <RawShareCard videoId={videoId} status={status} originalUrl={originalUrl} />
      )}
    />
  );
}
