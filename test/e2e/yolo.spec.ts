// YOLO mode end to end in the built extension: a queued job applied to in the hidden host, with the Gemini mock.
import type { Worker } from "@playwright/test";
import type { Application } from "../../src/shared/yolo";
import { EXPERIENCE } from "../mockGemini";
import { BASE, expect, fillPage, PROFILE, seed, storage, test, waitDone } from "./extension";

const queue = (sw: Worker, url: string, yolo: Record<string, unknown> = {}) =>
  sw.evaluate(
    async ({ url, yolo }) => {
      await chrome.storage.local.set({
        yoloQueue: [
          {
            key: url,
            alt: "",
            url,
            company: "Acme",
            title: "Software Engineer Intern",
            location: "Vancouver",
            source: "test",
            postedAt: 1,
            addedAt: 1,
          },
        ],
        // Turning it on starts the queue; no feeds or boards, so nothing is fetched.
        yolo: {
          enabled: true,
          queries: ["Software Engineer Intern"],
          feeds: [],
          boards: [],
          aiRelevanceCheck: false,
          ...yolo,
        },
      });
    },
    { url, yolo },
  );

const outcome = (sw: Worker) =>
  expect.poll(async () => (await storage<Application[] | undefined>(sw, "applications"))?.[0]?.status, {
    timeout: 90_000,
    intervals: [500],
  });

test("with review and navigation off, waits through multiple rendering stages as main does", async ({ sw, mock }) => {
  test.setTimeout(60_000);
  await seed(sw, { caps: true, settings: { reviewFills: false } });
  await queue(sw, `${BASE}yolo-delayed-form.html`, { reviewFills: false, aiNavigation: false, tabFallback: false });
  await expect
    .poll(async () => (await storage<Application[] | undefined>(sw, "applications"))?.[0], { timeout: 30_000 })
    .toBeTruthy();
  const [application] = await storage<Application[]>(sw, "applications");
  expect(application, JSON.stringify(application)).toMatchObject({ status: "submitted" });
  expect(mock.calls_("review")).toHaveLength(0);
  expect(mock.calls_("navigate")).toHaveLength(0);
});

for (const reviewFills of [false, true]) {
  test(`applies to a queued job with YOLO review ${reviewFills ? "on" : "off"} and manual review ${reviewFills ? "off" : "on"}`, async ({
    context,
    sw,
    page,
    mock,
  }) => {
    test.setTimeout(120_000);
    await seed(sw, { caps: true, settings: { reviewFills: !reviewFills } });
    const pages = context.pages().length;
    await queue(sw, `${BASE}yolo-job.html`, { reviewFills, aiNavigation: !reviewFills });
    await outcome(sw).toBe("submitted");
    const [a] = await storage<Application[]>(sw, "applications");
    expect(a).toMatchObject({ mode: "yolo", company: "Acme", reason: "" });
    expect(a.doneUrl).toContain("yolo-thanks.html");
    // Made-up answers are logged for review; profile answers are not.
    expect(a.guesses).toEqual([{ q: "Do you have any offer deadlines?", a: "No" }]);
    expect(mock.calls_("guess")).toHaveLength(1);
    expect(mock.calls_("essay").length).toBeGreaterThan(0);
    expect(mock.calls_("review").length > 0).toBe(reviewFills);
    expect(mock.calls_("navigate")).toHaveLength(0);
    // An account was made for the site, its password kept encrypted.
    const vault = await storage<Record<string, { email: string; ct: string }>>(sw, "vault");
    expect(Object.keys(vault)).toEqual(["localhost"]);
    expect(vault.localhost.email).toBe("ada@example.com");
    expect(context.pages().length).toBe(pages);
    void page;
    // Done: the hidden page's renderer is let go.
    await expect.poll(() => sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
  });
}

test("opens a job-detail Apply CTA even when page chrome has several fields", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true });
  void page;
  await queue(sw, `${BASE}yolo-job-with-controls.html`);
  await outcome(sw).toBe("submitted");
});

test("opens a posting beside a required talent community signup", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true });
  void page;
  await queue(sw, `${BASE}yolo-job-with-community.html`);
  await outcome(sw).toBe("submitted");
});

test("answers a field the page rejected though it wasn't marked required", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true });
  void page;
  await queue(sw, `${BASE}yolo-optional-marked.html`);
  await outcome(sw).toBe("submitted");
  // Guessed on the page the submit left: still logged for review.
  const [a] = await storage<Application[]>(sw, "applications");
  expect(a.guesses).toEqual([{ q: "Which team are you most interested in?", a: "Payments" }]);
});

test("waits out a rate limit on a drafted cover letter instead of handing the job to the user", async ({
  sw,
  page,
  mock,
}) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true, settings: { debugLogging: true } });
  void page;
  // Drafts turned down on every key for the next 6 s, as a per-minute quota does.
  let until = 0;
  mock.always = (_key, _model, kind) =>
    kind === "essay" && (until ||= Date.now() + 6000) > Date.now()
      ? {
          status: 429,
          body: {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "You exceeded your current quota.",
              details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "6s" }],
            },
          },
        }
      : null;
  await queue(sw, `${BASE}yolo-cover-letter.html`);
  await outcome(sw).toBe("submitted");
  // The debug log names what was uploaded and keeps the letter's PDF.
  const log = (await storage<{ text: string; files?: { name: string; base64: string }[] }[]>(sw, "yoloLogs")).at(-1)!;
  expect(log.text).toContain("Résumé: None");
  expect(log.text).toMatch(/Cover letter: Generated \(\w+_Cover_Letter\.pdf\)/);
  expect(log.files).toEqual([{ name: expect.stringMatching(/_Cover_Letter\.pdf$/), base64: expect.any(String) }]);
  expect(atob(log.files![0].base64)).toMatch(/^%PDF/);
});

test("asks for pay from the posting's range after Apply leads to another page", async ({ sw, page }) => {
  test.setTimeout(120_000);
  const desiredCompensation = { amount: "20", currency: "CAD", period: "hour", strategy: "q1" };
  const profile = { ...PROFILE, preferences: { ...PROFILE.preferences, desiredCompensation } };
  await seed(sw, { caps: true, profile, settings: { debugLogging: true } });
  void page;
  await queue(sw, `${BASE}yolo-job-pay.html`);
  await outcome(sw).toBe("submitted");
  const logs = await storage<{ text: string }[]>(sw, "yoloLogs");
  expect(logs.at(-1)?.text).toContain("Desired hourly pay = $42.50");
});

test("corrects a site's preselected country to the profile's", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true, settings: { debugLogging: true } });
  void page;
  await queue(sw, `${BASE}yolo-default-country.html`);
  await outcome(sw).toBe("submitted");
  const logs = await storage<{ text: string }[]>(sw, "yoloLogs");
  expect(logs.at(-1)?.text).toContain("Province = British Columbia");
});

test("queues a job again when short rate limits keep coming", async ({ sw, page, mock }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true });
  void page;
  // Every mapping call turned down, each time with a retry allowed in a second.
  mock.always = (_key, _model, kind) =>
    kind === "map"
      ? {
          status: 429,
          body: {
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              message: "You exceeded your current quota.",
              details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" }],
            },
          },
        }
      : null;
  await queue(sw, `${BASE}yolo-reveal.html`);
  await expect
    .poll(async () => (await storage<{ pauseReason: string }>(sw, "yoloState"))?.pauseReason, { timeout: 90_000 })
    .toBe("AI usage limit reached");
  expect((await storage<unknown[]>(sw, "applications")) ?? []).toEqual([]);
  expect(await storage<unknown[]>(sw, "yoloQueue")).toHaveLength(1);
});

test("opens a posting whose application is collapsed in the page", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true, settings: { debugLogging: true } });
  void page;
  await queue(sw, `${BASE}yolo-collapsed.html`);
  await outcome(sw).toBe("submitted");
  const logs = await storage<{ text: string }[]>(sw, "yoloLogs");
  expect(logs.at(-1)?.text).toContain("Steps: job → form → success");
  // A résumé uploaded untailored is named by its document's label.
  expect(logs.at(-1)?.text).toContain("Résumé: Résumé\nCover letter: None");
});

test("fills again a field the page rejected, though it holds what we typed", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true });
  void page;
  await queue(sw, `${BASE}yolo-rejected-place.html`);
  await outcome(sw).toBe("submitted");
});

test("replaces the work entries a site's résumé parser wrote with the profile's", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true, settings: { debugLogging: true }, profile: { ...PROFILE, experience: EXPERIENCE } });
  void page;
  await queue(sw, `${BASE}yolo-parsed-entries.html`);
  await outcome(sw).toBe("submitted");
  const text = (await storage<{ text: string }[]>(sw, "yoloLogs")).at(-1)!.text;
  for (const want of ["Analytical Engines Ltd", "Software Engineer Intern", "Built analytics tooling.", "2026-01-01"])
    expect(text).toContain(`= ${want} [`);
  for (const want of ["Babbage & Co", "IT Technician Intern", "Kept the lab running.", "2023-06-01", "2023-08-01"])
    expect(text).toContain(`= ${want} [`);
  // The project listed as a job, and the third entry for a profile with two, are gone; no parsed value is kept.
  for (const parsed of [
    "Difference Engine",
    "Title Unknown",
    "A side project.",
    "Built tools.",
    "Fixed things.",
    "2026-04-01",
  ])
    expect(text).not.toContain(parsed);
  expect(text).not.toContain("[prefilled]");
});

test("refills a site's fixed work slots from the profile and empties the one past it", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true, settings: { debugLogging: true }, profile: { ...PROFILE, experience: EXPERIENCE } });
  void page;
  await queue(sw, `${BASE}yolo-parsed-slots.html`);
  await outcome(sw).toBe("submitted");
  const text = (await storage<{ text: string }[]>(sw, "yoloLogs")).at(-1)!.text;
  const rows = text
    .split("\n")
    .map((l) => l.trim().replace(/ \[\w+\]$/, ""))
    .filter((l) => /^(Employer|Title|Start Date Month|Start Date Year) = /.test(l));
  expect(rows.sort()).toEqual(
    [
      "Employer = Analytical Engines Ltd",
      "Title = Software Engineer Intern",
      "Start Date Month = Jan",
      "Start Date Year = 2026",
      "Employer = Babbage & Co",
      "Title = IT Technician Intern",
      "Start Date Month = Jun",
      "Start Date Year = 2023",
      "Employer = (blank)",
      "Title = (blank)",
      "Start Date Month = (blank)",
      "Start Date Year = (blank)",
    ].sort(),
  );
});

test("hands a CAPTCHA to the user instead of trying it, after a background tab", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true });
  void page;
  await queue(sw, `${BASE}yolo-captcha.html`);
  await outcome(sw).toBe("needs");
  const [a] = await storage<Application[]>(sw, "applications");
  expect(a.reason).toBe("CAPTCHA");
  // The hidden frame met the bot check: the site's later jobs start in a tab.
  expect(await storage(sw, "yoloTabHosts")).toEqual(["localhost"]);
});

test("hands a DataDome CAPTCHA to the user instead of failing the hidden run", async ({ sw, page }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true });
  void page;
  await queue(sw, `${BASE}yolo-datadome-captcha.html`);
  await outcome(sw).toBe("needs");
  const [a] = await storage<Application[]>(sw, "applications");
  expect(a.reason).toBe("CAPTCHA");
});

test("stops at the batch size", async ({ sw, page }) => {
  await seed(sw, { caps: true });
  void page;
  await queue(sw, `${BASE}yolo-job.html`, { batchSize: 0 });
  await expect
    .poll(async () => (await storage<{ pauseReason: string }>(sw, "yoloState"))?.pauseReason)
    .toBe("Batch done");
  expect(await storage(sw, "yoloQueue")).toHaveLength(1);
});

test("force starts a fresh batch from the popup and schedules the next one a full interval later", async ({
  sw,
  page,
}) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true });
  await sw.evaluate(async () => {
    const batchAt = Date.now() - 60_000;
    await chrome.storage.local.set({
      yoloState: { batchAt },
      applications: [{ key: "previous", url: "https://example.com/previous", status: "submitted", at: batchAt + 1 }],
    });
  });
  await queue(sw, `${BASE}yolo-job.html`, { batchSize: 1, intervalMin: 120 });
  await expect
    .poll(async () => (await storage<{ pauseReason: string }>(sw, "yoloState"))?.pauseReason)
    .toBe("Batch done");
  // Give the old schedule a different deadline so retaining it would fail the test.
  await sw.evaluate(() => chrome.alarms.create("yolo", { delayInMinutes: 30, periodInMinutes: 120 }));
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  const toggle = page.getByRole("switch", { name: "YOLO Mode" });
  await expect(toggle).toBeChecked();
  await expect(toggle).toContainText("1/1 applied this batch");

  const before = await sw.evaluate(() => Date.now());
  await page.getByRole("button", { name: "Force start batch" }).click();
  await expect
    .poll(async () => (await storage<{ batchAt: number }>(sw, "yoloState")).batchAt)
    .toBeGreaterThanOrEqual(before);
  const { batchAt } = await storage<{ batchAt: number }>(sw, "yoloState");
  const alarm = await sw.evaluate(() => chrome.alarms.get("yolo"));
  expect(alarm).toMatchObject({ scheduledTime: batchAt + 120 * 60_000, periodInMinutes: 120 });
  expect(await storage(sw, "yolo")).toMatchObject({ enabled: true, intervalMin: 120, batchSize: 1 });
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await storage<Application[]>(sw, "applications")).length, { timeout: 90_000 }).toBe(2);
  const apps = await storage<Application[]>(sw, "applications");
  expect(apps.find((a) => a.key === "previous")?.status).toBe("submitted");
  expect(apps.find((a) => a.key !== "previous")).toMatchObject({ status: "submitted", mode: "yolo" });
  await page.reload();
  await expect(toggle).toContainText("1/1 applied this batch");

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Force start batch" })).toHaveCount(0);
  expect(await sw.evaluate(() => chrome.alarms.get("yolo"))).toBeUndefined();
});

test("force starts a batch during discovery while preserving an AI usage pause", async ({ context, sw, page }) => {
  await seed(sw, { caps: true });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const discovering = new Promise<void>((resolve) => (started = resolve));
  let requests = 0;
  await context.route("https://autoapply.test/jobs.json", async (route) => {
    requests++;
    started();
    await held;
    await route.fulfill({ contentType: "application/json", body: "[]" });
  });
  await queue(sw, `${BASE}yolo-job.html`, {
    batchSize: 0,
    intervalMin: 120,
    feeds: ["https://autoapply.test/jobs.json"],
  });
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "YOLO_CHECK_NOW" }));
  await discovering;
  const pausedUntil = await sw.evaluate(async () => {
    const pausedUntil = Date.now() + 60_000;
    const { yoloState } = await chrome.storage.local.get("yoloState");
    await chrome.storage.local.set({
      yoloState: { ...(yoloState as object), pausedUntil, pauseReason: "AI usage limit reached" },
    });
    return pausedUntil;
  });
  const before = await sw.evaluate(() => Date.now());
  try {
    await page.getByRole("button", { name: "Force start batch" }).click();
    await expect
      .poll(async () => (await storage<{ batchAt: number }>(sw, "yoloState")).batchAt)
      .toBeGreaterThanOrEqual(before);
    expect(await storage(sw, "yoloState")).toMatchObject({ pausedUntil, pauseReason: "AI usage limit reached" });
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect
    .poll(async () => (await storage<{ lastCheckAt: number }>(sw, "yoloState")).lastCheckAt)
    .toBeGreaterThanOrEqual(before);
  expect(await storage(sw, "yoloState")).toMatchObject({ pausedUntil, pauseReason: "AI usage limit reached" });
  expect(await storage(sw, "yoloQueue")).toHaveLength(1);
});

test("force batch requires YOLO to be on with a search and leaves its off state alone", async ({ sw, page }) => {
  await seed(sw, { caps: true });
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  for (const yolo of [
    { enabled: false, queries: ["x"] },
    { enabled: true, queries: [] },
  ]) {
    await sw.evaluate(async (yolo) => {
      await chrome.storage.local.set({ yolo: { ...yolo, feeds: [], boards: [] } });
    }, yolo);
    const r = await page.evaluate(() => chrome.runtime.sendMessage({ type: "YOLO_FORCE_BATCH" }));
    expect(r.error.message).toMatch(/Turn on YOLO with a job search/);
    expect(await storage(sw, "yolo")).toMatchObject(yolo);
    expect(await sw.evaluate(() => chrome.alarms.get("yolo"))).toBeUndefined();
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "Force start batch" })).toHaveCount(0);
});

test("with YOLO off, a fill leaves no alarm or hidden page behind", async ({ sw, page }) => {
  await seed(sw, { caps: true });
  await page.goto(`${BASE}plain.html`);
  await fillPage(page, sw);
  await waitDone(page);
  expect(await sw.evaluate(() => chrome.alarms.getAll())).toEqual([]);
  expect(await sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
});

test("logs the user's own submission after a fill, and warns on jobs YOLO applied to", async ({ sw, page }) => {
  await seed(sw, { caps: true });
  // The thanks page confirms the application YOLO-style forms send there.
  await page.goto(`${BASE}yolo-apply.html`);
  await fillPage(page, sw);
  await waitDone(page);
  await page.locator("#pw").fill("pw");
  await page.locator("#pw2").fill("pw");
  await page.locator("#tos").check();
  await page.getByRole("button", { name: "Create Account" }).click();
  for (const [heading, button] of [
    ["My Information", "Next"],
    ["Application Questions", "Review"],
    ["Review", "Submit application"],
  ]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await fillPage(page, sw);
    // The panel still says "Done" from the step before: wait for this step's fields instead.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLInputElement>("[required]")].filter((el) =>
              el.type === "file" ? !el.files?.length : el.type !== "radio" && el.type !== "checkbox" && !el.value,
            ).length,
        ),
      )
      .toBe(0);
    // Outside YOLO, what the profile can't answer is left to the user.
    if (heading === "My Information") await page.locator("input[name=dl][value=no]").check();
    await page.getByRole("button", { name: button, exact: true }).click();
  }
  await page.waitForURL(/yolo-thanks/);
  await expect
    .poll(async () => (await storage<Application[] | undefined>(sw, "applications"))?.[0]?.mode, { timeout: 15_000 })
    .toBe("manual");

  await sw.evaluate(async (url) => {
    await chrome.storage.local.set({
      applications: [
        { key: `localhost/jobs/plain.html`, alt: "", url, mode: "yolo", status: "submitted", at: Date.UTC(2026, 9, 1) },
      ],
    });
  }, `${BASE}plain.html`);
  await page.goto(`${BASE}plain.html`);
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("autoapply-root .panel .notice")).toHaveText(/YOLO already applied to this job on/);
});

test("AI tailor: uploads the résumé tailored for the job, notes it on the application, and frees the hidden page", async ({
  sw,
  page,
  mock,
}) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true, settings: { debugLogging: true } });
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/options/index.html#/documents`);
  await page.getByLabel("Résumé for AI tailoring (.tex)").setInputFiles("test/fixtures/latex/jake.tex");
  await expect.poll(() => storage(sw, "tailorResume"), { timeout: 30_000 }).toBeTruthy();
  await queue(sw, `${BASE}yolo-job.html`, { resumeUpload: "tailor" });
  await outcome(sw).toBe("submitted");
  const [a] = await storage<Application[]>(sw, "applications");
  expect(a.notes).toEqual([expect.stringMatching(/^Résumé tailored: \d+ changes? for this job$/)]);
  expect(mock.calls_("tailor")).toHaveLength(1);
  // The debug log keeps the tailored PDF that was uploaded.
  const log = (await storage<{ text: string; files?: { name: string; base64: string }[] }[]>(sw, "yoloLogs")).at(-1)!;
  expect(log.text).toMatch(/Résumé: Tailored \(\w+_Resume\.pdf\)/);
  expect(log.text).toContain("Cover letter: None");
  expect(log.files).toHaveLength(1);
  expect(atob(log.files![0].base64)).toMatch(/^%PDF/);
  await expect.poll(() => sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
});

test("AI tailor without a LaTeX résumé: YOLO refuses to turn on, and a queued job waits", async ({ sw, page }) => {
  await seed(sw, { caps: true });
  await sw.evaluate(async () => {
    const { yolo } = await chrome.storage.local.get("yolo");
    await chrome.storage.local.set({ yolo: { ...(yolo as object), queries: ["x"], resumeUpload: "tailor" } });
  });
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/options/index.html#/yolo`);
  const r = await page.evaluate(() => chrome.runtime.sendMessage({ type: "YOLO_SET", enabled: true }));
  expect(r.error.message).toMatch(/AI tailor is selected for YOLO, but no LaTeX résumé/);
  expect((await storage<{ enabled?: boolean }>(sw, "yolo")).enabled).toBeFalsy();

  await queue(sw, `${BASE}yolo-job.html`, { resumeUpload: "tailor" });
  await expect
    .poll(async () => (await storage<{ pauseReason?: string } | undefined>(sw, "yoloState"))?.pauseReason, {
      timeout: 30_000,
    })
    .toMatch(/AI tailor is selected for YOLO, but no LaTeX résumé/);
  expect(await storage<Application[] | undefined>(sw, "applications")).toBeFalsy();
});

test("shows in red in the popup, right after turn-on, a source YOLO can't read", async ({ context, sw, page }) => {
  await seed(sw, { caps: true });
  // Signed out of Jobright and of Indeed (whose account page sends signed-out visitors to /auth).
  await context.route("https://jobright.ai/swan/**", (r) =>
    r.fulfill({ status: 401, contentType: "application/json", body: '{"success":false,"errorCode":41001}' }),
  );
  await context.route("https://secure.indeed.com/**", (r) =>
    new URL(r.request().url()).pathname === "/settings/account"
      ? r.fulfill({ status: 302, headers: { location: "/auth?hl=en&continue=%2Fsettings%2Faccount" } })
      : r.fulfill({ status: 200, contentType: "text/html", body: "<title>Sign in | Indeed</title>" }),
  );
  await sw.evaluate(async () => {
    const { yolo } = await chrome.storage.local.get("yolo");
    await chrome.storage.local.set({
      yolo: {
        ...(yolo as object),
        queries: ["x"],
        feeds: [],
        careerSites: [],
        boards: ["indeed"],
        jobright: ["recommendations"],
      },
    });
  });
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/popup/index.html`);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("switch", { name: "YOLO Mode" }).click();
  // Well before the first batch, 30 s on.
  await expect(page.getByRole("alert")).toHaveText(
    ["Jobright: sign in to jobright.ai in this browser", "Indeed: sign in to indeed.com in this browser"],
    { timeout: 10_000 },
  );
  await expect(page.getByRole("alert")).toHaveClass([/err/, /err/]);
  // And under each source's toggle in settings.
  await page.goto(`chrome-extension://${id}/src/options/index.html#/yolo`);
  await expect(page.getByRole("status").filter({ hasText: "answered as signed out" })).toHaveText([
    /^Indeed answered as signed out at the last check/,
    /^Jobright answered as signed out at the last check/,
  ]);
});

test("warns under a source's toggle in settings as soon as it's turned on, YOLO off", async ({ context, sw, page }) => {
  await seed(sw, { caps: true });
  const asked: string[] = [];
  await context.route("https://jobright.ai/swan/**", (r) => {
    asked.push(r.request().url());
    return r.fulfill({ status: 401, contentType: "application/json", body: '{"success":false,"errorCode":41001}' });
  });
  await context.route("https://secure.indeed.com/**", (r) => {
    asked.push(`${r.request().method()} ${r.request().url()}`);
    return new URL(r.request().url()).pathname === "/settings/account"
      ? r.fulfill({ status: 302, headers: { location: "/auth?hl=en&continue=%2Fsettings%2Faccount" } })
      : r.fulfill({ status: 200, contentType: "text/html", body: "<title>Sign in | Indeed</title>" });
  });
  await sw.evaluate(async () => {
    const { yolo } = await chrome.storage.local.get("yolo");
    await chrome.storage.local.set({ yolo: { ...(yolo as object), queries: ["x"], boards: [], jobright: [] } });
  });
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/options/index.html#/yolo`);
  const notes = page.getByRole("status").filter({ hasText: "answered as signed out" });
  await expect(notes).toHaveCount(0);

  await page.getByLabel("Indeed", { exact: true }).check();
  await expect(notes).toHaveText([/^Indeed answered as signed out at the last check/]);
  await page.getByLabel("Jobright", { exact: true }).check();
  await expect(notes).toHaveText([
    /^Indeed answered as signed out at the last check/,
    /^Jobright answered as signed out at the last check/,
  ]);
  // Only the sign-in checks, one per source turned on: no search, and YOLO stays off.
  expect(asked).toEqual([
    // (The redirect to /auth is followed past Playwright's routing.)
    "HEAD https://secure.indeed.com/settings/account",
    "https://jobright.ai/swan/msg/has-unread",
  ]);
  expect((await storage<{ enabled?: boolean }>(sw, "yolo")).enabled).toBeFalsy();
});

for (const reviewFills of [false, true]) {
  test(`AI navigation on finds an unfamiliar Apply and submits with YOLO review ${reviewFills ? "on" : "off"}`, async ({
    sw,
    mock,
  }) => {
    test.setTimeout(120_000);
    await seed(sw, { caps: true, settings: { reviewFills: false } });
    await queue(sw, `${BASE}yolo-job-odd-apply.html`, { reviewFills, aiNavigation: true });
    await outcome(sw).toBe("submitted");
    const [a] = await storage<Application[]>(sw, "applications");
    expect(a.doneUrl).toContain("yolo-thanks.html");
    expect(mock.calls_("navigate").length).toBeGreaterThanOrEqual(1);
    expect(mock.calls_("review").length > 0).toBe(reviewFills);
  });

  test(`AI navigation off leaves an unfamiliar page to standard navigation with YOLO review ${reviewFills ? "on" : "off"}`, async ({
    sw,
    mock,
  }) => {
    test.setTimeout(120_000);
    await seed(sw, { caps: true, settings: { reviewFills: true } });
    await queue(sw, `${BASE}yolo-job-odd-apply.html`, { reviewFills, aiNavigation: false, tabFallback: false });
    await outcome(sw).toBe("failed");
    const [a] = await storage<Application[]>(sw, "applications");
    expect(a.reason).toBe("Unrecognized page");
    expect(mock.calls_("navigate")).toHaveLength(0);
    expect(mock.calls_("review")).toHaveLength(0);
  });
}
