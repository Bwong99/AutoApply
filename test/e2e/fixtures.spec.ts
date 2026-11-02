import { BASE, badge, expect, fillPage, forbidden, PROFILE, seed, test, waitDone } from "./extension";

test("react-controlled: React state follows the filled values", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "react-controlled.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#echo")).toHaveText(
    JSON.stringify({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      phone: "6045551234",
      country: "CA",
      remote: true,
    }),
  );
  await expect(badge(page, "Country of residence")).toHaveAttribute("data-color", "blue");
  await expect(badge(page, "Open to remote work")).toHaveAttribute("data-color", "blue");
  expect(await forbidden(page)).toEqual([]);
});

test("custom-dropdown: portal + virtualized list and ARIA combobox are operated and verified", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw);
  await page.goto(BASE + "custom-dropdown.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#country .select__single-value")).toHaveText("Canada");
  await expect(page.locator("#type-btn")).toHaveText("Co-op / Internship");
  await expect(page.locator(".select__menu")).toHaveCount(0);
  await expect(page.locator("#types")).toBeHidden();
  await expect(badge(page, "Country")).toHaveAttribute("data-color", "blue");
  // The phone country shows "+1" both before and after "Canada +1" is picked; the list's aria-selected verifies it.
  await expect(page.locator("#dial")).toHaveAttribute("data-country", "Canada");
  await expect(badge(page, "Phone country")).toHaveAttribute("data-color", "blue");
  await expect(badge(page, "Employment type")).toHaveAttribute("data-color", "blue");
  // The school is on a later page of an infinite-scroll list: its first page must not count as the whole list.
  await expect(page.locator("#school-control .select__single-value")).toHaveText("University of British Columbia");
  await expect(badge(page, "School")).toHaveAttribute("data-color", "blue");
  // "Co-op" is not an exact option, so the harvested options went to chooseOptions.
  expect(mock.calls_("choose")).toHaveLength(1);
  expect(await forbidden(page)).toEqual([]);
});

test("typeahead: types a query, waits for suggestions and picks the matching one", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "typeahead.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#loc")).toHaveValue("Vancouver, BC, Canada");
  // The profile's address answers it; the suggestion is chosen by meaning ("British Columbia" = "BC").
  await expect(badge(page, "Location")).toHaveAttribute("data-color", "green");
});

test("typeahead: a selection cleared by the widget is marked failed, not Check", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "typeahead-cleared.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#loc")).toHaveValue("");
  await expect(badge(page, "Location")).toHaveAttribute("data-color", "red");
});

test("buttons-group: aria-pressed pills and a role=radiogroup are selected", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "buttons-group.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator(".pill", { hasText: "Yes" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".pill", { hasText: "No" })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[role=radio]", { hasText: "Hybrid" })).toHaveAttribute("aria-checked", "true");
  await expect(badge(page, "Are you 18 years of age or older?")).toHaveAttribute("data-color", "blue");
  expect(await forbidden(page)).toEqual([]);
});

test("semantic: relocation, negatively phrased sponsorship and EEO decline are chosen by meaning", async ({
  page,
  sw,
}) => {
  await seed(sw);
  await page.goto(BASE + "semantic.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.getByLabel("I am willing to relocate", { exact: true })).toBeChecked();
  await expect(page.getByLabel("I am not willing to relocate")).not.toBeChecked();
  await expect(page.locator("#spons")).toHaveValue("I will not require sponsorship");
  await expect(page.locator("#gender")).toHaveValue("I don't wish to answer");
  await expect(badge(page, "What is your favourite programming language?")).toHaveAttribute("data-color", "yellow");
  await expect(page.locator("autoapply-root .panel .status")).toHaveText("Done · 6 filled · 0 AI drafts · 1 need you");
});

test("followup: a question revealed by an answer is filled in a second pass", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "followup.html");
  await fillPage(page, sw);
  await expect(page.locator("#prov")).toHaveValue("British Columbia");
  await waitDone(page);
  await expect(page.locator("#em")).toHaveValue("ada@example.com");
  // The swapped-in file input is the same, already uploaded field.
  expect(await page.evaluate(() => (window as unknown as { uploads: number }).uploads)).toBe(1);
  await expect(badge(page, "Which province do you prefer?")).toHaveAttribute("data-color", "blue");
  // The overlay lists the uploaded résumé, which opens in a new tab.
  await page.locator("autoapply-root .fab").click();
  const file = page.locator("autoapply-root .files button");
  await expect(file).toHaveText(/ada-resume\.pdf\s*Résumé submitted/);
  const [tab] = await Promise.all([page.context().waitForEvent("page"), file.click()]);
  expect(tab.url()).toMatch(/^blob:/);
});

test("shadow: fields inside an open shadow root are filled", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "shadow.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#fn")).toHaveValue("Ada");
  await expect(page.locator("#em")).toHaveValue("ada@example.com");
  await expect(page.locator("#li")).toHaveValue("https://linkedin.com/in/ada");
  await expect(badge(page, "LinkedIn profile")).toHaveAttribute("data-color", "green");
});

test("iframe: a cross-origin child frame fills itself and the top-frame overlay aggregates it", async ({
  page,
  sw,
}) => {
  await seed(sw);
  await page.goto(BASE + "iframe-host.html");
  await fillPage(page, sw);
  const frame = page.frameLocator("#frame");
  await expect(frame.locator("#fn")).toHaveValue("Ada");
  await expect(frame.locator("#ph")).toHaveValue("6045551234");
  await expect(frame.locator("#city")).toHaveValue("Vancouver");
  expect(await frame.locator("#cv").evaluate((i: HTMLInputElement) => i.files?.[0]?.name)).toBe("ada-resume.pdf");
  await waitDone(page);
  await expect(page.locator("autoapply-root .panel .status")).toHaveText("Done · 6 filled · 0 AI drafts · 0 need you");
  // A click inside the child frame never reaches the top document; it must still collapse the overlay.
  const panel = page.locator("autoapply-root .panel");
  await expect(panel).toBeHidden(); // auto-collapse after the done pin, so it can't race the click below
  await page.locator("autoapply-root .fab").click();
  await expect(panel).toBeVisible();
  await frame.locator("body").click({ position: { x: 5, y: 5 } });
  await expect(panel).toBeHidden();
});

test("multistep: step 2 after Next (pushState) waits for another fill; the extension never clicks Next", async ({
  page,
  sw,
}) => {
  await seed(sw);
  await page.goto(BASE + "multistep.html");
  await fillPage(page, sw);
  await expect(page.locator("#em")).toHaveValue("ada@example.com");
  await waitDone(page);
  expect(await forbidden(page)).toEqual([]);
  await page.click("#next");
  await expect(page).toHaveURL(/step=2/);
  await page.waitForTimeout(1500);
  await expect(page.locator("#ph")).toHaveValue("");
  await fillPage(page, sw);
  await expect(page.locator("#ph")).toHaveValue("6045551234");
  await expect(page.locator("#city")).toHaveValue("Vancouver");
  await expect(page.locator("#li")).toHaveValue("https://linkedin.com/in/ada");
  await expect(page.locator("autoapply-root .panel .status")).toHaveText(/^Done · 7 filled/);
  expect(await forbidden(page)).toEqual([]);
});

test("dropzone: the résumé goes into the hidden input behind the dropzone", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "dropzone.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#status")).toHaveText("ada-resume.pdf uploaded ✓");
  await expect(badge(page, "Résumé Drag and drop your résumé here, or click to upload")).toHaveAttribute(
    "data-color",
    "green",
  );
});

test("dropzone: a résumé variant labelled with the job title goes in instead of the primary one", async ({
  page,
  sw,
}) => {
  await seed(sw);
  await sw.evaluate(async () => {
    const { documentsIndex, "doc:resume": doc } = (await chrome.storage.local.get([
      "documentsIndex",
      "doc:resume",
    ])) as { documentsIndex: object[]; "doc:resume": unknown };
    const variant = { ...documentsIndex[0], id: "mkt", label: "Marketing", fileName: "ada-marketing.pdf" };
    await chrome.storage.local.set({
      documentsIndex: [...documentsIndex, { ...variant, isPrimaryResume: false }],
      "doc:mkt": doc,
    });
  });
  await page.goto(BASE + "dropzone.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#status")).toHaveText("ada-marketing.pdf uploaded ✓");
});

test("no trigger: an application page is left alone and no UI appears", async ({ page, sw, mock }) => {
  await seed(sw);
  await page.goto(BASE + "plain.html");
  await page.waitForTimeout(3500);
  await expect(page.locator("#fn")).toHaveValue("");
  await expect(page.locator("autoapply-root")).toHaveCount(0);
  expect(mock.calls).toHaveLength(0);
});

test("consent: with required consents off and optional on flag, acknowledgements are flagged, not ticked", async ({
  page,
  sw,
}) => {
  await seed(sw, { settings: { autoAcceptAcknowledgements: false, optionalConsents: "ask" } });
  await page.goto(BASE + "consent.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#c1")).not.toBeChecked();
  await expect(page.locator("#c2")).not.toBeChecked();
  await expect(page.locator("#c3")).not.toBeChecked();
  await expect(page.locator("#r1")).not.toBeChecked();
  await expect(page.locator("#r2")).not.toBeChecked();
  await expect(badge(page, "I certify that the information provided is accurate and complete.")).toHaveAttribute(
    "data-color",
    "yellow",
  );
  await expect(badge(page, "I agree to the Terms of Service")).toHaveAttribute("data-color", "yellow");
  await expect(page.locator("autoapply-root .needs")).toContainText("Needs your confirmation");
});

test("consent: by default required boxes are ticked and badged blue, optional left", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "consent.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#c1")).toBeChecked();
  await expect(page.locator("#c2")).toBeChecked();
  await expect(page.locator("#c3")).not.toBeChecked();
  await expect(page.locator("#r1")).toBeChecked(); // "Consent" / "Do Not Consent" radios are required consent
  await expect(page.locator("#pp")).toHaveValue("I agree"); // a lone option can only accept
  await expect(page.locator("#g1")).toBeChecked(); // a box per consent (Gemini)
  await expect(page.locator("#g2")).toBeChecked();
  await expect(badge(page, "I agree to the Terms of Service")).toHaveAttribute("data-color", "blue");
});

test("consent: with optional consents on accept, only the optional box is ticked", async ({ page, sw }) => {
  await seed(sw, { settings: { autoAcceptAcknowledgements: false, optionalConsents: "accept" } });
  await page.goto(BASE + "consent.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#c3")).toBeChecked();
  await expect(page.locator("#ja")).toHaveValue("Yes");
  await expect(page.locator("#c1")).not.toBeChecked();
  await expect(page.locator("#c2")).not.toBeChecked();
  await expect(page.locator("#r1")).not.toBeChecked();
});

test("consent: optional job-opportunity and marketing opt-ins follow the profile, required ones the settings", async ({
  page,
  sw,
}) => {
  const background = { consentToJobOpportunities: "yes", consentToMarketing: "no" };
  await seed(sw, { profile: { ...PROFILE, background }, settings: { optionalConsents: "accept" } });
  await page.goto(BASE + "consent.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#c3")).toBeChecked(); // other relevant job opportunities
  await expect(page.locator("#c5")).toBeChecked(); // new job opportunities
  await expect(page.locator("#ja")).toHaveValue("Yes"); // job alerts
  await expect(page.locator("#c4")).not.toBeChecked(); // marketing: the profile's "No" over "accept"
  await expect(page.locator("#tc")).toHaveValue("Yes"); // required: the settings, as before
  await expect(page.locator("#c2")).toBeChecked();

  await seed(sw, {
    profile: { ...PROFILE, background: { consentToJobOpportunities: "no", consentToMarketing: "yes" } },
    settings: { optionalConsents: "decline" },
  });
  await page.reload();
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#c3")).not.toBeChecked();
  await expect(page.locator("#c5")).not.toBeChecked();
  await expect(page.locator("#ja")).toHaveValue("No");
  await expect(page.locator("#c4")).toBeChecked();
  await expect(page.locator("#tc")).toHaveValue("No");
});

test("consent: with optional consents on decline, the optional box is left unticked and not flagged", async ({
  page,
  sw,
}) => {
  await seed(sw, { settings: { autoAcceptAcknowledgements: false, optionalConsents: "decline" } });
  await page.goto(BASE + "consent.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(page.locator("#c3")).not.toBeChecked();
  await expect(page.locator("#ja")).toHaveValue("No"); // plain Yes/No opt-in (MongoDB)
  await expect(page.locator("#tc")).toHaveValue("No"); // a required opt-in still takes "No" (Braze)
  await expect(page.locator('autoapply-root .tag[aria-label^="I want recruiters"]')).toHaveAttribute(
    "data-color",
    "blue",
  );
  await expect(badge(page, "I agree to the Terms of Service")).toHaveAttribute("data-color", "yellow");
  await expect(page.locator("#r2")).not.toBeChecked(); // required consent is never declined
});
