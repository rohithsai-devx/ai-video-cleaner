import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { components } from "@/api/generated/schema";
import { upstreamFetch } from "@/lib/server/upstream";

type SharePublic = components["schemas"]["SharePublic"];

const loadShare = cache(async (slug: string): Promise<SharePublic | null> => {
  const res = await upstreamFetch(`/s/${encodeURIComponent(slug)}`, {
    headers: { accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`share lookup failed: ${res.status}`);
  return (await res.json()) as SharePublic;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const share = await loadShare(slug);
  if (!share) return { title: "Video not found" };
  return {
    title: share.title,
    openGraph: {
      title: share.title,
      type: "video.other",
      videos: [{ url: share.playback_url }],
      ...(share.poster_url ? { images: [{ url: share.poster_url }] } : {}),
    },
  };
}

export default async function PublicSharePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const share = await loadShare(slug);
  if (!share) notFound();

  return (
    <div className="min-h-screen bg-surface text-ink">
      <header className="flex h-15 items-center justify-between border-b border-line px-4 sm:px-8">
        <span className="text-[15px] font-semibold">Stepwise</span>
        <Link href="/" className="text-sm text-muted no-underline hover:text-ink">
          Record your own
        </Link>
      </header>
      <main className="mx-auto flex max-w-[1240px] flex-col gap-4 px-4 py-8 sm:px-8">
        <video
          controls
          playsInline
          preload="metadata"
          src={share.playback_url}
          poster={share.poster_url ?? undefined}
          className="aspect-video w-full rounded-2xl bg-black"
        />
        <h1 className="m-0 text-2xl font-semibold">{share.title}</h1>
      </main>
    </div>
  );
}
