import { expect, test, type Page } from "@playwright/test";
import type { components } from "@/api/generated/schema";
import { createUploadedVideo, signUp } from "./helpers";

type Run = components["schemas"]["Run"];

async function startRun(page: Page, videoId: string, mode: "review" | "auto") {
  await page.goto(`/videos/${videoId}`);
  const reviewSwitch = page.getByRole("switch", { name: "Show me before it renders" });
  if (mode === "auto") await reviewSwitch.uncheck({ force: true });
  await page.getByRole("button", { name: "Clean this video" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
}

test("a review run shows the four steps and ends at Open the editor", async ({ page }) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Review me");
  await startRun(page, id, "review");

  await expect(page.getByRole("heading", { name: "Ready for you" })).toBeVisible({
    timeout: 60_000,
  });
  for (const label of [
    "Listening to your narration",
    "Watching your screen",
    "Planning the cuts",
    "Getting it ready for you",
  ]) {
    await expect(page.getByText(label)).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Open the editor" })).toBeVisible();
  await expect(page.getByRole("log")).toHaveCount(0);
  await expect(page.getByText(/run\.(status|failed|done)|pre-cpu|post-io/)).toHaveCount(0);
});

test("an auto run ends on the video page", async ({ page }) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Auto video");
  await startRun(page, id, "auto");
  await page.waitForURL(`**/videos/${id}`, { timeout: 90_000 });
  // The video page must show the finished video, not a cached "uploaded" copy with Process with AI.
  await expect(page.getByRole("heading", { name: "Share" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Clean this video" })).toHaveCount(0);
});

test("a retryable failure retries and refreshes the run", async ({ page }) => {
  await signUp(page);
  const videoId = await createUploadedVideo(page, "Retry me");
  const runId = crypto.randomUUID();
  let currentRun: Run = {
    id: runId,
    video_id: videoId,
    status: "failed",
    stage: "agent",
    error: {
      stage: "3",
      message: "The AI service didn't answer in time. Trying again usually works.",
      retryable: true,
    },
    mode: "review",
    voice: "original",
    attempt: 1,
    flags: [],
    created_at: "2026-10-18T10:00:00Z",
  };

  await page.route(`**/api/runs/${runId}`, (route) =>
    route.fulfill({ status: 200, json: currentRun }),
  );
  await page.route(`**/api/runs/${runId}/retry`, async (route) => {
    currentRun = { ...currentRun, status: "preprocessing", stage: "preprocess", error: null };
    await route.fulfill({
      status: 202,
      json: { run_id: runId, status: "preprocessing", stage: "preprocess" },
    });
  });
  await page.route(`**/api/runs/${runId}/events`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: run.status\ndata: ${JSON.stringify({ status: "preprocessing", stage: "preprocess" })}\n\n`,
    }),
  );

  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole("heading", { name: "Cleaning stopped" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  const retryRequest = page.waitForRequest((request) =>
    request.url().endsWith(`/api/runs/${runId}/retry`),
  );
  await page.getByRole("button", { name: "Try again" }).click();
  expect((await retryRequest).method()).toBe("POST");
  await expect(page.getByRole("heading", { name: "Cleaning your video" })).toBeVisible();
  await expect(page.getByText("Step 1 of 4")).toBeVisible();
});
