"use client";

import { RawShareCard } from "@/features/shares/raw-share-card";
import { VideoScreen } from "@/features/videos/video-screen";

export function VideoWithShare({ id }: { id: string }) {
  return (
    <VideoScreen
      id={id}
      renderShare={({ videoId, status, title, originalUrl }) => (
        <RawShareCard videoId={videoId} status={status} title={title} originalUrl={originalUrl} />
      )}
    />
  );
}
