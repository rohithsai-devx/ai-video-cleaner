import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

// Chrome's fake capture devices: getDisplayMedia picks a synthetic screen and getUserMedia a synthetic mic,
// so the real recorder, MediaRecorder and resumable upload to fake-gcs all run without a human.
test.use({
  // The full Chromium build in new headless mode; the default headless shell has no screen capture.
  channel: "chromium",
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  },
  permissions: ["microphone"],
});

test("record a few seconds, stop, upload, and land on the uploaded video", async ({ page }) => {
  await signUp(page);
  await page.goto("/record");
  await page.getByLabel("Title").fill("Recorder e2e");
  await page.getByRole("button", { name: "Choose screen and record" }).click();

  const timer = page.getByRole("timer", { name: "Recording time" });
  await expect(timer).toBeVisible();
  await expect(timer).toContainText("00:03", { timeout: 10_000 });
  await page.getByRole("button", { name: "Stop" }).click();

  await page.waitForURL(/\/videos\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const videoId = page.url().split("/").pop()!;
  const res = await page.request.get(`/api/videos/${videoId}`);
  expect(res.ok()).toBe(true);
  const video = (await res.json()) as {
    status: string;
    title: string;
    duration_s: number | null;
    poster_url: string | null;
  };
  expect(video.title).toBe("Recorder e2e");
  expect(video.status).toBe("uploaded");
  expect(video.duration_s ?? 0).toBeGreaterThan(2);
  // the recorder grabbed a frame at stop and uploaded it before confirming
  expect(video.poster_url).not.toBeNull();
  const poster = await page.request.get(video.poster_url!);
  expect(poster.ok()).toBe(true);
  expect((await poster.body()).byteLength).toBeGreaterThan(1000);
});
