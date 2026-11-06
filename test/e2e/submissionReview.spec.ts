import type { Page, Worker } from "@playwright/test";
import type { Application } from "../../src/shared/yolo";
import { FAILURES } from "../mockGemini";
import { BASE, expect, seed, storage, test } from "./extension";

async function start(sw: Worker, review: Record<string, unknown>, paths = ["yolo-review-form.html"], extra = {}) {
  await seed(sw, { caps: true, settings: { reviewFills: false } });
  await sw.evaluate(
    async ({ review, paths, base, extra }) => {
      await chrome.storage.local.set({
        yoloQueue: paths.map((path, i) => ({
          key: `${base}${path}`,
          alt: "",
          listing: "",
          url: `${base}${path}`,
          company: "Acme",
          title: "Software Engineer Intern",
          location: "Vancouver",
          source: "careers",
          postedAt: i + 1,
          addedAt: i + 1,
        })),
        yolo: {
          enabled: true,
          queries: ["software intern"],
          boards: [],
          feeds: [],
          reviewFills: false,
          aiNavigation: false,
          submissionReview: review,
          ...extra,
        },
      });
    },
    { review, paths, base: BASE, extra },
  );
}

const apps = (sw: Worker) => storage<Application[] | undefined>(sw, "applications");
async function action(sw: Worker, page: Page, type: string, key: string) {
  if (!page.url().startsWith("chrome-extension://"))
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/options/index.html#/applications`);
  return page.evaluate(({ type, key }) => chrome.runtime.sendMessage({ type, key }), { type, key });
}

test("retains a filled page and uploads, allows edits and validation, then records one manual submission", async ({
  sw,
  context,
  page,
  mock,
}) => {
  await start(sw, { mode: "all" });
  await expect.poll(async () => (await apps(sw))?.[0]?.status).toBe("review");
  const [a] = (await apps(sw))!;
  const review = context.pages().find((p) => p.url().includes("yolo-review-form"))!;
  await expect(review.locator("#first")).toHaveValue("Ada");
  expect(await review.locator("#resume").evaluate((e) => (e as HTMLInputElement).files?.length)).toBe(1);
  await expect(review.locator("#trap")).toHaveValue("");
  const calls = mock.calls.length;
  const pages = context.pages().length;
  expect(await action(sw, page, "YOLO_REVIEW_OPEN", a.key)).toEqual({ ok: true });
  expect(context.pages().length).toBe(pages);
  await review.locator("#first").fill("Augusta");
  await review.locator("#email").fill("");
  await review.locator("#submit").click();
  expect((await apps(sw))![0].status).toBe("review");
  await review.locator("#email").fill("ada@example.com");
  await review.locator("#submit").click();
  await expect(review).toHaveURL(/yolo-thanks/);
  await expect.poll(async () => (await apps(sw))?.[0]?.status).toBe("submitted");
  const saved = (await apps(sw))!;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ key: a.key, mode: "yolo", submittedBy: "user", review: a.review });
  expect(await review.evaluate(() => sessionStorage.getItem("review-submitted"))).toBe("Augusta");
  expect(mock.calls.length).toBe(calls);
  void page;
});

test("holds a final Submit even when a stable Workday Next selector identifies it", async ({ sw }) => {
  await start(sw, { mode: "all" }, ["yolo-review-form.html?workday=1"]);
  await expect.poll(async () => (await apps(sw))?.[0]?.status).toBe("review");
});

test("source matching leaves other applications on the automatic path", async ({ sw }) => {
  await start(sw, { mode: "matching", sources: ["feeds"] });
  await expect.poll(async () => (await apps(sw))?.[0]?.status).toBe("submitted");
});

test("only actual guesses trigger review; ordinary profile answers submit normally", async ({ sw }) => {
  await start(sw, { mode: "matching", guessedAnswers: true }, [
    "yolo-review-form.html?guess=1",
    "yolo-review-form.html",
  ]);
  await expect.poll(async () => (await apps(sw))?.length).toBe(2);
  const all = (await apps(sw))!;
  expect(all.find((a) => a.url.includes("guess"))?.status).toBe("review");
  expect(all.find((a) => !a.url.includes("guess"))?.status).toBe("submitted");
});

test("review limit pauses the queue; dismissal resumes, and ready applications also consume batch slots", async ({
  sw,
  page,
}) => {
  await start(
    sw,
    { mode: "all", maxPending: 1 },
    ["yolo-review-form.html?one", "yolo-review-form.html?two", "yolo-review-form.html?three"],
    { batchSize: 2 },
  );
  await expect.poll(async () => (await apps(sw))?.length).toBe(1);
  await expect
    .poll(async () => (await storage<{ pauseReason: string }>(sw, "yoloState")).pauseReason)
    .toContain("Review limit reached");
  await action(sw, page, "YOLO_REVIEW_DISMISS", (await apps(sw))![0].key);
  await expect.poll(async () => (await apps(sw))?.length).toBe(2);
  await action(sw, page, "YOLO_REVIEW_MARK_SUBMITTED", (await apps(sw))![1].key);
  await expect
    .poll(async () => (await storage<{ pauseReason: string }>(sw, "yoloState")).pauseReason)
    .toBe("Batch done");
  expect(await storage<unknown[]>(sw, "yoloQueue")).toHaveLength(1);
});

test("lost tabs refill only on request, remain manual when YOLO is off, and retain the original record", async ({
  sw,
  context,
  page,
}) => {
  await start(sw, { mode: "all" });
  await expect.poll(async () => (await apps(sw))?.[0]?.status).toBe("review");
  const [a] = (await apps(sw))!;
  await context
    .pages()
    .find((p) => p.url().includes("yolo-review-form"))!
    .close();
  await sw.evaluate(async () => {
    const { yolo } = (await chrome.storage.local.get("yolo")) as { yolo: Record<string, unknown> };
    await chrome.storage.local.set({ yolo: { ...yolo, enabled: false, submissionReview: { mode: "off" } } });
  });
  expect((await action(sw, page, "YOLO_REVIEW_OPEN", a.key)).error).toBeTruthy();
  await action(sw, page, "YOLO_REVIEW_REFILL", a.key);
  await expect
    .poll(async () => (await page.evaluate(() => chrome.runtime.sendMessage({ type: "YOLO_REVIEW_LIST" }))).live)
    .toContain(a.key);
  expect((await apps(sw))!).toHaveLength(1);
  expect((await apps(sw))![0]).toMatchObject({ key: a.key, status: "review", review: a.review });
});

test("YOLO settings expose independent human review controls and save source combinations", async ({ sw, page }) => {
  await seed(sw, { caps: true });
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/options/index.html#/yolo`);
  await page.getByLabel("Require my review", { exact: true }).selectOption("matching");
  await expect(page.locator(".review-summary[role=status]")).toContainText("Select at least one review rule");
  await page.getByRole("checkbox", { name: "GitHub job lists", exact: true }).check();
  await page.getByRole("checkbox", { name: "Company career sites", exact: true }).check();
  await page.getByLabel("Company ranking", { exact: true }).selectOption("1000");
  await expect(page.locator(".review-summary[role=status]")).toContainText("Review when any rule matches");
  await expect
    .poll(async () => (await storage<{ submissionReview: { sources: string[] } }>(sw, "yolo")).submissionReview.sources)
    .toEqual(["feeds", "careers"]);
});

test("completes account creation and every form step before handing over the review page", async ({ sw, context }) => {
  test.setTimeout(120_000);
  await start(sw, { mode: "all" }, ["yolo-job.html"], { aiNavigation: true });
  await expect.poll(async () => (await apps(sw))?.[0]?.status, { timeout: 90_000 }).toBe("review");
  const review = context.pages().find((p) => p.url().includes("yolo-apply"))!;
  await expect(review.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Submit application" })).toBeEnabled();
  expect((await apps(sw))![0].guesses).toContainEqual({ q: "Do you have any offer deadlines?", a: "No" });
  expect(await storage<Record<string, unknown>>(sw, "vault")).toHaveProperty("localhost");
});

for (const purpose of ["final_submit", "next_step"] as const) {
  test(`AI navigation cannot submit a protected application (${purpose})`, async ({ sw, mock }) => {
    mock.navigation = (payload) => {
      const ref = /\[(c\d+) [^\]\n]*"Deliver my candidacy"/.exec(String(payload.page))?.[1];
      return ref
        ? { action: "click", state: "form", ref, purpose, reason: "The last application action" }
        : { action: "stop", state: "other", reason: "Missing test button" };
    };
    await start(sw, { mode: "all" }, ["yolo-review-form.html?nav=1"], { aiNavigation: true });
    await expect.poll(async () => (await apps(sw))?.[0]?.status).toBe(purpose === "final_submit" ? "review" : "needs");
    expect((await apps(sw))![0].doneUrl).toBe("");
    expect(mock.calls_("navigate")).toHaveLength(1);
  });
}

test("refreshing a review tab never starts YOLO and exposes explicit refill", async ({ sw, page, context }) => {
  await start(sw, { mode: "all" });
  await expect.poll(async () => (await apps(sw))?.[0]?.status).toBe("review");
  const [a] = (await apps(sw))!;
  const review = context.pages().find((p) => p.url().includes("yolo-review-form"))!;
  await review.reload();
  await expect(review.locator("#first")).toHaveValue("");
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/src/options/index.html#/applications`);
  await expect(page.getByRole("button", { name: "Refill for review", exact: true })).toBeVisible();
  expect((await apps(sw))![0]).toMatchObject({ key: a.key, status: "review" });
  expect(await sw.evaluate(async () => (await chrome.storage.session.get("yoloRun")).yoloRun)).toBeUndefined();
});

test("a quota-stopped refill stays protected after review settings are turned off", async ({
  sw,
  page,
  context,
  mock,
}) => {
  await start(sw, { mode: "all" }, ["yolo-review-form.html?guess=1"]);
  await expect.poll(async () => (await apps(sw))?.[0]?.status).toBe("review");
  const [a] = (await apps(sw))!;
  await context
    .pages()
    .find((p) => p.url().includes("yolo-review-form"))!
    .close();
  await sw.evaluate(async () => {
    const { yolo } = (await chrome.storage.local.get("yolo")) as { yolo: Record<string, unknown> };
    await chrome.storage.local.set({ yolo: { ...yolo, submissionReview: { mode: "off" } } });
  });
  mock.always = () => FAILURES.daily;
  await action(sw, page, "YOLO_REVIEW_REFILL", a.key);
  await expect
    .poll(async () => (await storage<{ pauseReason: string }>(sw, "yoloState")).pauseReason)
    .toBe("AI usage limit reached");
  expect((await apps(sw))![0]).toMatchObject({ key: a.key, status: "review", review: a.review });
  expect(await storage<unknown[]>(sw, "yoloQueue")).toEqual([]);
  expect((await page.evaluate(() => chrome.runtime.sendMessage({ type: "YOLO_REVIEW_LIST" }))).refilling).toContain(
    a.key,
  );
});
