import { expect, test, type Page } from "@playwright/test";
import { createUploadedVideo, signUp } from "./helpers";

async function startRun(page: Page, videoId: string, mode: "review" | "auto") {
  await page.goto(`/videos/${videoId}`);
  await page
    .getByLabel(mode === "review" ? "Let me review first" : "Render automatically")
    .check({ force: true });
  await page.getByRole("button", { name: "Process with AI" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
}

test("a review run shows the steps and ends at Open review", async ({ page }) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Review me");
  await startRun(page, id, "review");

  await expect(
    page.getByRole("heading", { name: /Cleaning up your video|Ready for your review/ }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open review" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("log", { name: "Run activity" })).toContainText("run.");
});

test("an auto run ends on the video page", async ({ page }) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Auto video");
  await startRun(page, id, "auto");
  await page.waitForURL(`**/videos/${id}`, { timeout: 90_000 });
  // The video page must show the finished video, not a cached "uploaded" copy with Process with AI.
  await expect(page.getByRole("heading", { name: "Share" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Process with AI" })).toHaveCount(0);
});
