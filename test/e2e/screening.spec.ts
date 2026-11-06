import type { Application } from "../../src/shared/yolo";
import { normalize } from "../../src/shared/normalize";
import type { ReviewField } from "../../src/shared/review";
import type { MockGemini } from "../mockGemini";
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

// Deliberately contradict the first pass, including locked fields. Local policy must win over these verdicts.
const adverseReview = (mock: MockGemini) => {
  mock.review = (payload) => ({
    fields: (payload.fields as ReviewField[]).map((f) =>
      /experience|available for an internship/.test(f.question)
        ? {
            fieldId: f.id,
            verdict: "wrong",
            answer: f.kind === "select" ? "Less than 3 years" : "1",
            reason: "Resume says less",
            sources: ["resume"],
          }
        : { fieldId: f.id, verdict: "ok" },
    ),
    missed: [],
    reveal: [],
  });
};

for (const reviewFills of [false, true])
  for (const lengths of [["All"], ["2 months"]]) {
    test(`manual screening respects ${lengths.join(", ")} with review ${reviewFills} and leaves traps empty`, async ({
      sw,
      page,
      mock,
    }) => {
      adverseReview(mock);
      await seed(sw, { caps: true, profile: profile(lengths), settings: { reviewFills } });
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
      expect(mock.calls_("review").length > 0).toBe(reviewFills);
      expect(mock.calls_("map")).toHaveLength(0);
      expect(mock.calls_("essay")).toHaveLength(0);
    });
  }

for (const reviewFills of [false, true])
  test(`YOLO preserves screening and logs policy answers with review/navigation ${reviewFills}`, async ({
    sw,
    page,
    mock,
  }) => {
    test.setTimeout(120_000);
    adverseReview(mock);
    void page;
    await seed(sw, { caps: true, profile: profile(["All"]) });
    await sw.evaluate(
      async ({ url, reviewFills }) => {
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
          yolo: {
            enabled: true,
            queries: ["Software Engineer Intern"],
            feeds: [],
            boards: [],
            aiRelevanceCheck: false,
            reviewFills,
            aiNavigation: reviewFills,
          },
        });
      },
      { url: `${BASE}screening.html`, reviewFills },
    );
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
    expect(mock.calls_("review").length > 0).toBe(reviewFills);
    expect(mock.calls_("navigate")).toHaveLength(0);
    expect(mock.calls_("map")).toHaveLength(0);
  });

test("review cannot fill conflicting screening availability or clear its warning", async ({ sw, page, mock }) => {
  adverseReview(mock);
  const p = profile(["4 months"]);
  await seed(sw, {
    caps: true,
    profile: { ...p, preferences: { ...p.preferences, earliestStartDate: "2090-01-01", availableUntil: "2090-03-01" } },
  });
  await page.goto(`${BASE}screening.html`);
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#term")).toHaveValue("");
  await expect(page.locator("autoapply-root .panel")).toContainText("Profile availability constraints conflict");
  expect(mock.calls_("review")).toHaveLength(1);
});
