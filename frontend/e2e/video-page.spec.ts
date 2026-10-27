import { expect, test } from "@playwright/test";
import { createUploadedVideo, signUp } from "./helpers";

test("the uploaded video page shows controls, voices, and past attempts", async ({ page }) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Setting up a new project");
  const currentRunId = "run-done-current";
  const createdAt = new Date().toISOString();
  const attempts = [
    { run_id: "run-review", status: "awaiting_review", voice: "original", needs_you: 3 },
    { run_id: "run-queued", status: "queued", voice: "ai", needs_you: 0 },
    { run_id: "run-preprocessing", status: "preprocessing", voice: "original", needs_you: 0 },
    { run_id: "run-agent", status: "agent_running", voice: "ai", needs_you: 0 },
    { run_id: "run-approved", status: "approved", voice: "original", needs_you: 0 },
    { run_id: "run-postprocessing", status: "postprocessing", voice: "ai", needs_you: 0 },
    { run_id: currentRunId, status: "done", voice: "original", needs_you: 0 },
    { run_id: "run-done-old", status: "done", voice: "ai", needs_you: 0 },
    { run_id: "run-failed", status: "failed", voice: "original", needs_you: 0 },
    { run_id: "run-cancelled", status: "cancelled", voice: "ai", needs_you: 0 },
  ].map((run) => ({
    ...run,
    created_at: createdAt,
    voice_id: run.voice === "ai" ? "coral" : null,
  }));

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
        original_url: null,
        poster_url: null,
        current_run: { run_id: currentRunId, status: "done" },
        created_at: createdAt,
        updated_at: createdAt,
      },
    });
  });

  await page.route(`**/api/videos/${id}/runs`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: attempts });
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
  await expect(page.getByRole("link", { name: "See progress" })).toHaveCount(5);
  await expect(page.getByRole("link", { name: "Watch" })).toHaveAttribute("href", `/videos/${id}`);
  await expect(page.getByText("Replaced by a newer version")).toBeVisible();
  await expect(page.getByRole("link", { name: "See what happened" })).toHaveAttribute(
    "href",
    "/runs/run-failed",
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
