import type { Metadata } from "next";
import { VideoWithShare } from "./video-with-share";

export const metadata: Metadata = { title: "Video · Stepwise" };

export default async function VideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VideoWithShare id={id} />;
}
