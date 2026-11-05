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
  for (const id of ["#hp1", "#hp2", "#hp3", "#trap", "#blank"]) await expect(page.locator(id)).toHaveValue("");
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
