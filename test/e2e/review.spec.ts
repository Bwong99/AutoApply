// The AI review after a fill: it corrects a value the page changed and fills a question the scan missed.
import { BASE, expect, fillPage, seed, test, waitDone } from "./extension";

test("review corrects a wrong value and answers a question the scan missed", async ({ page, sw, mock }) => {
  await seed(sw, { caps: true });
  await page.goto(BASE + "review.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#ln")).toHaveValue("Lovelace");
  await expect(page.locator("#status")).toHaveText("authorized: Yes");
  expect(mock.calls_("review").length).toBeGreaterThanOrEqual(2);
});

test("review recovers an omitted verdict and retries incomplete recovery", async ({ page, sw, mock }) => {
  const review = mock.review.bind(mock);
  let omitted: string | undefined;
  let recoveryAttempts = 0;
  mock.review = (payload) => {
    const r = review(payload);
    const verdicts = r.fields as { fieldId: string }[];
    const requested = payload.fieldIdsToReview as string[] | undefined;
    if (requested)
      return {
        fields: ++recoveryAttempts === 1 ? [] : verdicts.filter((v) => requested.includes(v.fieldId)),
        missed: [],
        reveal: [],
      };
    if (!omitted) {
      omitted = (payload.fields as { id: string; question: string }[]).find((f) => /^last name/i.test(f.question))?.id;
      r.fields = verdicts.filter((v) => v.fieldId !== omitted);
    }
    return r;
  };
  await seed(sw, { caps: true });
  await page.goto(BASE + "review.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#ln")).toHaveValue("Lovelace");
  await expect(page.locator("#status")).toHaveText("authorized: Yes");
  expect(omitted).toBeTruthy();
  const recoveries = mock.calls_("review").filter((c) => c.payload?.fieldIdsToReview);
  expect(recoveries).toHaveLength(2);
  for (const recovery of recoveries) expect(recovery.payload?.fieldIdsToReview).toEqual([omitted]);
});

test("review off: the fill is as before, with no review call", async ({ page, sw, mock }) => {
  await seed(sw, { caps: true, settings: { reviewFills: false } });
  await page.goto(BASE + "review.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#ln")).toHaveValue("Parsed-Surname");
  await expect(page.locator("#status")).toHaveText("");
  expect(mock.calls_("review")).toHaveLength(0);
});

test("review traps: hidden instructions never reach the AI, honeypots and trap questions stay empty", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw, { caps: true });
  await page.goto(BASE + "review-traps.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#fn")).toHaveValue("Ada");
  await expect(page.locator("#em")).toHaveValue("ada@example.com");
  for (const id of ["#hp1", "#hp2", "#hp3", "#hp4", "#hp5", "#hp6", "#trap", "#blank"])
    await expect(page.locator(id)).toHaveValue("");
  await expect(page.locator("#status")).toHaveText("");
  const reviews = mock.calls_("review");
  expect(reviews.length).toBeGreaterThanOrEqual(1);
  // Nothing hidden from people, and no line addressed to an AI, is in any request the review got.
  for (const c of reviews) {
    const sent = JSON.stringify(c.payload);
    for (const w of ["banana", "zebra", "kiwi", "mango", "Are you a robot"]) expect(sent).not.toContain(w);
  }
  // Nor in any other AI request of the fill.
  for (const c of mock.calls.filter((x) => x.kind !== "list"))
    for (const w of ["banana", "kiwi", "mango"]) expect(JSON.stringify(c.payload ?? {})).not.toContain(w);
});
