import { BASE, badge, expect, fillPage, seed, storage, test, waitDone } from "./extension";

const Q = "What is your favourite programming language?";

test("learning: a manually answered flagged field is saved and reused without remapping", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw, { caps: true, settings: { learnPrompts: true } });
  await page.goto(BASE + "semantic.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(badge(page, Q)).toHaveAttribute("data-color", "yellow");

  await page.locator("#lang").fill("TypeScript");
  await page.locator("#lang").press("Tab");
  const card = page.getByRole("dialog", { name: "Save answer" });
  await expect(card).toContainText("Save this answer for future applications?");
  await expect(card).toContainText(`"${Q}" → "TypeScript"`);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toHaveCount(0);
  await expect(badge(page, Q)).toHaveAttribute("data-color", "green");

  const profile = await storage<{ learnedAnswers: { question: string; answer: string; host: string }[] }>(
    sw,
    "profile",
  );
  expect(profile.learnedAnswers).toEqual([
    expect.objectContaining({ question: Q, answer: "TypeScript", host: "localhost" }),
  ]);

  const before = mock.calls_("map").length;
  await page.reload();
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#lang")).toHaveValue("TypeScript");
  await expect(badge(page, Q)).toHaveAttribute("data-color", "green");
  await expect(badge(page, Q)).toHaveAttribute("aria-label", /Saved answer/);
  // Any new mapping call must not have included the learned question.
  for (const c of mock.calls_("map").slice(before))
    expect((c.payload!.fields as { label: string }[]).map((f) => f.label)).not.toContain(Q);
});

test("learning: prompts stay off by default while manual answers are retained", async ({ page, sw }) => {
  await seed(sw, { caps: true });
  await page.goto(BASE + "semantic.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(badge(page, Q)).toHaveAttribute("data-color", "yellow");

  await page.locator("#lang").fill("TypeScript");
  await page.locator("#lang").press("Tab");
  // Wait for the commit handler, so absence of a prompt is checked after the edit has been processed.
  await expect(badge(page, Q)).toHaveAttribute("data-color", "green");
  await expect(page.getByRole("dialog", { name: "Save answer" })).toHaveCount(0);
  const profile = await storage<{ learnedAnswers: unknown[] }>(sw, "profile");
  expect(profile.learnedAnswers).toEqual([]);

  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#lang")).toHaveValue("TypeScript");
});
