import type { Metadata } from "next";
import { VideoWithShare } from "./video-with-share";

export const metadata: Metadata = { title: "Video · Stepwise" };

export default async function VideoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ clean?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  return <VideoWithShare id={id} clean={query.clean === "1"} />;
}
