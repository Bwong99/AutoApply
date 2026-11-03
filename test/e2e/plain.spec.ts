import { BASE, badge, expect, fillPage, forbidden, seed, test, waitDone } from "./extension";

test("plain form: deterministic, AI, essay, file and consent fields are filled, verified and badged", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw, { settings: { autoAcceptAcknowledgements: false } });
  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);

  await expect(page.locator("#fn")).toHaveValue("Ada");
  await expect(page.locator("#ln")).toHaveValue("Lovelace");
  await expect(page.locator("#em")).toHaveValue("ada@example.com");
  await expect(page.locator("#ph")).toHaveValue("6045551234");
  await expect(page.locator("#prov")).toHaveValue("BC");
  await expect(page.locator("input[name=auth][value=yes]")).toBeChecked();
  await expect(page.locator("#why")).not.toHaveValue("");
  expect(await page.locator("#cv").evaluate((i: HTMLInputElement) => i.files?.[0]?.name)).toBe("ada-resume.pdf");
  await expect(page.locator("#privacy")).not.toBeChecked();

  await expect(badge(page, "First name")).toHaveAttribute("data-color", "green");
  await expect(badge(page, "Email")).toHaveAttribute("data-color", "green");
  await expect(badge(page, "Province")).toHaveAttribute("data-color", "blue");
  await expect(badge(page, "Are you legally authorized to work in Canada?")).toHaveAttribute("data-color", "blue");
  await expect(badge(page, "Why do you want to work at Acme Robotics? (max 120 words)")).toHaveAttribute(
    "data-color",
    "purple",
  );
  await expect(badge(page, "Resume/CV")).toHaveAttribute("data-color", "green");
  await expect(badge(page, "I agree to the privacy policy")).toHaveAttribute("data-color", "yellow");

  // 9 fields: 8 filled (5 profile + 2 AI + 1 essay), consent needs you.
  await expect(page.locator("autoapply-root .panel .status")).toHaveText("Done · 8 filled · 1 AI draft · 1 need you");
  const words = (await page.locator("#why").inputValue()).split(/\s+/).length;
  expect(words).toBeLessThanOrEqual(120);

  expect(await forbidden(page)).toEqual([]);
  expect(mock.calls_("map")).toHaveLength(1);
});

test("no form: a triggered fill on a page without fields shows the overlay with an error", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "no-form.html");
  await fillPage(page, sw);
  await expect(page.locator("autoapply-root .panel .error")).toHaveText(/No job application form found/);
  await expect(page.locator("autoapply-root .fab .count")).toHaveText("!");
});

test("plain form: a name in the capitals a résumé parser wrote is corrected, a different one kept", async ({
  page,
  sw,
}) => {
  await seed(sw);
  await page.goto(BASE + "plain.html");
  await page.locator("#fn").fill("ADA");
  await page.locator("#ln").fill("BYRON");
  await fillPage(page, sw);
  await waitDone(page);

  await expect(page.locator("#fn")).toHaveValue("Ada");
  await expect(page.locator("#ln")).toHaveValue("BYRON");
});

test("an application opened in a new tab keeps the posting of the job board that opened it", async ({
  page,
  context,
  sw,
}) => {
  await seed(sw);
  await page.goto(BASE + "job-board.html");
  const [form] = await Promise.all([context.waitForEvent("page"), page.click("#apply")]);
  await form.waitForLoadState();

  const posting = () =>
    sw.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      const key = `jobContext:${tab?.id}`;
      return (await chrome.storage.session.get(key))[key] as { text: string; company: string } | undefined;
    }, form.url());
  await expect.poll(async () => (await posting())?.text).toContain("motor control firmware");

  // The board moves on to another job before the form is filled.
  await page.click("#next");
  await fillPage(form, sw);
  await waitDone(form);
  const job = await posting();
  expect(job?.text).toContain("motor control firmware");
  expect(job?.text).not.toContain("cold calling");
  expect(job?.company).not.toBe("Job Board");
});
