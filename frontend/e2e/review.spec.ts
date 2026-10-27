import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { components } from "../src/api/generated/schema";
import { signUp } from "./helpers";

const RUN_ID = "9a01f97e-7b15-4cdf-8cb5-eae7a37bb4cc";
const VIDEO_ID = "5ff2f608-f08a-4f22-957c-9774ed658fcb";
const CREATED_AT = "2026-10-01T00:00:00Z";
const demo = JSON.parse(
  readFileSync(new URL("./fixtures/proposal-demo.json", import.meta.url), "utf8"),
) as components["schemas"]["ProposalView"];

async function fulfillJson(route: Route, json: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
}

async function openReview(page: Page) {
  await signUp(page);

  const view = structuredClone(demo);
  view.proposal.run_id = RUN_ID;
  const run: components["schemas"]["Run"] = {
    id: RUN_ID,
    video_id: VIDEO_ID,
    mode: "review",
    voice: "ai",
    voice_id: "coral",
    status: "awaiting_review",
    attempt: 1,
    created_at: CREATED_AT,
    fix_options: { filler: false, pauses: false, retakes: false, slow_parts: false },
    flags: [],
    stage: null,
    started_at: null,
    finished_at: null,
    error: null,
  };
  const video = {
    id: VIDEO_ID,
    workspace_id: "workspace-fixture",
    title: "Post-upload review demo",
    status: "awaiting_review",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    duration_s: 372,
    original_url: "/fixture/original.mp4",
    original_download_url: null,
    playback_url: null,
    download_url: null,
    poster_url: null,
    width: 1280,
    height: 720,
    fps: 30,
    estimated_run_seconds: null,
    current_run: null,
  };

  await page.route(`**/api/runs/${RUN_ID}/proposal`, async (route) => {
    if (route.request().method() === "PUT") {
      const update = route.request().postDataJSON() as {
        base_version: number;
        script: unknown;
        edit_plan: unknown;
        chosen_fixes?: Record<string, string>;
      };
      view.proposal.version = update.base_version + 1;
      view.proposal.script = update.script as typeof view.proposal.script;
      view.proposal.edit_plan = update.edit_plan as typeof view.proposal.edit_plan;
      for (const spot of view.spots) {
        spot.chosen_fix_id = update.chosen_fixes?.[spot.spot_id] ?? null;
        spot.chosen_by = spot.chosen_fix_id ? "user" : null;
      }
    }
    await fulfillJson(route, view);
  });
  await page.route(`**/api/runs/${RUN_ID}/approve`, (route) => fulfillJson(route, {}, 202));
  await page.route(`**/api/runs/${RUN_ID}/events`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `event: run.status\ndata: ${JSON.stringify({ status: "awaiting_review" })}\n\n`,
    }),
  );
  await page.route(`**/api/runs/${RUN_ID}`, (route) => fulfillJson(route, run));
  await page.route(`**/api/videos/${VIDEO_ID}`, (route) => fulfillJson(route, video));
  await page.route("**/api/voices", (route) =>
    fulfillJson(route, {
      default_voice_id: "coral",
      voices: [{ id: "coral", label: "Coral", hint: "Warm and clear", sample_path: "/sample.mp3" }],
    }),
  );
  await page.route("https://storage.example.test/waveform.json", (route) =>
    fulfillJson(route, { rate: 50, peaks: [0.1, 0.4, 0.8, 0.3, 0.6] }),
  );
  await page.route("**/fixture/original.mp4", (route) =>
    route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.alloc(0) }),
  );

  await page.goto(`/runs/${RUN_ID}/review`);
  await expect(page.getByText("Post-upload review demo")).toBeVisible();
  return { run };
}

test("review follows the playhead, switches sources, saves decisions, and renders", async ({
  page,
}) => {
  const { run } = await openReview(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await expect(page.getByRole("tab", { name: "Needs you 3" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Done by AI 8" })).toBeVisible();
  await expect(page.getByText("6:12 → 4:05")).toBeVisible();
  await page.screenshot({ path: "test-results/review-ai-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/review-ai-390.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("tab", { name: "Done by AI 8" }).click();
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(page.getByText("6:12 → 4:25")).toBeVisible();
  await page.getByRole("button", { name: "Redo" }).first().click();
  await expect(page.getByText("6:12 → 4:05")).toBeVisible();

  await page.getByRole("button", { name: "Billing page, 1:05 to 2:40" }).click();
  const nowBar = page.getByText("Now", { exact: true }).locator("..");
  await expect(nowBar).toContainText("1:05");
  await page.getByText("Original", { exact: true }).click();
  await expect(nowBar).toContainText("1:05");
  await expect(page.getByLabel("Original · AI voice")).toHaveAttribute(
    "src",
    "/fixture/original.mp4",
  );
  await page.getByText("Cleaned", { exact: true }).click();

  await page.getByRole("tab", { name: "Needs you 3" }).click();
  await page.getByRole("button", { name: "Shorten the narration" }).click();
  await expect(page.getByRole("button", { name: "Render video" })).toBeDisabled();
  await page.getByRole("button", { name: "Save edits" }).click();
  await expect(page.getByText("Saved as version 2.")).toBeVisible();

  await page.reload();
  await expect(page.getByText("You chose: Shorten the narration")).toBeVisible();
  await page.getByRole("button", { name: "Render video" }).click();
  const dialog = page.getByRole("dialog", { name: "Render this version?" });
  await dialog.getByRole("button", { name: "Render video" }).click();
  await page.waitForURL(`**/runs/${RUN_ID}`);

  run.voice = "original";
  run.voice_id = null;
  await page.goto(`/runs/${RUN_ID}/review`);
  await expect(page.getByText("Narration: my voice")).toBeVisible();
  await page.screenshot({ path: "test-results/review-my-voice-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/review-my-voice-390.png", fullPage: true });
});
