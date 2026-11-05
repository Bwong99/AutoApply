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
