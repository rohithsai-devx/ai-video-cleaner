import createFetchClient from "openapi-fetch";
import { describe, expect, it, vi } from "vitest";
import type { paths } from "./generated/schema";
import { CHUNK_SIZE, putResumable, uploadRecording } from "./upload";

const UPLOAD_URL = "http://gcs.test/upload?upload_id=abc";

type Call = { url: string; method: string; headers: Headers; size: number; body: string | null };

/** A fake GCS resumable endpoint: stores bytes, answers 308 + Range, can fail chosen chunk attempts. */
function fakeGcs(
  opts: { failPutAttempts?: number[]; persistShort?: number; exposeRange?: boolean } = {},
) {
  const calls: Call[] = [];
  let persisted = 0;
  let putAttempt = 0;
  const exposeRange = opts.exposeRange ?? true;
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body as Blob | undefined;
    const size = body ? body.size : 0;
    calls.push({ url, method: init?.method ?? "GET", headers, size, body: null });
    const cr = headers.get("Content-Range") ?? "";
    const status = /^bytes \*\/(\d+)$/.exec(cr);
    const rangeHeaders = (): HeadersInit =>
      persisted > 0 && exposeRange ? { Range: `bytes=0-${persisted - 1}` } : {};
    if (status) {
      if (persisted === Number(status[1])) return new Response("{}", { status: 200 });
      return new Response(null, { status: 308, headers: rangeHeaders() });
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr)!;
    const attempt = putAttempt++;
    if (opts.failPutAttempts?.includes(attempt)) {
      if (attempt % 2 === 0) throw new TypeError("network down");
      return new Response("busy", { status: 503 });
    }
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = Number(m[3]);
    expect(start).toBe(persisted);
    let accepted = end - start + 1;
    if (opts.persistShort && attempt === 0) accepted = opts.persistShort;
    persisted = start + accepted;
    if (persisted === total) return new Response("{}", { status: 200 });
    return new Response(null, { status: 308, headers: rangeHeaders() });
  });
  return { impl: impl as unknown as typeof fetch, calls, persisted: () => persisted };
}

const blobOf = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: "video/webm" });

describe("putResumable", () => {
  it("uses 8 MiB chunks, a multiple of 256 KiB", () => {
    expect(CHUNK_SIZE).toBe(8 * 1024 * 1024);
    expect(CHUNK_SIZE % (256 * 1024)).toBe(0);
  });

  it("PUTs consecutive chunks with Content-Range and reports progress", async () => {
    const gcs = fakeGcs();
    const total = CHUNK_SIZE * 2 + 1000;
    const progress: number[] = [];
    await putResumable(UPLOAD_URL, blobOf(total), {
      fetch: gcs.impl,
      onProgress: (sent) => progress.push(sent),
    });
    expect(gcs.calls.map((c) => c.headers.get("Content-Range"))).toEqual([
      `bytes 0-${CHUNK_SIZE - 1}/${total}`,
      `bytes ${CHUNK_SIZE}-${2 * CHUNK_SIZE - 1}/${total}`,
      `bytes ${2 * CHUNK_SIZE}-${total - 1}/${total}`,
    ]);
    expect(gcs.calls.every((c) => c.method === "PUT" && c.url === UPLOAD_URL)).toBe(true);
    expect(gcs.calls.map((c) => c.size)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 1000]);
    expect(progress.at(-1)).toBe(total);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(gcs.persisted()).toBe(total);
  });

  it("resumes from the server Range when it persisted fewer bytes than sent", async () => {
    const short = 256 * 1024;
    const gcs = fakeGcs({ persistShort: short });
    const total = CHUNK_SIZE + 10;
    await putResumable(UPLOAD_URL, blobOf(total), { fetch: gcs.impl });
    expect(gcs.calls[1].headers.get("Content-Range")).toBe(`bytes ${short}-${total - 1}/${total}`);
    expect(gcs.persisted()).toBe(total);
  });

  it("with resume, asks the server for its offset before sending", async () => {
    const gcs = fakeGcs({ persistShort: 256 * 1024 });
    const total = CHUNK_SIZE + 10;
    await putResumable(UPLOAD_URL, blobOf(total), {
      fetch: gcs.impl,
      chunkSize: CHUNK_SIZE * 2,
    }).catch(() => {});
    gcs.calls.length = 0;
    await putResumable(UPLOAD_URL, blobOf(total), { fetch: gcs.impl, resume: true });
    expect(gcs.calls[0].headers.get("Content-Range")).toBe(`bytes */${total}`);
    expect(gcs.persisted()).toBe(total);
  });

  it("after a failed chunk queries bytes */total and resumes from the returned Range", async () => {
    const gcs = fakeGcs({ failPutAttempts: [1, 2] });
    const total = CHUNK_SIZE * 2 + 5;
    await putResumable(UPLOAD_URL, blobOf(total), { fetch: gcs.impl, retryDelayMs: () => 0 });
    const ranges = gcs.calls.map((c) => c.headers.get("Content-Range"));
    expect(ranges).toContain(`bytes */${total}`);
    const statusIdx = ranges.indexOf(`bytes */${total}`);
    expect(ranges[statusIdx + 1]).toBe(`bytes ${CHUNK_SIZE}-${2 * CHUNK_SIZE - 1}/${total}`);
    expect(gcs.persisted()).toBe(total);
  });

  it("gives up after maxRetries consecutive failures", async () => {
    const gcs = fakeGcs({ failPutAttempts: [0, 1, 2, 3, 4, 5] });
    await expect(
      putResumable(UPLOAD_URL, blobOf(10), {
        fetch: gcs.impl,
        maxRetries: 2,
        retryDelayMs: () => 0,
      }),
    ).rejects.toThrow(/upload failed/i);
  });

  it("never treats a 308 on the final chunk as done; it asks the server and resends", async () => {
    const gcs = fakeGcs({ persistShort: 100 });
    const total = 1000;
    await putResumable(UPLOAD_URL, blobOf(total), { fetch: gcs.impl, retryDelayMs: () => 0 });
    const ranges = gcs.calls.map((c) => c.headers.get("Content-Range"));
    expect(ranges).toContain(`bytes */${total}`);
    expect(ranges.at(-1)).toBe(`bytes 100-999/${total}`);
    expect(gcs.persisted()).toBe(total);
  });

  it("assumes the whole chunk landed when a 308 hides the Range header (CORS)", async () => {
    const gcs = fakeGcs({ exposeRange: false });
    const total = CHUNK_SIZE + 3;
    await putResumable(UPLOAD_URL, blobOf(total), { fetch: gcs.impl });
    expect(gcs.calls[1].headers.get("Content-Range")).toBe(
      `bytes ${CHUNK_SIZE}-${total - 1}/${total}`,
    );
  });
});

describe("uploadRecording", () => {
  it("creates the video, uploads to GCS, then marks it uploaded with duration", async () => {
    const gcs = fakeGcs();
    const api: { method: string; path: string; body: unknown }[] = [];
    const apiFetch = vi.fn(async (req: Request) => {
      const path = new URL(req.url).pathname;
      const text = await req.text();
      api.push({ method: req.method, path, body: text ? JSON.parse(text) : null });
      if (path === "/videos")
        return Response.json({ video_id: "v1", upload_url: UPLOAD_URL }, { status: 201 });
      return Response.json({ id: "v1" }, { status: 200 });
    });
    const client = createFetchClient<paths>({
      baseUrl: "http://api.test",
      fetch: apiFetch as unknown as typeof fetch,
    });
    const onProgress = vi.fn();
    const result = await uploadRecording({
      blob: blobOf(1234),
      title: "Demo",
      durationS: 12.5,
      width: 1920,
      height: 1080,
      onProgress,
      client,
      fetch: gcs.impl,
    });
    expect(result).toEqual({ videoId: "v1" });
    expect(api[0]).toEqual({ method: "POST", path: "/videos", body: { title: "Demo" } });
    expect(api[1]).toEqual({
      method: "POST",
      path: "/videos/v1/uploaded",
      body: { duration_s: 12.5, width: 1920, height: 1080 },
    });
    expect(gcs.persisted()).toBe(1234);
    expect(onProgress).toHaveBeenLastCalledWith(1234, 1234);
  });

  it("throws when POST /videos fails, without touching GCS", async () => {
    const gcs = fakeGcs();
    const client = createFetchClient<paths>({
      baseUrl: "http://api.test",
      fetch: (async () =>
        Response.json({ detail: "nope" }, { status: 500 })) as unknown as typeof fetch,
    });
    await expect(
      uploadRecording({ blob: blobOf(5), title: "x", durationS: 1, client, fetch: gcs.impl }),
    ).rejects.toThrow();
    expect(gcs.calls).toHaveLength(0);
  });

  const POSTER_URL = "http://gcs.test/upload?upload_id=poster";
  const posterApi = (api: string[]) =>
    createFetchClient<paths>({
      baseUrl: "http://api.test",
      fetch: (async (req: Request) => {
        const path = new URL(req.url).pathname;
        api.push(path);
        if (path === "/videos")
          return Response.json(
            { video_id: "v1", upload_url: UPLOAD_URL, poster_upload_url: POSTER_URL },
            { status: 201 },
          );
        return Response.json({ id: "v1" }, { status: 200 });
      }) as unknown as typeof fetch,
    });

  it("uploads the poster to its own session before confirming", async () => {
    const order: string[] = [];
    const video = fakeGcs();
    const poster = fakeGcs();
    const gcsFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const isPoster = String(input) === POSTER_URL;
      order.push(isPoster ? "poster" : "video");
      return (isPoster ? poster.impl : video.impl)(input, init);
    }) as typeof fetch;
    const api: string[] = [];
    await uploadRecording({
      blob: blobOf(100),
      poster: new Blob([new Uint8Array(40)], { type: "image/jpeg" }),
      title: "Demo",
      durationS: 3,
      client: posterApi(api),
      fetch: gcsFetch,
    });
    expect(poster.persisted()).toBe(40);
    expect(order.at(-1)).toBe("poster");
    expect(api).toEqual(["/videos", "/videos/v1/uploaded"]);
  });

  it("still confirms the video when the poster upload fails", async () => {
    const video = fakeGcs();
    const gcsFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === POSTER_URL) throw new TypeError("poster down");
      return video.impl(input, init);
    }) as typeof fetch;
    const api: string[] = [];
    await expect(
      uploadRecording({
        blob: blobOf(100),
        poster: new Blob([new Uint8Array(40)], { type: "image/jpeg" }),
        title: "Demo",
        durationS: 3,
        client: posterApi(api),
        fetch: gcsFetch,
        posterRetryDelayMs: () => 0,
      }),
    ).resolves.toEqual({ videoId: "v1" });
    expect(api).toEqual(["/videos", "/videos/v1/uploaded"]);
  });
});
