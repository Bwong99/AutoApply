import type { Application } from "../../src/shared/yolo";
import { normalize } from "../../src/shared/normalize";
import { BASE, expect, fillPage, PROFILE, seed, storage, test, waitDone } from "./extension";

const oldQuestion =
  "How many months are you available for an internship? Internships must be at least three months long.";
const profile = (lengths: string[]) => ({
  ...PROFILE,
  coop: { acceptableTermLengths: lengths },
  essayGuidance: { aboutMe: "I only have 2 years of experience with React." },
  learnedAnswers: [
    {
      id: "old",
      question: oldQuestion,
      normalizedQuestion: normalize(oldQuestion),
      kind: "number",
      answer: "1",
      host: "localhost",
      createdAt: 1,
      lastUsedAt: 1,
    },
  ],
});

for (const lengths of [["All"], ["2 months"]]) {
  test(`manual screening respects ${lengths.join(", ")} and leaves traps empty`, async ({ sw, page }) => {
    await seed(sw, { caps: true, profile: profile(lengths) });
    await page.goto(`${BASE}screening.html`);
    await fillPage(page, sw);
    await waitDone(page);
    await expect(page.locator("#first")).toHaveValue("Ada");
    await expect(page.locator("#term")).toHaveValue(lengths[0] === "All" ? "3" : "2");
    await expect(page.locator("#react")).toHaveValue("3");
    await expect(page.locator("#bracket")).toHaveValue("3-5 years");
    await expect(page.locator("#hidden")).toHaveValue("");
    await expect(page.locator("#trap")).toHaveValue("");
    expect(page.url()).toContain("screening.html");
  });
}

test("YOLO submits passing thresholds, preserves traps and logs policy-derived answers", async ({ sw, page }) => {
  test.setTimeout(120_000);
  void page;
  await seed(sw, { caps: true, profile: profile(["All"]) });
  await sw.evaluate(async (url) => {
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
      yolo: { enabled: true, queries: ["Software Engineer Intern"], feeds: [], boards: [], aiRelevanceCheck: false },
    });
  }, `${BASE}screening.html`);
  await expect
    .poll(async () => (await storage<Application[] | undefined>(sw, "applications"))?.[0]?.status, {
      timeout: 90_000,
      intervals: [500],
    })
    .toBe("submitted");
  const [a] = await storage<Application[]>(sw, "applications");
  expect(a.guesses).toEqual(
    expect.arrayContaining([
      { q: "How many years of experience do you have with React? The role requires at least 3 years.", a: "3" },
    ]),
  );
  expect(a.doneUrl).toContain("yolo-thanks.html");
});
