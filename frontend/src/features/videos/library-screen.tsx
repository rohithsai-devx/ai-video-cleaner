"use client";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { $api, fetchClient } from "@/api/client";
import { signOut as endSession } from "@/api/session";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Skeleton } from "@/ui/skeleton";
import { formatDuration, statusBadge, statusHint, videoHref } from "./video-status";

const PAGE_SIZE = 12;

function initials(name: string | null | undefined, email: string | undefined): string {
  const source = (name?.trim() || email || "?").split(/[\s@.]+/).filter(Boolean);
  return source
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

function Mark() {
  return (
    <span className="inline-flex items-center gap-2.5 text-base font-semibold">
      <span className="inline-flex size-[26px] items-center justify-center rounded-[7px] bg-ink">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="2.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 4v16M12 8v8M18 6v12" />
        </svg>
      </span>
      Stepwise
    </span>
  );
}

function TopBar({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = $api.useQuery("get", "/me");
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  const menuWrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const user = me.data?.user;

  useEffect(() => {
    if (!menu) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenu(false);
        trigger.current?.focus();
      }
    }
    function onPointer(e: PointerEvent) {
      if (!menuWrap.current?.contains(e.target as Node)) setMenu(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [menu]);

  async function signOut() {
    await endSession();
    queryClient.clear();
    router.push("/sign-in");
  }

  return (
    <header className="flex min-h-16 flex-wrap items-center gap-4 border-b border-line bg-surface px-4 py-2 sm:px-8">
      <Mark />
      <nav aria-label="Main" className="flex gap-1 text-sm sm:ml-6">
        <Link
          href="/library"
          aria-current="page"
          className="rounded-xl bg-sunken px-3 py-2 font-medium text-ink"
        >
          Library
        </Link>
      </nav>
      <div className="flex-1" />
      <label htmlFor="q" className="sr-only">
        Search videos
      </label>
      <input
        id="q"
        type="search"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search videos"
        className="h-11 w-full rounded-xl border border-line-strong bg-canvas px-3 text-sm text-ink sm:w-[260px]"
      />
      <Link
        href="/record"
        className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-ink px-4 text-sm font-medium text-white hover:bg-ink-2"
      >
        <span className="size-2.5 rounded-full bg-record" aria-hidden="true" />
        New recording
      </Link>
      <div ref={menuWrap} className="relative">
        <button
          ref={trigger}
          type="button"
          aria-controls={menuId}
          aria-label={user?.name || user?.email || "Account"}
          aria-expanded={menu}
          onClick={() => setMenu((m) => !m)}
          className="inline-flex size-11 items-center justify-center rounded-full bg-accent-soft text-[13px] font-semibold text-ink"
        >
          {me.data ? initials(user?.name, user?.email) : ""}
        </button>
        {menu ? (
          <div
            id={menuId}
            className="absolute right-0 top-12 z-10 flex min-w-48 flex-col gap-1 rounded-2xl border border-line bg-surface p-2 shadow-lg"
          >
            <p className="truncate px-3 py-1 text-xs text-muted">{user?.email}</p>
            <Button variant="ghost" onClick={signOut} className="justify-start">
              Sign out
            </Button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

export function LibraryScreen() {
  const [query, setQuery] = useState("");
  const videos = useInfiniteQuery({
    queryKey: ["videos", "list"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await fetchClient.GET("/videos", {
        params: { query: { limit: PAGE_SIZE, cursor: pageParam } },
      });
      if (error || !data) throw new Error("Could not load videos");
      return data;
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const all = videos.data?.pages.flatMap((p) => p.items) ?? [];
  const needle = query.trim().toLowerCase();
  const items = needle ? all.filter((v) => v.title.toLowerCase().includes(needle)) : all;

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <TopBar query={query} onQuery={setQuery} />
      <main className="mx-auto flex max-w-[1280px] flex-col gap-7 px-4 py-10 sm:px-8">
        <h1 className="text-4xl">Library</h1>

        {videos.isPending ? (
          <div
            aria-label="Loading videos"
            className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex flex-col gap-3">
                <Skeleton className="aspect-[16/10] rounded-2xl" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/3" />
              </div>
            ))}
          </div>
        ) : videos.isError ? (
          <div role="alert" className="flex flex-col items-start gap-3">
            <p className="text-sm text-danger">Could not load your videos.</p>
            <Button variant="secondary" onClick={() => videos.refetch()}>
              Try again
            </Button>
          </div>
        ) : all.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-3xl border border-line bg-surface p-10">
            <h2 className="text-2xl">No recordings yet</h2>
            <p className="text-sm text-muted">
              Record your screen and the agent will propose a cleaned script and cut plan.
            </p>
            <Link
              href="/record"
              className="inline-flex min-h-11 items-center rounded-xl bg-ink px-5 text-sm font-medium text-white hover:bg-ink-2"
            >
              New recording
            </Link>
          </div>
        ) : (
          <>
            {items.length === 0 ? (
              <p className="text-sm text-muted">No videos match your search.</p>
            ) : null}
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-6">
              {items.map((v) => {
                const badge = statusBadge(v);
                const dur = formatDuration(v.duration_s);
                return (
                  <li key={v.id}>
                    <Link href={videoHref(v)} className="flex flex-col gap-3 text-ink no-underline">
                      <div className="relative aspect-[16/10] overflow-hidden rounded-2xl bg-sunken">
                        {v.poster_url ? (
                          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived GCS URL; next/image cannot cache it
                          <img
                            src={v.poster_url}
                            alt=""
                            width={1280}
                            height={800}
                            loading="lazy"
                            className="size-full object-cover"
                          />
                        ) : null}
                        {dur ? (
                          <span className="absolute bottom-2.5 right-2.5 rounded-md bg-ink/80 px-2 py-0.5 font-mono text-xs text-white">
                            {dur}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <div className="text-[15px] font-medium leading-snug">{v.title}</div>
                        <div className="flex items-center gap-2 text-[13px] text-muted">
                          <Badge tone={badge.tone}>{badge.label}</Badge>
                          <span>{statusHint(v)}</span>
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {videos.hasNextPage ? (
              <div>
                <Button
                  variant="secondary"
                  onClick={() => videos.fetchNextPage()}
                  disabled={videos.isFetchingNextPage}
                >
                  {videos.isFetchingNextPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
