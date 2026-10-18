import { expect, test } from "@playwright/test";
import { createUploadedVideo, signUp } from "./helpers";

const ORIGIN = { origin: "http://localhost:3000" };

test("a link share opens signed out with the title and a video", async ({ page, browser }) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Shared auto video");

  const started = await page.request.post(`/api/videos/${id}/runs`, {
    data: { mode: "auto", voice: "original" },
    headers: ORIGIN,
  });
  expect(started.ok()).toBe(true);
  const { run_id } = (await started.json()) as { run_id: string };

  await expect
    .poll(
      async () =>
        ((await (await page.request.get(`/api/runs/${run_id}`)).json()) as { status: string })
          .status,
      {
        timeout: 90_000,
      },
    )
    .toBe("done");

  await page.goto(`/videos/${id}`);
  await page.getByRole("button", { name: "Share link" }).click();
  const url = await page.getByLabel("Link", { exact: true }).inputValue();
  expect(url).toContain("/s/");

  const anon = await browser.newContext({ baseURL: "http://localhost:3000" });
  const pub = await anon.newPage();
  await pub.goto(url);
  await expect(pub.getByRole("heading", { name: "Shared auto video" })).toBeVisible();
  await expect(pub.locator("video")).toBeVisible();
  await anon.close();
});
