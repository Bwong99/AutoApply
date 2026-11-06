import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockGemini } from "../mockGemini";
import { expect, seed, test } from "./extension";

const EXT = path.resolve("dist");

test("manual review, YOLO review and YOLO navigation controls save independently", async ({ sw, page }) => {
  await seed(sw);
  await page.setViewportSize({ width: 1280, height: 900 });
  const options = `chrome-extension://${new URL(sw.url()).host}/src/options/index.html`;
  await page.goto(`${options}#/behavior`);
  const manual = page.getByRole("checkbox", { name: "Review manual fills with AI", exact: true });
  await expect(manual).toBeChecked();
  await manual.click();
  await expect(manual).not.toBeChecked();
  await page.goto(`${options}#/yolo`);
  const yolo = page.getByRole("checkbox", { name: "Review YOLO fills with AI", exact: true });
  const navigation = page.getByRole("checkbox", { name: "Use AI navigation when stuck", exact: true });
  await expect(yolo).toBeChecked();
  await expect(navigation).toBeChecked();
  const reviewBox = (await yolo.boundingBox())!;
  const navigationBox = (await navigation.boundingBox())!;
  expect(navigationBox.x).toBeGreaterThan(reviewBox.x);
  expect(navigationBox.y).toBeCloseTo(reviewBox.y, 0);
  await yolo.click();
  await expect(yolo).not.toBeChecked();
  await expect(navigation).toBeChecked();
  await navigation.click();
  await expect(navigation).not.toBeChecked();
  await expect(yolo).not.toBeChecked();
  await yolo.click();
  await expect(yolo).toBeChecked();
  await expect(navigation).not.toBeChecked();
  await page.goto(`${options}#/behavior`);
  await expect(manual).not.toBeChecked();
  await manual.click();
  await expect(manual).toBeChecked();
  await page.goto(`${options}#/yolo`);
  await expect(yolo).toBeChecked();
  await expect(navigation).not.toBeChecked();
  await page.setViewportSize({ width: 800, height: 900 });
  expect((await navigation.boundingBox())!.y).toBeGreaterThan((await yolo.boundingBox())!.y);
});

async function launch(dir: string) {
  const mock = new MockGemini();
  const context = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  await mock.install(context);
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  return { context, sw, mock, id: new URL(sw.url()).host };
}

test("setup: adding a key fetches models; only text models, newest first; the choice survives a restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "autoapply-"));
  try {
    const first = await launch(dir);
    const { mock } = first;
    let { context, id } = first;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/src/options/index.html#/setup/1`);
    await expect(page.getByText("Rate limits apply per Google Cloud project, not per key.")).toBeVisible();
    await page.getByLabel("Label").first().fill("Main");
    await page.getByLabel("API key").fill("AIza-test-key");
    await page.getByRole("button", { name: "Add key" }).click();
    await expect(page.getByText("Key added and verified.")).toBeVisible();
    await expect(page.locator("td.mono")).toHaveText("••••-key");
    expect(mock.calls.some((c) => c.kind === "list" && c.key === "AIza-test-key")).toBe(true);

    await page.goto(`chrome-extension://${id}/src/options/index.html#/setup/2`);
    const ids = page.locator(".models .model .mono");
    await expect(ids).toHaveText([
      "gemini-2.5-pro",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-flash-latest",
    ]);
    // Default preselection: first flash-lite.
    await expect(page.getByRole("radio", { name: /gemini-2\.5-flash-lite/ })).toBeChecked();
    await expect(page.locator(".model", { hasText: "gemini-flash-latest" }).locator(".badge")).toHaveText("Alias");

    await page.getByRole("radio", { name: /gemini-2\.5-pro/ }).check();
    await expect(page.getByText("✓ gemini-2.5-pro works")).toBeVisible();
    await context.close();

    ({ context, id } = await launch(dir));
    const again = await context.newPage();
    await again.goto(`chrome-extension://${id}/src/options/index.html#/ai`);
    await expect(again.getByRole("radio", { name: /gemini-2\.5-pro/ }).first()).toBeChecked();
    await context.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid keys are rejected with the API's message", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "autoapply-"));
  const { context, id, mock } = await launch(dir);
  try {
    await context.unroute("https://generativelanguage.googleapis.com/**");
    await context.route("https://generativelanguage.googleapis.com/**", (r) =>
      r.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." },
        }),
      }),
    );
    void mock;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/src/options/index.html#/ai`);
    await page.getByLabel("API key").fill("bad");
    await page.getByRole("button", { name: "Add key" }).click();
    await expect(page.getByText("API key not valid. Please pass a valid API key.")).toBeVisible();
    await expect(page.locator("td.mono")).toHaveCount(0);
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
