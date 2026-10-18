import { expect, type Page } from "@playwright/test";

// The proxy refuses state-changing requests without the app's own Origin; browsers add it, page.request does not.
const ORIGIN = { origin: "http://localhost:3000" };

export async function signUp(page: Page): Promise<string> {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/library");
  return email;
}

/** Creates a video through the API and marks it uploaded, with a tiny webm-typed blob. */
export async function createUploadedVideo(page: Page, title = "E2E recording"): Promise<string> {
  const created = await page.request.post("/api/videos", { data: { title }, headers: ORIGIN });
  expect(created.status()).toBe(201);
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
    data: { duration_s: 3, width: 1280, height: 720 },
    headers: ORIGIN,
  });
  expect(done.ok()).toBe(true);
  return video_id;
}
