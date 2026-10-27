import { expect, test } from "@playwright/test";
import { createUploadedVideo, signUp } from "./helpers";

const ORIGIN = { origin: "http://localhost:3000" };

test("the raw card creates and copies an original recording link after upload", async ({
  page,
}) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Original card demo");
  await page.goto(`/videos/${id}`);

  const rawCard = page.getByRole("region", { name: "Share it as is" });
  await expect(rawCard).toBeVisible();
  await rawCard.getByRole("button", { name: "Create link" }).click();
  const link = rawCard.getByRole("textbox", { name: "Share it as is link" });
  await expect(link).toHaveValue(/\/s\//);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await rawCard.getByRole("button", { name: "Copy link" }).click();
  await expect(rawCard.getByRole("button", { name: "Copied" })).toBeVisible();
});

test("a raw link plays the original recording for a signed-out viewer", async ({
  page,
  browser,
}) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Shared raw recording");

  const videoResponse = await page.request.get(`/api/videos/${id}`, { headers: ORIGIN });
  expect(videoResponse.ok()).toBe(true);
  const video = (await videoResponse.json()) as { original_url: string | null };
  expect(video.original_url).toBeTruthy();

  const created = await page.request.post(`/api/videos/${id}/shares`, {
    data: { kind: "raw", visibility: "link", expires_at: null },
    headers: ORIGIN,
  });
  expect(created.ok()).toBe(true);
  const { slug } = (await created.json()) as { slug: string };
  const publicShareResponse = await page.request.get(`/api/s/${slug}`, { headers: ORIGIN });
  expect(publicShareResponse.ok()).toBe(true);
  const publicShare = (await publicShareResponse.json()) as {
    title: string;
    playback_url: string;
  };
  expect(new URL(publicShare.playback_url).pathname).toBe(new URL(video.original_url!).pathname);

  const anon = await browser.newContext({ baseURL: "http://localhost:3000" });
  const pub = await anon.newPage();
  await pub.goto(`/s/${slug}`);
  await expect(pub.getByRole("heading", { name: "Shared raw recording" })).toBeVisible();
  await expect(pub.locator("video")).toHaveAttribute("src", publicShare.playback_url);
  await anon.close();
});

test("the done screen shares and switches both versions", async ({ page, browser }, testInfo) => {
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
  await expect(page.getByRole("heading", { name: "What changed" })).toBeVisible();
  const player = page.getByLabel("Cleaned · your voice");
  const cleanedSource = await player.getAttribute("src");
  expect(cleanedSource).toBeTruthy();
  await expect(page.getByRole("region", { name: "Cleaned video" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Original recording" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download MP4" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download original" })).toBeVisible();

  const playButtons = page.getByRole("button", { name: "Play this version" });
  await playButtons.nth(1).click();
  const originalSource = await page
    .getByLabel("Original recording · your voice")
    .getAttribute("src");
  expect(originalSource).toBeTruthy();
  expect(originalSource).not.toBe(cleanedSource);
  await playButtons.nth(0).click();
  await expect(page.getByLabel("Cleaned · your voice")).toHaveAttribute("src", cleanedSource!);

  const cleanedCard = page.getByRole("region", { name: "Cleaned video" });
  await cleanedCard.getByRole("button", { name: "Create link" }).click();
  const cleanedLink = cleanedCard.getByRole("textbox", { name: "Cleaned video link" });
  await expect(cleanedLink).toHaveValue(/\/s\//);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await cleanedCard.getByRole("button", { name: "Copy link" }).click();
  await expect(cleanedCard.getByRole("button", { name: "Copied" })).toBeVisible();

  const originalCard = page.getByRole("region", { name: "Original recording" });
  await originalCard.getByRole("button", { name: "Create link" }).click();
  await expect(originalCard.getByRole("textbox", { name: "Original recording link" })).toHaveValue(
    /\/s\//,
  );

  const url = await cleanedLink.inputValue();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("done-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("done-mobile.png"), fullPage: true });

  const videoResponse = await page.request.get(`/api/videos/${id}`, { headers: ORIGIN });
  expect(videoResponse.ok()).toBe(true);
  const videoBody = (await videoResponse.json()) as Record<string, unknown>;
  let videoFetches = 0;
  const videoEndpoint = (url: URL) => url.pathname === `/api/videos/${id}`;
  await page.route(videoEndpoint, async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    videoFetches += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...videoBody, download_url: null, original_download_url: null }),
    });
  });
  await page.reload();
  await expect(page.getByText("Download unavailable.")).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => videoFetches).toBeGreaterThan(1);
  await expect(page.getByText("Download unavailable.")).toBeVisible();
  await page.unroute(videoEndpoint);

  await page.getByRole("link", { name: "Clean again with other settings" }).click();
  await expect(page.getByRole("heading", { name: "Clean this video" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/videos/${id}\\?clean=1$`));

  expect(url).toContain("/s/");

  const anon = await browser.newContext({ baseURL: "http://localhost:3000" });
  const pub = await anon.newPage();
  await pub.goto(url);
  await expect(pub.getByRole("heading", { name: "Shared auto video" })).toBeVisible();
  await expect(pub.locator("video")).toBeVisible();
  await anon.close();
});
