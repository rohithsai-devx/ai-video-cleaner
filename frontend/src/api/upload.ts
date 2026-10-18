import type { Client } from "openapi-fetch";
import { fetchClient } from "./client";
import type { paths } from "./generated/schema";

/**
 * Resumable upload of a finished recording straight to the GCS session URL.
 * The API never sees media bytes: it only issues the session (POST /videos)
 * and records completion (POST /videos/{id}/uploaded).
 */

/** 8 MiB: GCS requires every non-final chunk to be a multiple of 256 KiB. */
export const CHUNK_SIZE = 8 * 1024 * 1024;

export type UploadProgress = (sentBytes: number, totalBytes: number) => void;

export type PutResumableOptions = {
  fetch?: typeof fetch;
  onProgress?: UploadProgress;
  chunkSize?: number;
  /** Consecutive failures allowed before giving up. */
  maxRetries?: number;
  retryDelayMs?: (attempt: number) => number;
  signal?: AbortSignal;
  /** Ask the server for its offset first (a retry of an interrupted upload). */
  resume?: boolean;
};

const defaultDelay = (attempt: number) => Math.min(8000, 500 * 2 ** attempt);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parses a GCS `Range: bytes=0-N` header into the next byte offset (N + 1). Null when absent or unreadable. */
function nextOffset(res: Response): number | null {
  const m = /bytes=0-(\d+)/.exec(res.headers.get("Range") ?? "");
  return m ? Number(m[1]) + 1 : null;
}

export async function putResumable(
  uploadUrl: string,
  blob: Blob,
  opts: PutResumableOptions = {},
): Promise<void> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const maxRetries = opts.maxRetries ?? 5;
  const delay = opts.retryDelayMs ?? defaultDelay;
  const total = blob.size;
  let offset = 0;
  let failures = 0;

  const queryOffset = async (): Promise<number | "done"> => {
    const res = await doFetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Range": `bytes */${total}` },
      signal: opts.signal,
    });
    if (res.ok) return "done";
    if (res.status === 308) return nextOffset(res) ?? 0;
    throw new Error(`Upload status query failed (${res.status})`);
  };

  if (opts.resume) {
    const next = await queryOffset();
    if (next === "done") {
      opts.onProgress?.(total, total);
      return;
    }
    offset = next;
  }

  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    try {
      const res = await doFetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${offset}-${end - 1}/${total}` },
        body: blob.slice(offset, end),
        signal: opts.signal,
      });
      if (res.ok) {
        offset = total;
      } else if (res.status === 308) {
        // Only a 2xx finishes an upload: a 308 on the last chunk means bytes are still missing.
        if (end === total) throw new Error("final chunk not complete (308)");
        const next = nextOffset(res);
        // A readable Range that did not move forward is a failed attempt, not progress.
        if (next !== null && next <= offset) throw new Error("chunk made no progress (308)");
        // Range is unreadable when the bucket's CORS does not expose it (fake-gcs exposes only Location);
        // then assume the chunk landed. Production bucket CORS must expose Range (docs/plan/phases.md).
        offset = next ?? end;
      } else {
        throw new Error(`chunk rejected (${res.status})`);
      }
      failures = 0;
      opts.onProgress?.(offset, total);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      failures += 1;
      if (failures > maxRetries) {
        throw new Error(`Upload failed after ${maxRetries} retries: ${(err as Error).message}`);
      }
      await sleep(delay(failures - 1));
      try {
        const next = await queryOffset();
        offset = next === "done" ? total : next;
        opts.onProgress?.(offset, total);
      } catch {
        // Keep the current offset; the next PUT attempt counts against the retry budget.
      }
    }
  }
}

export type UploadRecordingInput = {
  blob: Blob;
  /** A JPEG frame for library cards; best effort, its failure never fails the upload. */
  poster?: Blob | null;
  /** Retry backoff for the poster upload (tests pass zero). */
  posterRetryDelayMs?: (attempt: number) => number;
  title: string;
  durationS: number;
  width?: number;
  height?: number;
  onProgress?: UploadProgress;
  signal?: AbortSignal;
  /** Injected for tests; defaults to the app's API client and global fetch. */
  client?: Client<paths>;
  fetch?: typeof fetch;
  /** A session from an earlier attempt; when set, the upload resumes instead of creating a new video. */
  session?: UploadSession;
  onSession?: (session: UploadSession) => void;
};

export type UploadSession = { videoId: string; uploadUrl: string; posterUploadUrl?: string | null };

export async function uploadRecording(input: UploadRecordingInput): Promise<{ videoId: string }> {
  const client = input.client ?? fetchClient;
  let session = input.session;
  if (!session) {
    const created = await client.POST("/videos", { body: { title: input.title } });
    if (!created.data) throw new Error("Could not start the upload");
    session = {
      videoId: created.data.video_id,
      uploadUrl: created.data.upload_url,
      posterUploadUrl: created.data.poster_upload_url ?? null,
    };
    input.onSession?.(session);
  }
  const { videoId, uploadUrl, posterUploadUrl } = session;

  await putResumable(uploadUrl, input.blob, {
    fetch: input.fetch,
    onProgress: input.onProgress,
    signal: input.signal,
    resume: Boolean(input.session),
  });

  if (input.poster && posterUploadUrl) {
    try {
      await putResumable(posterUploadUrl, input.poster, {
        fetch: input.fetch,
        signal: input.signal,
        maxRetries: 2,
        retryDelayMs: input.posterRetryDelayMs,
      });
    } catch {
      // Best effort: the library falls back to a gray box without a poster.
    }
  }

  const done = await client.POST("/videos/{video_id}/uploaded", {
    params: { path: { video_id: videoId } },
    body: {
      duration_s: input.durationS > 0 ? input.durationS : null,
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
    },
  });
  if (done.error) throw new Error("Upload finished but could not be confirmed");
  return { videoId };
}
