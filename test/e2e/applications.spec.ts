import type { Page, Worker } from "@playwright/test";
import { ApplicationSchema, QueueItemSchema, type Application, type QueueItem } from "../../src/shared/yolo";
import { BASE, expect, seed, storage, test } from "./extension";

const EMPTY_QUEUE_TEXT = "No queued jobs. Jobs will appear here when YOLO finds new matches, or when you add them.";

async function applicationsPage(sw: Worker, page: Page, count = 90, queued = 45) {
  await seed(sw);
  const applications = Array.from({ length: count }, (_, i) =>
    ApplicationSchema.parse({
      key: `history-${i}`,
      url: `https://example.com/history/${i}`,
      company: `History company ${i}`,
      title: "Engineer",
      source: "Lever",
      status: i % 2 ? "failed" : "submitted",
      at: Date.now() - i * 60_000,
    }),
  );
  const yoloQueue = Array.from({ length: queued }, (_, i) =>
    QueueItemSchema.parse({
      key: `queued-${i}`,
      url: `https://example.com/queued/${i}`,
      company: `Queue company ${i}`,
      title: `Queue role ${i}`,
      source: i % 2 ? "Greenhouse" : "Lever",
      location: i === 1 ? "Montréal" : "Remote",
    }),
  );
  await sw.evaluate(async (values) => chrome.storage.local.set(values), { applications, yoloQueue });
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/options/index.html#/applications`);
  await expect(page.getByRole("button", { name: `Queued jobs ${queued}`, exact: true })).toBeVisible();
  return yoloQueue;
}

/** A bulk forget's button: its accessible name ends with how many it removes, which changes as it runs. */
const resumeAllButton = (page: Page, status: string) =>
  page
    .getByRole("group", { name: "Resume all", exact: true })
    .getByRole("button", { name: new RegExp(String.raw`^(${status} \(\d+\)|Queueing resumes…)$`) });
const forgetAllButton = (page: Page, status: string) =>
  page
    .getByRole("group", { name: "Forget all", exact: true })
    .getByRole("button", { name: new RegExp(String.raw`^(${status} \(\d+\)|Forgetting…)$`) });

test("each non-submitted row can be marked submitted while preserving its application details", async ({
  sw,
  page,
}) => {
  await applicationsPage(sw, page, 0, 0);
  const applications = (["submitted", "needs", "failed", "skipped", "review"] as const).map((status) =>
    ApplicationSchema.parse({
      key: status,
      status,
      url: `https://example.com/${status}`,
      company: `Company ${status}`,
      title: "Engineer",
      source: "Lever",
      guesses: [{ q: "Start date?", a: "May" }],
      notes: ["Original note"],
      ...(status === "review" && { review: { reasons: ["Review requested"], preparedAt: 1 } }),
      at: 1,
    }),
  );
  await sw.evaluate((applications) => chrome.storage.local.set({ applications }), applications);
  await expect(page.getByRole("button", { name: "Mark submitted", exact: true })).toHaveCount(4);
  const row = (key: string) =>
    page.getByRole("row").filter({
      has: page.getByRole("link", { name: `Company ${key} – Engineer`, exact: true }),
    });
  await expect(row("submitted").getByRole("button", { name: "Mark submitted", exact: true })).toHaveCount(0);

  for (const original of applications.filter((a) => a.status !== "submitted")) {
    await row(original.key).getByRole("button", { name: "Mark submitted", exact: true }).click();
    await expect(row(original.key)).toContainText("Submitted (by you)");
    await expect(row(original.key).getByRole("button", { name: "Mark submitted", exact: true })).toHaveCount(0);
    const stored = (await storage<Application[]>(sw, "applications")).find((a) => a.key === original.key)!;
    expect(stored).toEqual({
      ...original,
      status: "submitted",
      submittedBy: "user",
      reason: "Marked submitted by you",
      at: expect.any(Number),
    });
    expect(stored.at).toBeGreaterThan(original.at);
  }
  await expect(page.locator("section").getByRole("status")).toHaveCount(0);
  await expect(resumeAllButton(page, "Needs you")).toBeDisabled();
  await expect(forgetAllButton(page, "Failed")).toBeDisabled();
  const totals = page
    .getByRole("definition")
    .locator("..")
    .filter({ has: page.getByText("All time", { exact: true }) });
  await expect(totals).toContainText("5 submitted / 5 attempted");
  expect((await storage<Application[]>(sw, "applications")).find((a) => a.key === "submitted")).toEqual(
    applications[0],
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Mark submitted", exact: true })).toHaveCount(0);
});

test("a failed mark submitted keeps the application status and allows retrying", async ({ sw, page }) => {
  await applicationsPage(sw, page, 2, 0);
  const applications = await storage<Application[]>(sw, "applications");
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((message: { type: string }) =>
      message.type === "YOLO_MARK_SUBMITTED"
        ? Promise.resolve({ error: { kind: "other", message: "Couldn't mark the application submitted." } })
        : send(message)) as typeof chrome.runtime.sendMessage;
  });
  const button = page.getByRole("button", { name: "Mark submitted", exact: true });
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.locator("section").getByRole("status")).toHaveCount(0);
  expect(await storage(sw, "applications")).toEqual(applications);
});

test("forgetting all failed applications requires confirmation and includes filter-hidden failures", async ({
  sw,
  page,
}) => {
  const queue = await applicationsPage(sw, page, 0, 2);
  const applications = [
    { key: "submitted", status: "submitted" },
    { key: "manual", status: "submitted", mode: "manual" },
    { key: "failed", status: "failed" },
    { key: "failed-review", status: "failed", review: { reasons: ["Review requested"], preparedAt: 1 } },
    { key: "review", status: "review" },
    { key: "needs", status: "needs" },
    { key: "skipped", status: "skipped" },
  ].map((app) => ApplicationSchema.parse({ ...app, url: `https://example.com/${app.key}`, company: app.key }));
  await sw.evaluate((applications) => chrome.storage.local.set({ applications }), applications);
  const button = forgetAllButton(page, "Failed");
  await expect(button).toHaveText("Failed (2)");
  await expect(forgetAllButton(page, "Needs you")).toHaveText("Needs you (1)");
  await expect(forgetAllButton(page, "Skipped")).toHaveText("Skipped (1)");
  await page.getByRole("searchbox", { name: "Search applications", exact: true }).fill("submitted");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("submitted");
  await expect(page.locator(".table tbody tr")).toHaveCount(1);

  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain('Forget 2 applications marked "Failed"?');
    expect(dialog.message()).toContain("including those hidden by filters");
    expect(dialog.message()).toContain("YOLO can queue these jobs again");
    await dialog.dismiss();
  });
  await button.click();
  expect(await storage(sw, "applications")).toEqual(applications);
  await expect(button).toBeEnabled();

  page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.locator("section").getByRole("status")).toHaveCount(0);
  const remaining = applications.filter((app) => app.status !== "failed");
  expect(await storage(sw, "applications")).toEqual(remaining);
  expect(await storage(sw, "yoloQueue")).toEqual(queue);
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveValue("submitted");
  await expect(button).toHaveText("Failed (0)");
  await page.reload();
  await expect(button).toBeDisabled();
  expect(await storage(sw, "applications")).toEqual(remaining);

  for (const [label, status] of [
    ["Needs you", "needs"],
    ["Skipped", "skipped"],
  ]) {
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain(`Forget 1 application marked "${label}"?`);
      await dialog.accept();
    });
    await forgetAllButton(page, label).click();
    await expect(forgetAllButton(page, label)).toHaveText(`${label} (0)`);
    await expect(forgetAllButton(page, label)).toBeDisabled();
    remaining.splice(
      remaining.findIndex((app) => app.status === status),
      1,
    );
    expect(await storage(sw, "applications")).toEqual(remaining);
  }
  expect(remaining.map((app) => app.status)).toEqual(["submitted", "submitted", "review"]);
});

test("forget all failed applications is disabled for empty history", async ({ sw, page }) => {
  await applicationsPage(sw, page, 0, 0);
  await expect(forgetAllButton(page, "Failed")).toBeDisabled();
  await expect(forgetAllButton(page, "Needs you")).toBeDisabled();
  await expect(forgetAllButton(page, "Skipped")).toBeDisabled();
  await expect(resumeAllButton(page, "Needs you")).toBeDisabled();
  await expect(resumeAllButton(page, "Ready for your review")).toBeDisabled();
  await expect(resumeAllButton(page, "Failed")).toBeDisabled();
});

test("bulk resume includes hidden Needs you jobs and leaves Ready for your review untouched", async ({
  sw,
  page,
  context,
}) => {
  await applicationsPage(sw, page, 0, 0);
  await seed(sw, { caps: true, settings: { reviewFills: false } });
  const applications = [
    { key: "first", status: "needs" },
    { key: "second", status: "needs" },
    { key: "review", status: "review", review: { reasons: ["Review requested"], preparedAt: 1 } },
    { key: "submitted", status: "submitted" },
    { key: "failed", status: "failed" },
    { key: "skipped", status: "skipped" },
  ].map((app) =>
    ApplicationSchema.parse({
      ...app,
      url: `${BASE}yolo-review-form.html?job=${app.key}`,
      company: app.key,
      title: "Software Engineer Intern",
    }),
  );
  await sw.evaluate(async (applications) => {
    await chrome.storage.local.set({
      applications,
      yolo: { enabled: false, boards: [], feeds: [], reviewFills: false, aiNavigation: false },
    });
  }, applications);
  await page.getByRole("searchbox", { name: "Search applications", exact: true }).fill("submitted");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("submitted");
  const button = resumeAllButton(page, "Needs you");
  await expect(button).toBeEnabled();
  await button.click();
  await expect
    .poll(
      async () => {
        const apps = await storage<Application[]>(sw, "applications");
        return apps.filter((a) => ["first", "second"].includes(a.key)).map((a) => a.status);
      },
      { timeout: 45_000 },
    )
    .toEqual(["submitted", "submitted"]);
  await expect(page.locator("section").getByRole("status")).toHaveCount(0);
  const stored = await storage<Application[]>(sw, "applications");
  for (const key of ["submitted", "failed", "skipped", "review"]) {
    expect(stored.find((a) => a.key === key)).toEqual(applications.find((a) => a.key === key));
  }
  expect(context.pages().some((p) => p.url().includes("job=review"))).toBe(false);
  await expect(button).toBeDisabled();
});

test("bulk resume of Ready for your review refills review tabs and preserves filled ones", async ({
  sw,
  page,
  context,
}) => {
  await applicationsPage(sw, page, 0, 0);
  await seed(sw, { caps: true, settings: { reviewFills: false } });
  const applications = [
    { key: "needs", status: "needs" },
    { key: "review", status: "review", review: { reasons: ["Review requested"], preparedAt: 1 } },
  ].map((app) =>
    ApplicationSchema.parse({
      ...app,
      url: `${BASE}yolo-review-form.html?job=${app.key}`,
      company: app.key,
      title: "Software Engineer Intern",
    }),
  );
  await sw.evaluate(async (applications) => {
    await chrome.storage.local.set({
      applications,
      yolo: { enabled: false, boards: [], feeds: [], reviewFills: false, aiNavigation: false },
    });
  }, applications);
  const button = resumeAllButton(page, "Ready for your review");
  await expect(button).toBeEnabled();
  await button.click();
  await expect
    .poll(async () => {
      const { yoloReviewTabs } = await sw.evaluate(() =>
        chrome.storage.session.get<{ yoloReviewTabs?: Record<string, { ready: boolean }> }>("yoloReviewTabs"),
      );
      return yoloReviewTabs?.review?.ready;
    })
    .toBe(true);
  const stored = await storage<Application[]>(sw, "applications");
  expect(stored.find((a) => a.key === "needs")).toEqual(applications[0]);
  expect(stored.find((a) => a.key === "review")?.status).toBe("review");
  expect(context.pages().some((p) => p.url().includes("job=needs"))).toBe(false);
  const review = context.pages().find((p) => p.url().includes("job=review"))!;
  await expect(review.locator("#first")).toHaveValue("Ada");
  await review.locator("#first").fill("Edited");
  const tabs = context.pages().length;
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.locator("section").getByRole("status")).toHaveCount(0);
  await expect(review.locator("#first")).toHaveValue("Edited");
  expect(context.pages()).toHaveLength(tabs);
});

test("a failed bulk resume keeps pending records and allows retrying", async ({ sw, page }) => {
  await applicationsPage(sw, page, 0, 0);
  const applications = [
    ApplicationSchema.parse({ key: "pending", url: "https://example.com/pending", status: "needs" }),
  ];
  await sw.evaluate((applications) => chrome.storage.local.set({ applications }), applications);
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((message: { type: string }) =>
      message.type === "YOLO_RESUME_PENDING"
        ? Promise.resolve({ error: { kind: "other", message: "Couldn't queue the pending applications." } })
        : send(message)) as typeof chrome.runtime.sendMessage;
  });
  const button = resumeAllButton(page, "Needs you");
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.locator("section").getByRole("status")).toHaveCount(0);
  expect(await storage(sw, "applications")).toEqual(applications);
});

test("a failed bulk forget keeps the history and allows retrying", async ({ sw, page }) => {
  await applicationsPage(sw, page, 2, 0);
  const applications = await storage<Application[]>(sw, "applications");
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((message: { type: string }) =>
      message.type === "YOLO_FORGET_ALL"
        ? Promise.resolve({ error: { kind: "other", message: "Couldn't update the application history." } })
        : send(message)) as typeof chrome.runtime.sendMessage;
  });
  page.once("dialog", (dialog) => dialog.accept());
  const button = forgetAllButton(page, "Failed");
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.locator("section").getByRole("status")).toHaveCount(0);
  expect(await storage(sw, "applications")).toEqual(applications);
  await page.reload();
  page.once("dialog", (dialog) => dialog.accept());
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.locator("section").getByRole("status")).toHaveCount(0);
});

test("application totals separate outcomes, ignore filters, and refresh at local midnight", async ({ sw, page }) => {
  const day = new Date(2026, 10, 7).getTime();
  const tomorrow = new Date(2026, 10, 8).getTime();
  await page.clock.install({ time: new Date(day + 12 * 60 * 60_000) });
  await applicationsPage(sw, page, 0, 0);
  const applications = [
    { key: "submitted", status: "submitted", at: day },
    { key: "manual", status: "submitted", at: day + 1, mode: "manual" },
    { key: "failed", status: "failed", at: day + 2 },
    { key: "review", status: "review", at: day + 3 },
    { key: "needs", status: "needs", at: day + 4 },
    { key: "skipped", status: "skipped", at: day + 5 },
    { key: "yesterday-submitted", status: "submitted", at: day - 1 },
    { key: "yesterday-failed", status: "failed", at: day - 2 },
    { key: "yesterday-skipped", status: "skipped", at: day - 3 },
  ].map((app) => ApplicationSchema.parse({ ...app, url: `https://example.com/${app.key}`, company: app.key }));
  await sw.evaluate((applications) => chrome.storage.local.set({ applications }), applications);
  const summary = page.getByRole("definition").locator("..");
  const today = summary.filter({ has: page.getByText("Today", { exact: true }) }).first();
  const allTime = summary.filter({ has: page.getByText("All time", { exact: true }) }).first();
  await expect(today).toContainText("2 submitted / 5 attempted");
  await expect(today).toContainText("1 failed · 2 pending");
  await expect(allTime).toContainText("3 submitted / 7 attempted");
  await expect(allTime).toContainText("2 failed · 2 pending");

  await page.getByRole("searchbox", { name: "Search applications", exact: true }).fill("no match");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("submitted");
  await expect(page.getByText("No matches.", { exact: true })).toBeVisible();
  await expect(today).toContainText("2 submitted / 5 attempted");
  await expect(allTime).toContainText("3 submitted / 7 attempted");

  await page.clock.fastForward(tomorrow - (day + 12 * 60 * 60_000));
  await expect(today).toContainText("0 submitted / 0 attempted");
  await expect(today).toContainText("0 failed");
  await expect(today).not.toContainText("pending");
  await expect(allTime).toContainText("3 submitted / 7 attempted");

  const updated = applications.map((app) =>
    app.key === "review" ? { ...app, status: "submitted" as const, at: tomorrow } : app,
  );
  await sw.evaluate((applications) => chrome.storage.local.set({ applications }), updated);
  await expect(today).toContainText("1 submitted / 1 attempted");
  await expect(allTime).toContainText("4 submitted / 7 attempted");
  await expect(allTime).toContainText("2 failed · 1 pending");

  await sw.evaluate(() => chrome.storage.local.set({ applications: [] }));
  await expect(today).toContainText("0 submitted / 0 attempted");
  await expect(allTime).toContainText("0 submitted / 0 attempted");
  await expect(allTime).toContainText("0 failed");
});

test("queue access stays visible through a long history and preserves the user's place", async ({ sw, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await applicationsPage(sw, page);
  const trigger = page.getByRole("button", { name: "Queued jobs 45", exact: true });
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  await expect(panel).not.toBeVisible();
  await expect(page.locator(".queued-jobs li")).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search applications", exact: true }).fill("History company");
  await page.getByRole("combobox", { name: "Status", exact: true }).selectOption("submitted");
  await expect(page.locator(".table tbody tr")).toHaveCount(45);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  const scroll = await page.evaluate(() => window.scrollY);
  expect(scroll).toBeGreaterThan(500);
  await expect(trigger).toBeInViewport();
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("searchbox", { name: "Search queued jobs" })).toBeFocused();
  await expect(panel.getByRole("listitem")).toHaveCount(45);
  await panel.locator(".queue-panel-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(panel.getByRole("heading", { name: "Queued jobs" })).toBeInViewport();
  const clear = panel.getByRole("button", { name: "Clear queue", exact: true });
  await expect(clear).toBeInViewport();
  const search = panel.getByRole("searchbox", { name: "Search queued jobs" });
  await search.focus();
  await page.keyboard.press("Tab");
  await expect(panel.getByRole("link").first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  const close = panel.getByRole("button", { name: "Close queued jobs" });
  await expect(close).toBeFocused();
  // The modal makes the underlying application controls inert, even to programmatic focus.
  await page.locator("input.search").evaluate((el) => (el as HTMLInputElement).focus());
  await expect(close).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(scroll, 0);
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(scroll, 0);
  await expect(page.getByRole("searchbox", { name: "Search applications", exact: true })).toHaveValue(
    "History company",
  );
  await expect(page.getByRole("combobox", { name: "Status", exact: true })).toHaveValue("submitted");
  await trigger.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(16, 40);
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.locator(".queued-jobs li")).toHaveCount(0);
});

test("queue search and removal preserve other jobs; Clear queue also clears search-hidden jobs", async ({
  sw,
  page,
}) => {
  await applicationsPage(sw, page, 2, 3);
  await page.getByRole("button", { name: "Queued jobs 3", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  const search = panel.getByRole("searchbox", { name: "Search queued jobs" });
  await search.fill("gREenhouse");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await search.fill("montreal");
  await expect(panel.getByRole("status")).toHaveText("Showing 1 of 3 queued jobs");
  const link = panel.getByRole("link", { name: "Queue company 1 – Queue role 1", exact: true });
  await expect(link).toHaveAttribute("href", "https://example.com/queued/1");
  await expect(link).toHaveAttribute("target", "_blank");
  await panel
    .getByRole("button", { name: "Remove Queue company 1 – Queue role 1 from the queue", exact: true })
    .click();
  await expect(panel.getByText("No queued jobs match your search.", { exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  expect((await storage<QueueItem[]>(sw, "yoloQueue")).map((i) => i.key)).toEqual(["queued-0", "queued-2"]);
  await panel.getByRole("button", { name: "Clear queue", exact: true }).click();
  await expect(panel.getByText(EMPTY_QUEUE_TEXT, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Clear queue", exact: true })).toBeDisabled();
  expect(await storage(sw, "yoloQueue")).toEqual([]);
  expect(await storage<unknown[]>(sw, "applications")).toHaveLength(2);
  await panel.getByRole("button", { name: "Close queued jobs" }).click();
  await expect(page.getByRole("button", { name: "Queued jobs 0", exact: true })).toBeFocused();
});

test("an empty queue stays accessible and storage updates never open the panel", async ({ sw, page }) => {
  const [job] = await applicationsPage(sw, page, 0, 1);
  await sw.evaluate(() => chrome.storage.local.set({ yoloQueue: [] }));
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  await page.getByRole("button", { name: "Queued jobs 0", exact: true }).click();
  await expect(panel.getByText(EMPTY_QUEUE_TEXT, { exact: true })).toBeVisible();
  const addForm = panel.getByRole("form", { name: "Add jobs to the queue", exact: true });
  await expect(addForm).toBeVisible();
  await expect(addForm.getByRole("textbox", { name: "Job posting links", exact: true })).toBeFocused();
  // Escape closes the nested add form first, then the queue dialog.
  await page.keyboard.press("Escape");
  await expect(addForm).not.toBeVisible();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Add jobs", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Queued jobs 0", exact: true })).toBeFocused();
  await sw.evaluate((item) => chrome.storage.local.set({ yoloQueue: [item] }), job);
  const trigger = page.getByRole("button", { name: "Queued jobs 1", exact: true });
  await expect(trigger).toBeVisible();
  await expect(panel).not.toBeVisible();
  await trigger.click();
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await sw.evaluate(() => chrome.storage.local.set({ yoloQueue: [] }));
  await expect(panel).toBeVisible();
  await expect(panel.getByText(EMPTY_QUEUE_TEXT, { exact: true })).toBeVisible();
  // Browser navigation can unmount an open modal; its scroll lock must be released.
  await page.evaluate(() => (location.hash = "/behavior"));
  await expect(page.getByRole("heading", { name: "Behavior", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.style.overflow)).not.toBe("hidden");
});

test("the queue fits a narrow dark viewport and keeps its controls reachable", async ({ sw, page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.emulateMedia({ colorScheme: "dark" });
  await applicationsPage(sw, page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const trigger = page.getByRole("button", { name: "Queued jobs 45", exact: true });
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await trigger.click();
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
  expect(box.height).toBe(740);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(panel.getByRole("button", { name: "Clear queue", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath("queued-jobs-mobile.png") });
  await panel.getByRole("button", { name: "Close queued jobs" }).click();
  await expect(panel).not.toBeVisible();
});

test("a failed queue update keeps the jobs and allows retrying", async ({ sw, page }) => {
  await applicationsPage(sw, page, 0, 1);
  await page.getByRole("button", { name: "Queued jobs 1", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Queued jobs", exact: true });
  await page.evaluate(() => {
    chrome.storage.local.set = async () => {
      throw new Error("Storage unavailable");
    };
  });
  await panel
    .getByRole("button", { name: "Remove Queue company 0 – Queue role 0 from the queue", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toHaveText("Couldn't update the queue. Please try again.");
  await expect(panel.getByRole("listitem")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Clear queue", exact: true })).toBeEnabled();
  expect(await storage<QueueItem[]>(sw, "yoloQueue")).toHaveLength(1);
});
