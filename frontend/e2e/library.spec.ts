import { expect, test } from "@playwright/test";
import { createUploadedVideo, signUp } from "./helpers";

test("an uploaded video starts a review-mode run", async ({ page }) => {
  await signUp(page);
  const id = await createUploadedVideo(page, "Coupon bug repro");

  await page.goto("/library");
  const card = page.getByRole("link", { name: /Coupon bug repro/ });
  await expect(card).toContainText("Uploaded");
  await card.click();
  await page.waitForURL(`**/videos/${id}`);

  await page.getByLabel("Show me before it renders").check({ force: true });
  await page.getByRole("button", { name: "Clean this video" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
});
