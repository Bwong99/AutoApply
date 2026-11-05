import { beforeAll, describe, expect, it, vi } from "vitest";
import { setBody, stubLayout } from "./dom";
import { botWall, captchaShown, embeddedForm, pageFacts } from "../../src/content/yolo/classify";
import { cardText } from "../../src/content/yolo/driver";
import { indeedCardsInPage, parseIndeed } from "../../src/background/yolo/sources";
import { confirmation, confirmFirst, kindOf, verifyFailed } from "../../src/background/yolo/classify";

const classify = (fields: number, hidden = false, requiredFields = 0) =>
  kindOf(pageFacts({ fields, requiredFields }), hidden);
import { findApply, findNext, findSubmit, validationErrors } from "../../src/content/yolo/nav";
import { handleAuth, siteKey } from "../../src/content/yolo/auth";
import { realFor, setGraded, setRealMode } from "../../src/content/yolo/real";

beforeAll(stubLayout);

describe("YOLO page kinds", () => {
  it("tells sign-in from sign-up by password fields and headings", () => {
    setBody(`<h2>Sign In</h2><input data-automation-id="email" type="email"><input data-automation-id="password" type="password">
      <button data-automation-id="signInSubmitButton">Sign In</button><button data-automation-id="createAccountLink">Create Account</button>`);
    expect(classify(1)).toBe("signin");
    setBody(`<h2>Create Account</h2><input type="email"><input type="password"><input type="password">`);
    expect(classify(1)).toBe("signup");
    setBody(`<h2>Create Account</h2><input type="email"><input type="password">`);
    expect(classify(1)).toBe("signup");
    setBody(`<h2>Reset your password</h2><input type="password"><input type="password">`);
    expect(classify(0)).toBe("reset");
    // Eightfold asks for the address first.
    setBody(
      `<h2>Sign in</h2><input type="email"><button>Continue</button><p>First time here?</p><button>Create an account</button>`,
    );
    expect(classify(1)).toBe("signin");
    // Workday's sign-up still rendering: no fields yet under its "Create Account/Sign In" step.
    setBody(`<h2 data-automation-id="progressBarActiveStep">Create Account/Sign In</h2><p>Create Account</p>`);
    expect(classify(0)).toBe("unknown");
    expect(classify(1)).not.toBe("signin");
  });

  it("knows confirmation, closed and bot-wall pages", () => {
    setBody(`<h1>Thank you for applying!</h1><p>We'll be in touch.</p>`);
    expect(classify(0)).toBe("success");
    // A form that merely mentions it is not done.
    setBody(`<p>Once your application has been submitted, we'll review it.</p><input><input><input>`);
    expect(classify(3)).toBe("form");
    setBody(`<h1>This job is no longer accepting applications</h1>`);
    expect(classify(0)).toBe("closed");
    // Workday's, for a posting taken down.
    setBody(`<p>Introduce Yourself</p><p>The page you are looking for doesn't exist.</p>`);
    expect(classify(0)).toBe("closed");
    setBody(`<h1>Just a moment...</h1>`);
    expect(classify(0)).toBe("blocked");
    // Ashby's bot score turned it down and left no form: load the page again.
    setBody(
      `<h2>We couldn't submit your application</h2><p>Your application submission was flagged as possible spam.</p>`,
    );
    expect(classify(0)).toBe("flagged");
    // The hidden frame's score won't improve on a reload: the tab retry gets it.
    expect(classify(0, true)).toBe("blocked");
    setBody(`<p>We detected suspicious activity. Please try again.</p>`);
    expect(classify(0)).toBe("flagged");
    // AMD's fraud banner on every careers page.
    setBody(`<p>Fraud Alert: Learn how to protect yourself and report suspicious activity here.</p>`);
    expect(classify(0)).toBe("unknown");
  });

  it("quotes a confirmation page's message, else its headings", () => {
    setBody(`<h1>Application received</h1>`);
    const f = pageFacts({ fields: 0, requiredFields: 0 });
    const text = "Careers\nJobs\nThank you for applying!\n  We'll be   in touch.\n\nOpen roles\nFooter";
    expect(confirmation({ ...f, text })).toBe("Thank you for applying! We'll be in touch. Open roles");
    expect(confirmation({ ...f, text: "Careers\nAll done" })).toBe(f.headings);
  });

  it("asks for an emailed code, or a link", () => {
    setBody(`<h2>Verify your email</h2><p>We've sent a code to you.</p><input name="otp_code">`);
    expect(classify(1)).toBe("verify");
    setBody(`<h2>Check your inbox</h2><p>Click the link we emailed you.</p>`);
    expect(classify(0)).toBe("verify");
    setBody(`<h2>Forgot your password?</h2><input type="email"><button>Submit</button>`);
    expect(classify(1)).toBe("verify");
    // Workday's sign-in refusing an unverified account.
    setBody(`<h2>Sign In</h2><div role="alert">Verify your account before you sign in or request a verification email.</div>
      <input type="email" value="a@b.c"><input type="password"><button>Sign In</button>`);
    expect(classify(1)).toBe("verify");
    // A form that only mentions an email is filled, not waited on.
    setBody(`<p>We'll send a confirmation email once you submit.</p><input><input><input>`);
    expect(classify(3)).toBe("form");
  });

  it("holds a submission for its emailed link only when the page says it's required", () => {
    const facts = (html: string) => (setBody(html), pageFacts({ fields: 0, requiredFields: 0 }));
    const held = facts(`<h1>Almost done!</h1><p>Please verify your email address to complete your application.</p>`);
    expect(confirmFirst(held)).toBe(true);
    expect(kindOf(held, false)).toBe("verify");
    const thanks = facts(
      `<h1>Thanks for applying!</h1><p>To finish your application, click the link we emailed you.</p>`,
    );
    expect(kindOf(thanks, false)).toBe("verify");
    // A notice about an email is not a hold.
    const notice = facts(`<h1>Thank you for applying!</h1><p>Check your email for a confirmation.</p>`);
    expect(confirmFirst(notice)).toBe(false);
    expect(kindOf(notice, false)).toBe("success");
    expect(confirmFirst(facts(`<p>Verify your email to get job alerts.</p>`))).toBe(false);
    expect(verifyFailed(facts(`<h1>Your email has been verified</h1>`))).toBe(false);
    expect(verifyFailed(facts(`<h1>This link has expired</h1>`))).toBe(true);
    expect(verifyFailed(facts(`<p>Your email could not be verified.</p>`))).toBe(true);
  });

  it("reads a link's result card past a title too long to be its own card", () => {
    // Indeed's card, live: the title link sits in an h2 inside the card's text.
    const card = (title: string) => (
      setBody(
        `<div class="card"><div><h2><a href="/rc/clk?jk=1">${title}</a></h2><div>Ciena</div><div>Quebec City, QC</div></div><div>$25.00 an hour · Internship</div></div>`,
      ),
      cardText(document.querySelector("a")!)
    );
    expect(card("Stagiaire en développement logiciel - Software developer Intern/Co-op")).toContain("Ciena");
    expect(card("Software Developer Intern, Some Long Team Name Here (Winter 2027)")).toContain("Quebec City");
    expect(card("Software Intern")).toContain("Ciena");
  });

  it("tells a bot check standing in for a scraped page from the page itself", () => {
    const page = (title: string, body: string) => ((document.title = title), setBody(body), botWall());
    // Live shapes: Indeed's hidden-frame block, and Cloudflare's interstitial in a tab.
    expect(
      page("Blocked - Indeed.com", "<h1>Request Blocked</h1><p>Your Ray ID for this request is a551aa1e</p>"),
    ).toBe(true);
    expect(page("Just a moment...", "<h1>Additional Verification Required</h1>")).toBe(true);
    expect(page("Security Check - Indeed.com", "<p>Checking</p>")).toBe(true);
    expect(page("x", "<p>Your Ray ID for this request is 8f2c</p>")).toBe(true);
    expect(page("100 Software Intern Jobs in Canada | Indeed", "<a href='/rc/clk?jk=1'>Software Intern</a>")).toBe(
      false,
    );
    expect(page("Unblocked Games Developer Intern - Acme Careers", "<h1>Unblocked Games</h1>")).toBe(false);
  });

  it("reads Indeed's job-card data in a rendered search page, not the script that only names it", () => {
    const data = `window.mosaic.providerData["mosaic-provider-jobcards"]={"metaData":{"mosaicProviderJobCardsModel":{"results":[{"jobkey":"d9f514d9d78b1a2a","displayTitle":"Software Intern","company":"Co","formattedLocation":"Waterloo, ON","pubDate":1793772000000}]}}};`;
    const read = (title: string, body: string) => ((document.title = title), setBody(body), indeedCardsInPage());
    // Live layout, signed in: an earlier, small script names the provider; <script id="mosaic-data"> assigns it.
    const text = read(
      "100 Software Intern Jobs Hiring Now in Canada | Indeed",
      `<script>window.mosaic.setup(["mosaic-provider-jobcards"]);</script><script id="mosaic-data">${data}</script>`,
    );
    expect(text).toContain("d9f514d9d78b1a2a");
    expect(parseIndeed(text!, "ca.indeed.com")).toMatchObject([
      { url: "https://ca.indeed.com/viewjob?jk=d9f514d9d78b1a2a", title: "Software Intern", postedAt: 1793772000000 },
    ]);
    // A bot check is waited out; a loaded page without cards is no results.
    expect(read("Just a moment...", "<p>Checking</p>")).toBeNull();
    expect(read("Indeed", "<p>No jobs</p>")).toBe("");
  });

  it("finds a visible CAPTCHA challenge, never the invisible score badge", () => {
    setBody(`<iframe src="https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=x&size=invisible"></iframe>`);
    expect(captchaShown()).toBe(false);
    setBody(
      `<div style="visibility:hidden"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=x"></iframe></div>`,
    );
    expect(captchaShown()).toBe(false);
    setBody(`<iframe src="https://www.google.com/recaptcha/api2/bframe?k=x"></iframe>`);
    // happy-dom boxes are 100 × 20 (dom.ts): too small for a challenge.
    const f = document.querySelector("iframe")!;
    f.getBoundingClientRect = () => ({
      width: 400,
      height: 580,
      top: 0,
      left: 0,
      right: 400,
      bottom: 580,
      x: 0,
      y: 0,
      toJSON() {},
    });
    expect(captchaShown()).toBe(true);
    expect(classify(1)).toBe("captcha");
    // Once solved, the widget stays but its response token is set.
    document.body.insertAdjacentHTML("beforeend", `<textarea name="g-recaptcha-response">tok</textarea>`);
    expect(captchaShown()).toBe(false);
  });

  it("hands a step graded by an invisible score check from the hidden frame to a tab", () => {
    const form = `<h2>Apply</h2><input><input><input><button type="submit">Submit application</button>`;
    setBody(`${form}<script src="https://www.google.com/recaptcha/enterprise.js?render=k"></script>`);
    expect(classify(3, true)).toBe("blocked");
    expect(classify(3, false)).toBe("form"); // a tab submits as it is
    setBody(
      `${form}<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox-invisible"></iframe>`,
    );
    expect(classify(3, true)).toBe("blocked");
    setBody(form);
    expect(classify(3, true)).toBe("form");
    // Already sent: never retried, which would apply twice.
    setBody(`<h1>Thank you for applying!</h1><script src="https://www.recaptcha.net/recaptcha/api.js"></script>`);
    expect(classify(0, true)).toBe("success");
  });

  it("hands a page whose bot-detection service set its cookie from the hidden frame to a tab", () => {
    setBody(`<h2>Apply</h2><input><input><input><button type="submit">Submit application</button>`);
    document.cookie = "_abck=x";
    expect(classify(3, true)).toBe("blocked");
    document.cookie = "_abck=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    document.cookie = "_pxhd=x";
    expect(classify(3, true)).toBe("blocked");
    document.cookie = "_pxhd=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    expect(classify(3, true)).toBe("form");
  });

  it("uses real input only as set, and only on a graded page", () => {
    setRealMode("clicks");
    setGraded(true);
    expect([realFor("clicks"), realFor("typing")]).toEqual([true, false]);
    setRealMode("both");
    expect([realFor("clicks"), realFor("typing")]).toEqual([true, true]);
    setGraded(false);
    expect([realFor("clicks"), realFor("typing")]).toEqual([false, false]);
    setRealMode("off");
    setGraded(true);
    expect([realFor("clicks"), realFor("typing")]).toEqual([false, false]);
  });

  it("recognizes DataDome's full-page CAPTCHA frame", () => {
    setBody(`<iframe src="about:blank#https://geo.captcha-delivery.com/captcha/?cid=x"></iframe>`);
    const f = document.querySelector("iframe")!;
    f.getBoundingClientRect = () => ({
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      x: 0,
      y: 0,
      toJSON() {},
    });
    expect(captchaShown()).toBe(true);
    // Its pass cookie, set by script, is dropped in the cross-site hidden frame: a tab may not even be shown it.
    expect(classify(0, true)).toBe("blocked");
    expect(classify(0, false)).toBe("captcha");
  });

  it("sees hCaptcha's challenge in its page-sized frame only while shown (Lever)", () => {
    const enclave = (style: string) =>
      `<iframe style="${style}" src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha-enclave.html#frame=en"></iframe>`;
    const big = () => {
      const f = document.querySelector("iframe")!;
      f.getBoundingClientRect = () => ({
        width: 1366,
        height: 900,
        top: 0,
        left: 0,
        right: 1366,
        bottom: 900,
        x: 0,
        y: 0,
        toJSON() {},
      });
    };
    setBody(enclave("visibility:hidden"));
    big();
    expect(captchaShown()).toBe(false);
    setBody(enclave(""));
    big();
    expect(captchaShown()).toBe(true);
  });

  it("does not mistake SmartRecruiters' support chat for an embedded application", () => {
    setBody(
      `<iframe src="https://eu.winstonchat.smartrecruiters.com/v2?parentUrl=https%3A%2F%2Fjobs.smartrecruiters.com%2FWesternDigital%2Fposting"></iframe>`,
    );
    const f = document.querySelector("iframe")!;
    f.getBoundingClientRect = () => ({
      width: 370,
      height: 404,
      top: 0,
      left: 0,
      right: 370,
      bottom: 404,
      x: 0,
      y: 0,
      toJSON() {},
    });
    expect(embeddedForm()).toBeNull();
    expect(pageFacts({ fields: 0, requiredFields: 0 }).embedded).toBe(false);
    setBody(
      `<iframe src="https://jobs.smartrecruiters.com/oneclick-ui/company/WesternDigital/publication/id"></iframe>`,
    );
    const application = document.querySelector("iframe")!;
    application.getBoundingClientRect = f.getBoundingClientRect;
    expect(embeddedForm()).toBe("https://jobs.smartrecruiters.com/oneclick-ui/company/WesternDigital/publication/id");
  });

  it("sends a Cloudflare check in the hidden frame to a tab, where it often passes by itself", () => {
    setBody(`<iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"></iframe>`);
    const f = document.querySelector("iframe")!;
    f.getBoundingClientRect = () => ({
      width: 300,
      height: 65,
      top: 0,
      left: 0,
      right: 300,
      bottom: 65,
      x: 0,
      y: 0,
      toJSON() {},
    });
    expect(classify(0, true)).toBe("blocked");
    expect(classify(0, false)).toBe("captcha");
  });

  it("tells a posting from a form", () => {
    setBody(`<h1>Software Engineer Intern</h1><p>About the role</p><a href="/apply">Apply now</a>`);
    expect(classify(0)).toBe("job");
    // A real link remains an application entrance even when surrounding job-page chrome has several controls.
    expect(classify(4)).toBe("job");
    // Indeed's posting has a What / Where search box.
    setBody(`<form><input aria-label="What"><input aria-label="Where"></form><button>Apply on company site</button>`);
    expect(classify(2)).toBe("job");
    // A job page can have several scan-visible filters/newsletter controls. Its specific CTA must still open the
    // application; a generic "Apply" at the end of a form does not get this exception.
    setBody(
      `<input aria-label="Keywords"><input aria-label="Location"><input aria-label="Email"><select aria-label="Team"><option>All</option></select><button>Apply to this job</button>`,
    );
    expect(classify(4)).toBe("job");
    // A form action with the same wording must stay a form: its required fields need the normal fill, validation,
    // and (in test builds) dry-run path rather than a navigation click.
    setBody(
      `<form><input required><input required><input required><button type="submit">Apply to this job</button></form>`,
    );
    expect(classify(3, false, 3)).toBe("form");
    setBody(
      `<input aria-required="true"><input aria-required="true"><input aria-required="true"><button type="button">Apply to this job</button>`,
    );
    expect(classify(3, false, 3)).toBe("form");
    // A page-wide form (ASP.NET) makes the posting's own Apply a native submit.
    setBody(
      `<form><input aria-label="Search jobs"><p>About the role</p><button type="submit">Apply to this job</button></form>`,
    );
    expect(classify(1)).toBe("job");
    setBody(`<form><button type="submit">Apply</button></form>`);
    expect(classify(0)).toBe("form");
    setBody(`<h2>Review</h2><button>Submit application</button>`);
    expect(classify(0)).toBe("form");
    setBody(`<h1>Careers</h1>`);
    expect(classify(0)).toBe("unknown");
  });
});

describe("YOLO buttons", () => {
  it("prefers Workday's own controls, Apply Manually first", () => {
    setBody(`<button data-automation-id="adventureButton">Apply</button>
      <div role="dialog"><a data-automation-id="autofillWithResume" href="#">Autofill with Resume</a>
      <a data-automation-id="applyManually" href="#">Apply Manually</a></div>`);
    expect(findApply()?.dataset.automationId).toBe("applyManually");
    setBody(`<button data-automation-id="pageFooterNextButton">Save and Continue</button><button>Back</button>`);
    expect(findNext()?.textContent).toBe("Save and Continue");
  });

  it("starts as a first-time applicant beside a login it has no account for", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: async () => null } });
    // EA's Avature: a login, and a résumé upload for first-time applicants.
    setBody(`<form><input name="username"><input type="password"><button>Log in</button></form>
      <form><input type="file" name="resumeFile"><button type="button">Continue</button></form>`);
    let filled = 0;
    let pressed = false;
    document.querySelectorAll("button")[1].addEventListener("click", () => (pressed = true));
    expect(await handleAuth("signin", async () => void filled++)).toEqual({ ok: true });
    expect([filled, pressed]).toEqual([1, true]);
    setBody(`<form><input name="username"><input type="password"><button>Log in</button></form>`);
    expect(await handleAuth("signin", async () => undefined)).toEqual({ fail: "Needs an account it can't create" });
    // National Bank's Avature: "Don't have a profile yet? … Create profile".
    setBody(`<form><input name="username"><input type="password"><button>Log in</button></form>
      <p>Don't have a profile yet? Create your profile here.</p><a href="#">Create profile</a>`);
    let toSignup = false;
    document.querySelector("a")!.addEventListener("click", () => (toSignup = true));
    expect(await handleAuth("signin", async () => undefined)).toEqual({ ok: true });
    expect(toSignup).toBe(true);
    vi.unstubAllGlobals();
  });

  it("skips third-party sign-ins and back buttons, and takes the form's own submit", () => {
    setBody(`<button>Apply with LinkedIn</button><button>Apply</button>`);
    expect(findApply()?.textContent).toBe("Apply");
    setBody(`<h2>Data Consent</h2><button>I Accept</button>`);
    expect(findNext()?.textContent).toBe("I Accept");
    setBody(`<button>Back</button><button>Continue</button>`);
    expect(findNext()?.textContent).toBe("Continue");
    setBody(`<button>Next →</button>`);
    expect(findNext()?.textContent).toBe("Next →");
    // iCIMS' first step, with the login inside the form.
    setBody(`<input type="submit" value="Submit Profile">`);
    expect(findNext()).not.toBeNull();
    setBody(`<button>Save as draft</button><button type="submit">Submit application</button>`);
    expect(findSubmit()?.textContent).toBe("Submit application");
    setBody(`<button disabled>Submit</button>`);
    expect(findSubmit()).toBeNull();
  });

  it("finds Apply buttons worded as their sites word them", () => {
    for (const label of [
      "Apply for this job online",
      "Apply to this job →",
      "Apply for this opportunity",
      "Apply Today",
    ]) {
      setBody(`<h1>Software Developer Co-op</h1><a href="/apply">${label}</a>`);
      expect(findApply()?.textContent, label).toBe(label);
    }
    setBody(`<button>Apply filters</button>`);
    expect(findApply()).toBeNull();
  });

  it("finds an Apply that is a clickable div or a link without an href", () => {
    setBody(`<h1>Software Developer Co-op</h1><a class="button apply">Apply to this job</a>`);
    expect(findApply()?.tagName).toBe("A");
    setBody(`<div class="apply-btn" style="cursor:pointer"><span>Apply to this job</span></div>`);
    expect(findApply()?.textContent).toBe("Apply to this job");
    // A section heading or plain text with the same words is not a control.
    setBody(`<h2>Apply for this job</h2><div>Apply for this job</div>`);
    expect(findApply()).toBeNull();
  });

  it("reads validation messages", () => {
    setBody(
      `<div role="alert">Saved</div><div class="field-error">This field is required</div><input aria-invalid="true">`,
    );
    expect(validationErrors().map((e) => e.tagName)).toEqual(["DIV", "INPUT"]);
  });

  it("keys site accounts per Workday tenant", () => {
    expect(siteKey()).toBe(location.hostname.replace(/^www\./, ""));
  });
});
