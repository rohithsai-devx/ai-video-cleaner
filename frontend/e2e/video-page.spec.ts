import { expect, type Page, test } from "@playwright/test";
import { createUploadedVideo, signUp } from "./helpers";

type RunStatus =
  | "queued"
  | "preprocessing"
  | "agent_running"
  | "awaiting_review"
  | "approved"
  | "postprocessing"
  | "done"
  | "failed"
  | "cancelled";

type Attempt = {
  run_id: string;
  status: RunStatus;
  voice: "original" | "ai";
  voice_id: string | null;
  needs_you: number;
  created_at: string;
};

function attempts(
  rows: Array<Pick<Attempt, "run_id" | "status" | "voice"> & Partial<Attempt>>,
  createdAt = new Date().toISOString(),
): Attempt[] {
  return rows.map((row) => ({
    ...row,
    voice_id: row.voice === "ai" ? (row.voice_id ?? "coral") : null,
    needs_you: row.needs_you ?? 0,
    created_at: row.created_at ?? createdAt,
  }));
}

function yesterdayAt(hour: number, minute: number): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

async function mockVideoPage(
  page: Page,
  id: string,
  currentRunId: string,
  currentRunStatus: RunStatus,
  rows: Attempt[],
) {
  const createdAt = new Date().toISOString();

  await page.route(`**/api/videos/${id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        id,
        title: "Setting up a new project",
        status: "uploaded",
        duration_s: 372,
        width: 1920,
        height: 1080,
        estimated_run_seconds: null,
        playback_url: null,
        original_url: "/original.mp4",
        poster_url: null,
        current_run: { run_id: currentRunId, status: currentRunStatus },
        created_at: createdAt,
        updated_at: createdAt,
      },
    });
  });

  await page.route(`**/api/videos/${id}/runs`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: rows });
      return;
    }
    await route.fulfill({
      status: 202,
      json: { run_id: "00000000-0000-0000-0000-000000000099", status: "queued" },
    });
  });

  await page.route("**/api/voices", async (route) => {
    await route.fulfill({
      json: {
        default_voice_id: "coral",
        voices: [
          {
            id: "coral",
            label: "Coral",
            hint: "Warm, calm",
            sample_path: "/voice-samples/coral.mp3",
          },
          {
            id: "sage",
            label: "Sage",
            hint: "Clear, steady",
            sample_path: "/voice-samples/sage.mp3",
          },
        ],
      },
    });
  });
}

test("the uploaded video page shows controls and the two wireframe attempts", async ({ page }) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Setting up a new project");
  const rows = attempts([
    {
      run_id: "run-review",
      status: "awaiting_review",
      voice: "original",
      needs_you: 3,
      created_at: yesterdayAt(16, 10),
    },
    {
      run_id: "run-cancelled",
      status: "cancelled",
      voice: "ai",
      created_at: yesterdayAt(15, 52),
    },
  ]);
  await mockVideoPage(page, id, "run-cancelled", "cancelled", rows);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/videos/${id}`);
  await expect(page.getByRole("heading", { name: "Clean this video" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Past attempts" })).toBeVisible();
  await expect(page.getByText("About 2 minutes for a 6-minute recording.")).toHaveCount(0);
  await expect(page.getByText("3 to check")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open editor" })).toHaveAttribute(
    "href",
    "/runs/run-review/review",
  );
  await expect(page.getByText("No video made")).toBeVisible();
  await page.screenshot({ path: "test-results/video-page-default-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/video-page-default-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  const reviewSwitch = page.getByRole("switch", { name: "Show me before it renders" });
  await expect(
    page.getByText(
      "You get the editor with every change marked. Nothing renders until you say so.",
    ),
  ).toBeVisible();
  await reviewSwitch.focus();
  await reviewSwitch.press("Space");
  await expect(reviewSwitch).not.toBeChecked();
  await expect(
    page.getByText(
      "Renders straight away. If the AI is unsure about something, it stops and asks you first.",
    ),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "Remove filler words" }).uncheck();

  const aiVoice = page.getByRole("radio", { name: "AI voice" });
  await aiVoice.focus();
  await aiVoice.press("Space");
  await expect(aiVoice).toBeChecked();
  await expect(page.getByRole("radio", { name: "Coral" })).toBeChecked();
  await expect(page.getByText("Warm, calm")).toBeVisible();
  const sageVoice = page.getByRole("radio", { name: "Sage" });
  await sageVoice.focus();
  await sageVoice.press("Space");
  await expect(sageVoice).toBeChecked();
  await page.screenshot({ path: "test-results/video-page-ai-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/video-page-ai-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  const startRequestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().includes(`/api/videos/${id}/runs`),
  );
  await page.getByRole("button", { name: "Clean this video" }).click();
  const startRequest = await startRequestPromise;
  expect(startRequest.postDataJSON()).toEqual({
    mode: "auto",
    voice: "ai",
    voice_id: "sage",
    fix_options: { pauses: true, filler: false, retakes: true, slow_parts: true },
  });
});

test("past attempts show the right label and destination for every run status", async ({
  page,
}) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Setting up a new project");
  const rows = attempts([
    { run_id: "run-review", status: "awaiting_review", voice: "original", needs_you: 3 },
    { run_id: "run-queued", status: "queued", voice: "ai" },
    { run_id: "run-preprocessing", status: "preprocessing", voice: "original" },
    { run_id: "run-agent", status: "agent_running", voice: "ai" },
    { run_id: "run-approved", status: "approved", voice: "original" },
    { run_id: "run-postprocessing", status: "postprocessing", voice: "ai" },
    { run_id: "run-done-current", status: "done", voice: "original" },
    { run_id: "run-done-old", status: "done", voice: "ai" },
    { run_id: "run-failed", status: "failed", voice: "original" },
    { run_id: "run-cancelled", status: "cancelled", voice: "ai" },
  ]);
  await mockVideoPage(page, id, "run-done-current", "done", rows);
  await page.goto(`/videos/${id}`);

  await expect(page.getByText("Waiting for you")).toBeVisible();
  await expect(page.getByRole("link", { name: "Open editor" })).toHaveAttribute(
    "href",
    "/runs/run-review/review",
  );
  await expect(page.getByText("In progress")).toHaveCount(5);
  const progressRunIds = [
    "run-queued",
    "run-preprocessing",
    "run-agent",
    "run-approved",
    "run-postprocessing",
  ];
  const progressLinks = page.getByRole("link", { name: "See progress" });
  await expect(progressLinks).toHaveCount(progressRunIds.length);
  for (const [index, runId] of progressRunIds.entries()) {
    await expect(progressLinks.nth(index)).toHaveAttribute("href", `/runs/${runId}`);
  }
  await expect(page.getByText("Done")).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Watch" })).toHaveAttribute("href", `/videos/${id}`);
  await expect(page.getByText("Replaced by a newer version")).toBeVisible();
  await expect(page.getByText("Failed")).toBeVisible();
  await expect(page.getByRole("link", { name: "See what happened" })).toHaveAttribute(
    "href",
    "/runs/run-failed",
  );
  await expect(page.getByText("Stopped")).toBeVisible();
  await expect(page.getByText("No video made")).toBeVisible();
});
