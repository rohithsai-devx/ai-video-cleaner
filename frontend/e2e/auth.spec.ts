import { expect, test } from "@playwright/test";

test("sign up sets an httpOnly session the page cannot read", async ({ page, context }) => {
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/library");

  const cookie = (await context.cookies()).find((c) => c.name === "stepwise_session");
  expect(cookie, "session cookie is set").toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe("Lax");
  expect(cookie!.path).toBe("/");

  const visible = await page.evaluate(() => document.cookie);
  expect(visible).not.toContain("stepwise_session");
  expect(visible).not.toContain(cookie!.value);

  const me = await page.request.get("/api/me");
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { user: { email: string } };
  expect(body.user.email).toBe(email);
});

test("wrong password shows the form error", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(`nobody-${Date.now()}@example.com`);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Email or password is wrong" }),
  ).toBeVisible();
});

test("a signed-out visit to /library lands on /sign-in", async ({ page }) => {
  await page.goto("/library");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Flibrary$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("a state-changing request with a foreign Origin is refused", async ({ request }) => {
  const res = await request.post("/api/videos", {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: {},
  });
  expect(res.status()).toBe(403);
});
