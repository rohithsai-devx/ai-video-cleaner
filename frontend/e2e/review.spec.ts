import { expect, test, type Page } from "@playwright/test";
import { signUp } from "./helpers";

const ORIGIN = { origin: "http://localhost:3000" };

// createUploadedVideo reports 3 s, but the canned plan spans 60 s and approve EDL-checks against the
// video duration. So this spec makes its own 60 s video (same calls as the shared helper).
async function createSixtySecondVideo(page: Page): Promise<string> {
  const created = await page.request.post("/api/videos", {
    data: { title: "Review flow" },
    headers: ORIGIN,
  });
  const { video_id, upload_url } = (await created.json()) as {
    video_id: string;
    upload_url: string;
  };
  const put = await page.request.put(upload_url, {
    headers: { "content-type": "video/webm" },
    data: Buffer.from("not-really-a-webm"),
  });
  expect(put.ok()).toBe(true);
  const done = await page.request.post(`/api/videos/${video_id}/uploaded`, {
    data: { duration_s: 60, width: 1280, height: 720 },
    headers: ORIGIN,
  });
  expect(done.ok()).toBe(true);
  return video_id;
}

test("review: flip a cut, save as version 2, approve and land on the run", async ({ page }) => {
  await signUp(page);
  const videoId = await createSixtySecondVideo(page);
  await page.goto(`/videos/${videoId}`);
  await page.getByLabel("Let me review first").check({ force: true });
  await page.getByRole("button", { name: "Process with AI" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
  const runId = page.url().split("/").pop()!;

  await expect
    .poll(async () => (await (await page.request.get(`/api/runs/${runId}`)).json()).status, {
      timeout: 60_000,
    })
    .toBe("awaiting_review");

  await page.goto(`/runs/${runId}/review`);
  await expect(page.getByRole("heading", { name: "Cuts and why" })).toBeVisible();
  await expect(page.getByText("Version 1", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Keep instead" }).first().click();
  await page.getByRole("button", { name: "Save edits" }).click();
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Approve and render" }).click();
  await page
    .getByRole("dialog", { name: "Approve and render?" })
    .getByRole("button", { name: "Approve and render" })
    .click();
  await page.waitForURL(`**/runs/${runId}`);

  // once approved, the review screen is read-only
  await page.goto(`/runs/${runId}/review`);
  await expect(page.getByText("Version 2", { exact: true })).toBeVisible();
  await expect(page.getByText(/so the proposal is read-only/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save edits" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Approve and render" })).toHaveCount(0);
});
