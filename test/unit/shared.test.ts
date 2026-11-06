import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chromeMock";
import { cleanLabel, humanize, normalize } from "../../src/shared/normalize";
import {
  canonicalCountry,
  canonicalRegion,
  optInAnswer,
  RE_CONSENT,
  RE_OPTIONAL_CONSENT,
  regionCode,
} from "../../src/shared/constants";
import { nextMidnightPacific } from "../../src/shared/time";
import { createStorage, migrate, SCHEMA_VERSION } from "../../src/shared/storage";
import type { JobContext } from "../../src/shared/types";
import { ProfileSchema } from "../../src/shared/profileSchema";
import { defaultSettings } from "../../src/shared/settings";
import { migrateYoloReview } from "../../src/shared/yolo";
import { ensureContentScript } from "../../src/shared/messages";

describe("normalize", () => {
  it("strips diacritics, lowercases, maps & and drops punctuation except + and #", () => {
    expect(normalize("  Résumé & CV!!  ")).toBe("resume and cv");
    expect(normalize("C++ / C#")).toBe("c++ c#");
    expect(normalize("Québec,   Canada.")).toBe("quebec canada");
    expect(normalize("I don't wish to answer")).toBe("i dont wish to answer");
  });
  it("humanizes names and cleans labels", () => {
    expect(humanize("firstName")).toBe("first name");
    expect(humanize("applicant[first_name]")).toBe("applicant first name");
    expect(cleanLabel("First name *")).toBe("First name");
    expect(cleanLabel("Phone (optional)")).toBe("Phone");
    expect(cleanLabel("Is a visa required")).toBe("Is a visa required");
  });
});

describe("consent patterns", () => {
  const required = [
    'By selecting "Consent", you consent that EA will process your personal data as described in the Candidate Privacy Notice.',
    "I certify that the information provided is accurate and complete, and understand false statements may disqualify me from this and other positions.",
    "I agree to the Terms of Service",
    // Workday account creation acknowledgement is required but not marked with native `required`.
    "Please select the checkbox to indicate your understanding and agreement with the above.",
    // Hugging Face (Workable), YES / NO.
    "Can you confirm that everything in this application is true and your own, including your experience and identity?",
    // CIBC (Workday) self-identification statement: a box per acknowledgement.
    "I have read the above statement.",
  ];
  const optional = [
    "I want EA recruiters to contact me in relation to other relevant job opportunities, including related events. I understand that I can withdraw my consent at any time by clicking unsubscribe on any emails received from EA.",
    "Join our talent community",
    "I'd like to be considered for future openings",
    "Send me marketing emails",
    "Receive alerts for similar jobs?",
    "Would you like to stay up to date with MongoDB Culture and Careers content?",
    // NinjaOne (Jobvite), Yes / No.
    "Can NinjaOne text you about your application?",
    // Match Group (Lever): keeping the data past the standard period is optional.
    "I consent to the retention of my personal data for the purpose of considering me for employment for an additional 2 years (i.e. 4 years total). I understand I may withdraw my consent at any time.",
  ];
  it("tells required from optional consents", () => {
    for (const t of [...required, ...optional]) expect(RE_CONSENT.test(t) || RE_OPTIONAL_CONSENT.test(t)).toBe(true);
    for (const t of required) expect(RE_OPTIONAL_CONSENT.test(t)).toBe(false);
    for (const t of optional) expect(RE_OPTIONAL_CONSENT.test(t)).toBe(true);
  });
});

describe("job-opportunity and marketing opt-ins", () => {
  const prefs = { consentToJobOpportunities: "yes", consentToMarketing: "no" } as const;
  const jobs = [
    "I agree to receive updates about new job opportunities.",
    "I want EA recruiters to contact me in relation to other relevant job opportunities, including related events.",
    "Join our talent community",
    "I'd like to be considered for future openings",
    "Receive alerts for similar jobs?",
    "Would you like us to consider you for other roles?",
    "May we contact you about roles that match your profile?",
    "Can we keep in touch about upcoming opportunities?",
    "Keep my resume on file for future opportunities",
    "Would you like to receive updates on new marketing roles?",
  ];
  const marketing = [
    "I agree to receive marketing communications.",
    "Send me marketing emails",
    "Subscribe to our newsletter",
    "I'd like to receive news, offers and promotions from Acme",
    "May we share your information with partners for advertising?",
    "I agree to be contacted by the sales team",
    "Would you like to be added to our mailing list?",
    // Names both: declined since marketing is.
    "Receive marketing emails and updates about new job opportunities",
  ];
  const neither = [
    "I certify that the information provided is accurate and complete, and understand false statements may disqualify me from this and other positions.",
    "I agree to the Terms of Service",
    "Can NinjaOne text you about your application?",
    "Receive SMS updates about this job opportunity",
    "Have you been contacted by a recruiter about other positions?",
    "Have you previously joined our talent community?",
    "How did you hear about this job opportunity?",
    "Do you have experience in marketing communications?",
    "Are you interested in joining our marketing team?",
    "Are you currently looking for new opportunities?",
    "Would you be willing to relocate for other positions?",
    "Advertising",
  ];
  it("answers each topic from its own preference", () => {
    for (const t of jobs) expect(optInAnswer(t, prefs), t).toBe("yes");
    for (const t of marketing) expect(optInAnswer(t, prefs), t).toBe("no");
    for (const t of neither) expect(optInAnswer(t, prefs), t).toBe("");
  });
  it("leaves unset topics to the consent settings", () => {
    const unset = { consentToJobOpportunities: "", consentToMarketing: "" } as const;
    for (const t of [...jobs, ...marketing]) expect(optInAnswer(t, unset), t).toBe("");
    // Both named, one accepted and one unset: not accepted for the unset one.
    expect(optInAnswer(marketing.at(-1)!, { ...unset, consentToJobOpportunities: "yes" })).toBe("");
  });
});

describe("alias tables", () => {
  it("resolves countries by ISO-2, ISO-3 and common names", () => {
    const us = canonicalCountry("United States");
    expect(us).toBeTruthy();
    for (const a of ["US", "usa", "USA", "United States of America", "u.s."]) expect(canonicalCountry(a)).toBe(us);
    expect(canonicalCountry("CAN")).toBe(canonicalCountry("Canada"));
    expect(canonicalCountry("UK")).toBe(canonicalCountry("GBR"));
    expect(canonicalCountry("Côte d’Ivoire")).toBe(canonicalCountry("Ivory Coast"));
    expect(canonicalCountry("Atlantis")).toBeNull();
  });
  it("resolves Canadian and US regions", () => {
    expect(canonicalRegion("BC")).toBe("british columbia");
    expect(canonicalRegion("British Columbia")).toBe("british columbia");
    expect(canonicalRegion("Québec")).toBe("quebec");
    expect(canonicalRegion("ny")).toBe("new york");
    expect(regionCode("Ontario")).toBe("ON");
  });
});

describe("nextMidnightPacific", () => {
  const laHour = (ts: number) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).format(ts);
  it("returns 00:00 Los Angeles time during PDT (UTC-7)", () => {
    const now = Date.UTC(2026, 6, 15, 18, 0); // 11:00 PDT
    const t = nextMidnightPacific(now);
    expect(t).toBe(Date.UTC(2026, 6, 16, 7, 0));
    expect(laHour(t)).toBe("00:00");
  });
  it("returns 00:00 Los Angeles time during PST (UTC-8)", () => {
    expect(nextMidnightPacific(Date.UTC(2026, 0, 10, 12, 0))).toBe(Date.UTC(2026, 0, 11, 8, 0));
  });
  it("handles the day DST starts and the day it ends", () => {
    // DST starts 2026-03-08 02:00 PST → next midnight is 2026-03-09 00:00 PDT = 07:00Z
    expect(nextMidnightPacific(Date.UTC(2026, 2, 8, 9, 0))).toBe(Date.UTC(2026, 2, 9, 7, 0));
    // Evening before DST starts (PST) → midnight 2026-03-08 00:00 PST = 08:00Z
    expect(nextMidnightPacific(Date.UTC(2026, 2, 8, 5, 0))).toBe(Date.UTC(2026, 2, 8, 8, 0));
    // DST ends 2026-11-01 02:00 PDT → next midnight is 2026-11-02 00:00 PST = 08:00Z
    expect(nextMidnightPacific(Date.UTC(2026, 10, 1, 12, 0))).toBe(Date.UTC(2026, 10, 2, 8, 0));
  });
  it("returns an exact midnight regardless of the current milliseconds", () => {
    expect(nextMidnightPacific(Date.UTC(2026, 6, 15, 18, 0, 0, 942))).toBe(Date.UTC(2026, 6, 16, 7, 0));
  });
  it("just after midnight returns the following midnight", () => {
    expect(nextMidnightPacific(Date.UTC(2026, 6, 16, 7, 0, 1))).toBe(Date.UTC(2026, 6, 17, 7, 0));
  });
});

describe("storage", () => {
  beforeEach(() => installChromeMock());

  it.each([false, true])(
    "migrates the shared review preference (%s) once, preserving other settings",
    async (reviewFills) => {
      await chrome.storage.local.set({
        schemaVersion: 1,
        settings: { reviewFills, draftEssays: false },
        yolo: { enabled: true, email: "yolo@example.com" },
        profile: { personal: { firstName: "Ada" } },
      });
      await migrate();
      const store = createStorage("background");
      expect(await store.get("schemaVersion")).toBe(SCHEMA_VERSION);
      expect(await store.get("settings")).toMatchObject({ reviewFills, draftEssays: false });
      expect(await store.get("yolo")).toMatchObject({
        reviewFills,
        aiNavigation: reviewFills,
        enabled: true,
        email: "yolo@example.com",
      });
      expect((await store.get("profile")).personal.firstName).toBe("Ada");
      await chrome.storage.local.set({ settings: { reviewFills: !reviewFills } });
      await migrate();
      expect((await store.get("yolo")).reviewFills).toBe(reviewFills);
    },
  );

  it.each([false, true])(
    "preserves independent YOLO AI settings (review %s) in migrations and imports",
    async (reviewFills) => {
      const yolo = { reviewFills, aiNavigation: !reviewFills, email: "yolo@example.com" };
      expect(migrateYoloReview(yolo, !reviewFills)).toMatchObject(yolo);
      expect(migrateYoloReview({ email: yolo.email }, reviewFills)).toMatchObject({
        reviewFills,
        aiNavigation: reviewFills,
        email: yolo.email,
      });
      await chrome.storage.local.set({ schemaVersion: 2, settings: { reviewFills: !reviewFills }, yolo });
      await migrate();
      expect(await createStorage("background").get("yolo")).toMatchObject(yolo);
    },
  );

  it.each([false, true])(
    "initializes navigation from YOLO review (%s), independently of manual review",
    async (reviewFills) => {
      const yolo = { reviewFills, email: "yolo@example.com" };
      await chrome.storage.local.set({ schemaVersion: 2, settings: { reviewFills: !reviewFills }, yolo });
      await migrate();
      const store = createStorage("background");
      expect(await store.get("yolo")).toMatchObject({ ...yolo, aiNavigation: reviewFills });
      expect((await store.get("settings")).reviewFills).toBe(!reviewFills);
      expect(migrateYoloReview(yolo, !reviewFills)).toMatchObject({ ...yolo, aiNavigation: reviewFills });
      await store.set({ yolo: { ...(await store.get("yolo")), reviewFills: !reviewFills } });
      await migrate();
      expect(await store.get("yolo")).toMatchObject({ reviewFills: !reviewFills, aiNavigation: reviewFills });
    },
  );

  it("falls back to defaults on missing or invalid data, keeping valid leaves", async () => {
    const store = createStorage("background");
    expect(await store.get("settings")).toEqual(defaultSettings());
    await chrome.storage.local.set({ settings: { draftEssays: "nope", essayDefaultWords: 200 } });
    const s = await store.get("settings");
    expect(s.draftEssays).toBe(true);
    expect(s.essayDefaultWords).toBe(200);
    await chrome.storage.local.set({ profile: { personal: { firstName: "Ada", email: 42 } } });
    const p = await store.get("profile");
    expect(p.personal.firstName).toBe("Ada");
    expect(p.personal.email).toBe("");
    expect(p.education).toEqual([]);
  });

  it("enforces the per-context allow-list (popup cannot read apiKeys)", async () => {
    const popup = createStorage("popup");
    await expect(popup.get("apiKeys")).rejects.toThrow(/not allowed/);
    await expect(popup.get("settings")).resolves.toBeTruthy();
  });

  it("drops invalid learned answers", () => {
    const p = ProfileSchema.parse({
      learnedAnswers: [{ bad: true }, { id: "x", question: "q", normalizedQuestion: "q", kind: "text", answer: "a" }],
    });
    expect(p.learnedAnswers).toHaveLength(1);
  });
});

describe("job context", () => {
  beforeEach(() => installChromeMock());

  it("adds an embedded form's description to the page's job, never its company or location", async () => {
    const { getJobContext, setJobContext } = await import("../../src/background/jobContext");
    const page = "https://block.xyz/careers/jobs/1";
    const job = (o: Partial<JobContext>): JobContext =>
      ({
        url: page,
        title: "",
        company: "Block",
        jobTitle: "Engineer",
        text: "",
        capturedAt: Date.now(),
        ...o,
      }) as JobContext;
    const frame = job({
      url: "https://job-boards.greenhouse.io/embed/job_app",
      company: "job-boards",
      text: "About us",
    });
    // The page first, then its form's frame.
    await setJobContext(1, job({ location: "Bay Area, CA, US" }));
    await setJobContext(1, frame, page);
    expect(await getJobContext(1)).toMatchObject({ company: "Block", location: "Bay Area, CA, US", text: "About us" });
    // The frame first, then the page.
    await setJobContext(2, frame, page);
    await setJobContext(2, job({ location: "Bay Area, CA, US" }));
    expect(await getJobContext(2)).toMatchObject({ company: "Block", location: "Bay Area, CA, US", text: "About us" });
    // Step 2 of an application keeps step 1's job.
    await setJobContext(3, job({ text: "Step 1 description", location: "Dublin" }));
    await setJobContext(3, job({ url: page + "/step2", jobTitle: "Your details" }));
    expect(await getJobContext(3)).toMatchObject({ jobTitle: "Engineer", location: "Dublin" });
  });

  it("borrows the posting of the tab that opened an application without a description", async () => {
    const { adoptPosting, getJobContext, setJobContext } = await import("../../src/background/jobContext");
    const job = (o: Partial<JobContext>): JobContext =>
      ({
        url: "https://board.com/jobs/1",
        title: "",
        company: "Board",
        jobTitle: "Engineer",
        text: "",
        capturedAt: Date.now(),
        ...o,
      }) as JobContext;
    const form = job({ url: "https://acme.com/apply", company: "acme", jobTitle: "Apply" });
    // The employer's form names the company; the board's posting gives the description and location.
    await adoptPosting(1, job({ text: "Write C++", location: "Vancouver" }));
    await setJobContext(1, form);
    expect(await getJobContext(1)).toMatchObject({ company: "acme", text: "Write C++", location: "Vancouver" });
    // Pinned: the board showing another job later changes nothing, nor does the form's next page.
    await adoptPosting(1, job({ text: "Sell ads" }));
    await setJobContext(1, { ...form, jobTitle: "Step 2", url: "https://acme.com/apply/2" });
    expect(await getJobContext(1)).toMatchObject({ jobTitle: "Apply", text: "Write C++" });
    // A form with its own description keeps it; a board page without a posting gives nothing.
    await setJobContext(2, job({ url: "https://acme.com/apply", text: "Own text" }));
    await adoptPosting(2, job({ text: "Write C++" }));
    expect(await getJobContext(2)).toMatchObject({ text: "Own text" });
    await adoptPosting(3, job({ text: "" }));
    await adoptPosting(4, null);
    expect([await getJobContext(3), await getJobContext(4)]).toEqual([null, null]);
    // A page of the form with its own description replaces what was borrowed.
    await setJobContext(1, job({ url: "https://acme.com/apply/3", text: "Own text" }));
    expect(await getJobContext(1)).toMatchObject({ text: "Own text" });
  });

  it("keeps a posting's pay for the application's later pages and the tabs it opens", async () => {
    const mock = installChromeMock();
    const tabs: Record<number, string> = { 1: "https://co.com/jobs/1" };
    Object.assign(mock, { tabs: { get: async (id: number) => ({ id, url: tabs[id] }) } });
    const { getJobPay, setJobPay } = await import("../../src/background/jobContext");
    const pay = { min: 1, max: 2, period: "hour" as const, currency: "" };
    await setJobPay({ id: 1, url: tabs[1] } as chrome.tabs.Tab, [pay]);
    // A frame of the same page without pay doesn't erase it.
    await setJobPay({ id: 1, url: tabs[1] } as chrome.tabs.Tab, []);
    expect(await getJobPay({ id: 1 } as chrome.tabs.Tab)).toEqual([pay]);
    const opened = { id: 2, openerTabId: 1 } as chrome.tabs.Tab;
    expect(await getJobPay(opened)).toEqual([pay]);
    tabs[1] = "https://co.com/jobs/2";
    expect(await getJobPay(opened)).toEqual([]);
    // Another posting without pay replaces it.
    await setJobPay({ id: 1, url: tabs[1] } as chrome.tabs.Tab, []);
    expect(await getJobPay({ id: 1 } as chrome.tabs.Tab)).toEqual([]);
  });

  it("prunes only closed tabs' session keys", async () => {
    const mock = installChromeMock();
    const { session } = await import("../../src/shared/storage");
    await chrome.storage.session.set({ "jobContext:1": 1, "jobPay:2": 2, "tabStatus:1": 3, other: 4 });
    await session.pruneTabs(new Set([1]));
    expect(Object.keys(mock.storage.session.data()).sort()).toEqual(["jobContext:1", "other", "tabStatus:1"]);
  });
});

describe("ensureContentScript", () => {
  it("injects only frames without an instance and reports frames a fresh copy can't reach", async () => {
    const executeScript = vi.fn(async (o: { target: { frameIds?: number[] } }) =>
      o.target.frameIds
        ? []
        : [
            { frameId: 0, result: "ok" },
            { frameId: 3, result: "missing" },
            { frameId: 5, result: "dead" },
          ],
    );
    const getManifest = () => ({ content_scripts: [{ js: ["src/content/index.js"] }] });
    vi.stubGlobal("chrome", { scripting: { executeScript }, runtime: { getManifest } });
    expect(await ensureContentScript(7)).toBe(false);
    expect(executeScript).toHaveBeenLastCalledWith({
      target: { tabId: 7, frameIds: [3] },
      files: ["src/content/index.js"],
    });
    vi.unstubAllGlobals();
  });
});
