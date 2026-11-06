// The AI review after a fill: it corrects a value the page changed and fills a question the scan missed.
import type { ReviewField } from "../../src/shared/review";
import { BASE, badge, expect, fillPage, seed, test, waitDone } from "./extension";

test("review corrects a wrong value and answers a question the scan missed", async ({ page, sw, mock }) => {
  await seed(sw, { caps: true });
  await sw.evaluate(() => chrome.storage.local.set({ yolo: { reviewFills: false } }));
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
  await sw.evaluate(() => chrome.storage.local.set({ yolo: { reviewFills: true } }));
  await page.goto(BASE + "review.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#ln")).toHaveValue("Parsed-Surname");
  await expect(page.locator("#status")).toHaveText("");
  expect(mock.calls_("review")).toHaveLength(0);
});

for (const { name, question, control, answer } of [
  {
    name: "essay drafting is disabled",
    question: "Additional information",
    control: '<textarea id="target" required></textarea>',
    answer: "A detailed answer about the candidate. ".repeat(8),
  },
  {
    name: "a checkbox answer cannot be applied",
    question: "Fieldwork availability",
    control: '<input id="target" type="checkbox" required>',
    answer: "Sometimes",
  },
  {
    name: "an upload has no matching document",
    question: "Transcript",
    control: '<input id="target" type="file" accept="application/pdf" required>',
    answer: "Transcript",
  },
]) {
  test(`review stops after a skipped correction when ${name}`, async ({ page, sw, mock }) => {
    mock.review = (payload) => ({
      fields: (payload.fields as ReviewField[]).map((f) =>
        f.question.startsWith(question) && !f.locked
          ? { fieldId: f.id, verdict: "fill", answer, reason: "Profile", sources: ["resume"] }
          : { fieldId: f.id, verdict: "ok" },
      ),
      missed: [],
      reveal: [],
    });
    await seed(sw, { caps: true, settings: { draftEssays: false } });
    await page.goto(BASE + "review.html");
    await page
      .locator("#apply")
      .evaluate(
        (form, html) => (form.innerHTML = html),
        `<div class="row"><label for="target">${question} *</label>${control}</div>`,
      );
    await fillPage(page, sw);
    await waitDone(page);
    const reviews = mock.calls_("review");
    expect(reviews).toHaveLength(1);
    const fields = reviews[0].payload?.fields as ReviewField[];
    expect(fields).toHaveLength(1);
    expect(fields[0].locked).not.toBe(true);
    await expect(badge(page, question)).toHaveAttribute("data-color", "yellow");
    if (name === "a checkbox answer cannot be applied") await expect(page.locator("#target")).not.toBeChecked();
    else await expect(page.locator("#target")).toHaveValue("");
    expect(mock.calls_("essay")).toHaveLength(0);
  });
}

test("review still rescans when an attempted correction is rejected and reveals a question", async ({
  page,
  sw,
  mock,
}) => {
  mock.review = (payload) => ({
    fields: (payload.fields as ReviewField[]).map((f) =>
      f.question.startsWith("Fieldwork details") && !f.shown
        ? { fieldId: f.id, verdict: "fill", answer: "Reviewed answer", reason: "Profile", sources: ["resume"] }
        : { fieldId: f.id, verdict: "ok" },
    ),
    missed: [],
    reveal: [],
  });
  await seed(sw, { caps: true });
  await page.goto(BASE + "review.html");
  await page.locator("#apply").evaluate((form) => {
    form.innerHTML =
      '<div class="row"><label for="target">Fieldwork details *</label><input id="target" required></div>';
    const input = form.querySelector<HTMLInputElement>("#target")!;
    input.addEventListener("input", () => {
      if (input.value !== "Reviewed answer") return;
      input.value = "Rejected answer";
      if (!form.querySelector("#follow"))
        form.insertAdjacentHTML(
          "beforeend",
          '<div class="row"><label for="follow">First name *</label><input id="follow" required></div>',
        );
    });
  });
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#target")).toHaveValue("Rejected answer");
  await expect(page.locator("#follow")).toHaveValue("Ada");
  const reviews = mock.calls_("review");
  expect(reviews).toHaveLength(2);
  const fields = reviews[1].payload?.fields as ReviewField[];
  expect(fields.find((f) => f.question.startsWith("Fieldwork details"))).toMatchObject({
    status: "check",
    shown: "Rejected answer",
  });
  expect(fields.find((f) => f.question.startsWith("First name"))).toMatchObject({ shown: "Ada" });
});

test("review retains a follow-up check when a skipped correction also relabels a field", async ({ page, sw, mock }) => {
  mock.review = (payload) => ({
    fields: (payload.fields as ReviewField[]).map((f) =>
      f.question.startsWith("Fieldwork availability")
        ? {
            fieldId: f.id,
            verdict: "relabel",
            question: "Travel availability",
            answer: "Sometimes",
            reason: "Label corrected",
            sources: ["resume"],
          }
        : { fieldId: f.id, verdict: "ok" },
    ),
    missed: [],
    reveal: [],
  });
  await seed(sw, { caps: true });
  await page.goto(BASE + "review.html");
  await page.locator("#apply").evaluate((form) => {
    form.innerHTML =
      '<div class="row"><label for="target">Fieldwork availability *</label><input id="target" type="checkbox" required></div>';
  });
  await fillPage(page, sw);
  await waitDone(page);
  const reviews = mock.calls_("review");
  expect(reviews).toHaveLength(2);
  expect((reviews[1].payload?.fields as ReviewField[])[0]).toMatchObject({ question: "Travel availability" });
  await expect(page.locator("#target")).not.toBeChecked();
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
