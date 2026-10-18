"use client";

import { SharePanel } from "@/features/shares/share-panel";
import { VideoScreen } from "@/features/videos/video-screen";

export function VideoWithShare({ id }: { id: string }) {
  return (
    <VideoScreen
      id={id}
      renderShare={({ videoId, playbackUrl }) => (
        <SharePanel videoId={videoId} playbackUrl={playbackUrl} />
      )}
    />
  );
}
