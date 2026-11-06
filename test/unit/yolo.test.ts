import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { installChromeMock } from "./chromeMock";
import { altKey, applyUrl, jobKey } from "../../src/background/yolo/jobKey";
import {
  glassdoorSearch,
  jobrightFeed,
  parseFeed,
  parseGlassdoor,
  indeedSignedOut,
  parseIndeed,
  parseJobrightFeed,
  parseLinkedIn,
} from "../../src/background/yolo/sources";
import { boardOf, findOnEmployerBoard, jobLinks, sameTitle, workdayPosted } from "../../src/background/yolo/careers";
import { locationMatches, rejectReason, titleMatches } from "../../src/background/yolo/filter";
import { loadPlaces, PLACES_FILE } from "../../src/background/yolo/places";
import { connectGmail, extract, feedTexts, GmailAuthError, gmailToken, siteOf } from "../../src/background/yolo/gmail";
import { letterText, LINES_PER_PAGE, textLines, textPdf, wrap } from "../../src/background/yolo/pdf";
import { ONE_PAGE_WORDS } from "../../src/shared/constants";
import { decrypt, encrypt, newPassword } from "../../src/background/yolo/vault";
import { applied, discover, inQueueOrder, RETRY } from "../../src/background/yolo/discover";
import { credit, overdue, woke, type Run } from "../../src/background/yolo/runner";
import { mapFields } from "../../src/background/services/mapFields";
import type { Gemini } from "../../src/background/gemini/client";
import { defaultSettings } from "../../src/shared/settings";
import { emptyProfile } from "../../src/shared/profileSchema";
import { defaultYolo, YoloSchema, type Application, type Listing, type SourceCheck } from "../../src/shared/yolo";
import type { FieldDescriptor } from "../../src/shared/types";

beforeAll(() => loadPlaces(() => readFile(`public/${PLACES_FILE}`, "utf8")));

describe("job keys", () => {
  it("names a Workday requisition once across its location copies and apply steps", () => {
    const a = jobKey(
      "https://manulife.wd3.myworkdayjobs.com/en-US/MFCJH_AdminJobs/job/Waterloo%2C-Ontario/Summer-Intern-2027---Software-Engineering_JR26081686-1/apply/applyManually?utm_source=x",
    );
    const b = jobKey("https://manulife.wd3.myworkdayjobs.com/MFCJH_AdminJobs/job/Toronto/Summer-Intern_JR26081686-2");
    expect(a).toBe("workday:manulife:jr26081686");
    expect(b).toBe(a);
  });

  it("matches a company page's gh_jid to the Greenhouse board's job", () => {
    expect(jobKey("https://www.pinterestcareers.com/jobs/8138039/software-intern/?gh_jid=8138039")).toBe(
      "greenhouse:8138039",
    );
    expect(jobKey("https://job-boards.greenhouse.io/pinterest/jobs/8138039?gh_src=abc")).toBe("greenhouse:8138039");
    expect(jobKey("https://boards.greenhouse.io/embed/job_app?for=pinterest&token=8138039")).toBe("greenhouse:8138039");
  });

  it("ignores ATS apply steps and tracking parameters", () => {
    const u = "2bad3e47-6c00-4ec2-94b5-feb4009619c9";
    expect(jobKey(`https://jobs.lever.co/upscale-ai/${u}/apply?lever-source=x`)).toBe(
      jobKey(`https://jobs.lever.co/upscale-ai/${u}`),
    );
    expect(jobKey(`https://jobs.ashbyhq.com/1password/${u}/application?embed=true`)).toBe(`ashby:${u}`);
    expect(jobKey("https://ca.linkedin.com/jobs/view/software-engineer-intern-at-lyft-4466425159?position=1")).toBe(
      "linkedin:4466425159",
    );
    expect(jobKey("https://www.glassdoor.ca/job-listing/x-JV_IC2.htm?jl=1010271659983&cs=1")).toBe(
      "glassdoor:1010271659983",
    );
    expect(jobKey("https://careers.example.com/Jobs/42?utm_source=a&ref=b")).toBe("careers.example.com/jobs/42");
  });

  it("starts applications on the form page where the URL allows", () => {
    expect(applyUrl("https://jobs.lever.co/co/abc-123")).toBe("https://jobs.lever.co/co/abc-123/apply");
    expect(applyUrl("https://jobs.ashbyhq.com/org/abc-123?utm_source=x")).toBe(
      "https://jobs.ashbyhq.com/org/abc-123/application",
    );
    expect(applyUrl("https://co.wd1.myworkdayjobs.com/Site/job/Toronto/Intern_R1")).toBe(
      "https://co.wd1.myworkdayjobs.com/Site/job/Toronto/Intern_R1/apply/applyManually",
    );
    expect(applyUrl("https://apply.workable.com/co/j/1AF4F8C65F")).toBe(
      "https://apply.workable.com/co/j/1AF4F8C65F/apply",
    );
    expect(applyUrl("https://job-boards.greenhouse.io/co/jobs/1")).toBe("https://job-boards.greenhouse.io/co/jobs/1");
  });

  it("keys company and title as boards and the employer word them", () => {
    expect(altKey("Lyft, Inc.", "Software Engineering Internship (Summer 2027)")).toBe(
      altKey("lyft", "Software Engineer Intern"),
    );
    expect(altKey("Ciena", "Software Developer Co-op - Winter 2027")).toBe(
      altKey("Ciena", "Software Developer Intern"),
    );
    expect(altKey("Acme", "Software Engineer Intern")).not.toBe(altKey("Acme", "Hardware Engineer Intern"));
  });
});

describe("sources", () => {
  it("reads a SimplifyJobs listings.json, skipping closed and hidden postings", () => {
    const body = JSON.stringify([
      {
        company_name: "Lyft",
        title: "SWE Intern",
        url: "https://a/1",
        locations: ["Toronto, ON"],
        date_posted: 1792968258,
        active: true,
        is_visible: true,
      },
      { company_name: "Old", title: "SWE Intern", url: "https://a/2", locations: [], active: false, is_visible: true },
      {
        company_name: "Hidden",
        title: "SWE Intern",
        url: "https://a/3",
        locations: [],
        active: true,
        is_visible: false,
      },
    ]);
    expect(parseFeed(body, "SimplifyJobs/x")).toEqual([
      {
        url: "https://a/1",
        company: "Lyft",
        title: "SWE Intern",
        location: "Toronto, ON",
        postedAt: 1792968258000,
        source: "SimplifyJobs/x",
      },
    ]);
  });

  it("reads README job tables in Markdown and HTML", () => {
    const md = `| Company | Role | Location | Application | Age |
| --- | --- | --- | :---: | --- |
| **[Acme](https://simplify.jobs/c/Acme)** | Software Engineer Intern | Toronto, ON | <a href="https://jobs.lever.co/acme/1?utm_source=Simplify"><img src="https://i.imgur.com/x.png"></a> | 0d |
| ↳ | Data Intern | Remote | [Apply](https://jobs.lever.co/acme/2) | 1d |
| Closed Co | SWE Intern | NYC | 🔒 | 3d |
<table><tr><td><strong><a href="https://simplify.jobs/c/Beta">Beta</a></strong></td><td>SWE Intern</td><td>Seattle, WA</br>Remote</td><td><a href="https://job-boards.greenhouse.io/beta/jobs/9"><img></a></td><td>0d</td></tr></table>`;
    expect(parseFeed(md, "r").map((l) => [l.company, l.title, l.location, l.url])).toEqual([
      ["Beta", "SWE Intern", "Seattle, WA; Remote", "https://job-boards.greenhouse.io/beta/jobs/9"],
      ["Acme", "Software Engineer Intern", "Toronto, ON", "https://jobs.lever.co/acme/1?utm_source=Simplify"],
      ["Acme", "Data Intern", "Remote", "https://jobs.lever.co/acme/2"],
    ]);
  });

  it("reads LinkedIn's logged-out search cards", () => {
    const html = `<li><div class="base-card relative w-full" data-entity-urn="urn:li:jobPosting:4466425159" data-row="1">
      <a class="base-card__full-link" href="https://ca.linkedin.com/jobs/view/x-4466425159?position=1"></a>
      <h3 class="base-search-card__title">
            Software Engineer Intern, Machine Learning &amp; AI
          </h3>
      <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://www.linkedin.com/company/lyft">Lyft</a></h4>
      <span class="job-search-card__location">Toronto, Ontario, Canada</span>
      <time class="job-search-card__listdate" datetime="2026-10-25">1 day ago</time></div></li>`;
    expect(parseLinkedIn(html)).toEqual([
      {
        url: "https://www.linkedin.com/jobs/view/4466425159",
        title: "Software Engineer Intern, Machine Learning & AI",
        company: "Lyft",
        location: "Toronto, Ontario, Canada",
        postedAt: Date.parse("2026-10-25"),
        source: "linkedin",
      },
    ]);
  });

  it("reads Glassdoor cards, marking Easy Apply ones", () => {
    const card = (id: string, easy: boolean) => `<li data-jobid="${id}"><div data-test="job-card-wrapper">
      <span class="EmployerProfile_compactEmployerName__9MGcV">General Dynamics</span>
      <a data-test="job-title" href="https://www.glassdoor.ca/job-listing/x-JV_IC1.htm?jl=${id}" id="job-title-${id}">Student, Software Test</a>
      <div data-test="emp-location" id="job-location-${id}">London</div>
      ${easy ? '<button aria-label="Easy Apply"></button>' : ""}<div data-test="job-age">3d</div></div></li>`;
    const now = Date.UTC(2026, 9, 26);
    const out = parseGlassdoor(card("1", false) + card("2", true), now);
    expect(out[0]).toMatchObject({
      url: "https://www.glassdoor.ca/job-listing/x-JV_IC1.htm?jl=1",
      title: "Student, Software Test",
      company: "General Dynamics",
      location: "London",
      postedAt: now - 3 * 86400e3,
      source: "glassdoor",
    });
    expect(out[0].easyApply).toBeUndefined();
    expect(out[1].easyApply).toBe(true);
  });

  it("reads Indeed's result cards from the job-card data its search page embeds", () => {
    const cards = [
      {
        jobkey: "abc123",
        displayTitle: "Software Developer Intern",
        company: "Shopify",
        formattedLocation: "Toronto, ON",
        pubDate: Date.UTC(2026, 10, 3),
        indeedApplyEnabled: false,
        snippet: '<ul><li>Build {things}; "ship" them</li></ul>',
      },
      {
        jobkey: "def456",
        title: "QA Intern",
        truncatedCompany: "Acme &amp; Co",
        formattedLocation: "Remote",
        indeedApplyEnabled: true,
      },
      {
        jobkey: "aaa111",
        displayTitle: "Data Intern",
        company: "Beta",
        formattedLocation: "Ontario",
        remoteLocation: true,
        pubDate: 1762000000,
      },
      { jobkey: "abc123", displayTitle: "Software Developer Intern", company: "Shopify" },
      { jobkey: "bbb222", displayTitle: "Old", company: "Gone", expired: true },
      { displayTitle: "No key" },
    ];
    const page = `<html><head><title>Software Intern Jobs | Indeed</title></head><body><script>
window.mosaic.providerData["mosaic-provider-jobcards"]=${JSON.stringify({ metaData: { mosaicProviderJobCardsModel: { results: cards } } })};
window.mosaic.providerData["mosaic-provider-other"]={"a":"}"};</script></body></html>`;
    expect(parseIndeed(page, "ca.indeed.com")).toEqual([
      {
        url: "https://ca.indeed.com/viewjob?jk=abc123",
        title: "Software Developer Intern",
        company: "Shopify",
        location: "Toronto, ON",
        postedAt: Date.UTC(2026, 10, 3),
        source: "indeed",
        easyApply: undefined,
      },
      {
        url: "https://ca.indeed.com/viewjob?jk=def456",
        title: "QA Intern",
        company: "Acme & Co",
        location: "Remote",
        postedAt: undefined,
        source: "indeed",
        easyApply: true,
      },
      {
        url: "https://ca.indeed.com/viewjob?jk=aaa111",
        title: "Data Intern",
        company: "Beta",
        location: "Remote - Ontario",
        // Seconds, not ms: left out rather than read as 1970.
        postedAt: undefined,
        source: "indeed",
        easyApply: undefined,
      },
    ]);
    // A bot check, live shapes: Cloudflare's interstitial, and Indeed's block page.
    expect(parseIndeed("<title>Just a moment...</title>", "www.indeed.com")).toBeNull();
    expect(parseIndeed("<title>Security Check - Indeed.com</title>", "www.indeed.com")).toBeNull();
    expect(parseIndeed("<h1>Request Blocked</h1><p>Your Ray ID is a551aa1e</p>", "www.indeed.com")).toBeNull();
    // A page without cards that isn't a bot check reads as no results.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseIndeed("<title>Indeed</title><p>No jobs</p>", "www.indeed.com")).toEqual([]);
    expect(parseIndeed("", "www.indeed.com")).toEqual([]);
  });

  it("tells Indeed's sign-in page from the account page it guards", () => {
    expect(indeedSignedOut("https://secure.indeed.com/auth?hl=en&continue=%2Fsettings%2Faccount")).toBe(true);
    expect(indeedSignedOut("https://secure.indeed.com/account/login?continue=x")).toBe(true);
    expect(indeedSignedOut("https://secure.indeed.com/settings/account")).toBe(false);
    expect(indeedSignedOut("")).toBe(false);
  });

  it("reads Jobright's recommendations as employer postings, never a LinkedIn or Jobright link", () => {
    const job = (jobResult: object, companyName = "Vena Solutions") => ({
      jobResult: {
        jobTitle: "Software Developer Co-op",
        jobLocation: "Toronto, ON",
        publishTime: "2026-11-03 14:40:16",
        applyLink: "https://vena.pinpointhq.com/postings/1",
        ...jobResult,
      },
      companyResult: { companyName },
    });
    const out = parseJobrightFeed([
      job({}),
      job({ jobLocation: "Canada", jobLocations: ["Canada"], workModel: "Remote", isRemote: true }),
      job({ jobLocations: ["Ottawa, ON", "Remote, Canada"], workModel: "Hybrid" }),
      job({ applyLink: "https://www.linkedin.com/jobs/view/1" }),
      job({ applyLink: "https://jobright.ai/jobs/info/1" }),
      job({ isDeleted: true }),
      job({ applyLink: undefined }),
    ]);
    expect(out.map((l) => [l.company, l.title, l.location, l.url, l.source])).toEqual([
      [
        "Vena Solutions",
        "Software Developer Co-op",
        "Toronto, ON",
        "https://vena.pinpointhq.com/postings/1",
        "jobright",
      ],
      [
        "Vena Solutions",
        "Software Developer Co-op",
        "Remote - Canada",
        "https://vena.pinpointhq.com/postings/1",
        "jobright",
      ],
      [
        "Vena Solutions",
        "Software Developer Co-op",
        "Ottawa, ON; Remote, Canada",
        "https://vena.pinpointhq.com/postings/1",
        "jobright",
      ],
    ]);
    expect(out[0].postedAt).toBe(Date.UTC(2026, 10, 3, 14, 40, 16));
    // A cursor: the first page starts the list afresh, the rest continue it.
    expect(new URL(jobrightFeed(0)).searchParams.get("refresh")).toBe("true");
    expect(Object.fromEntries(new URL(jobrightFeed(2)).searchParams)).toMatchObject({
      refresh: "false",
      position: "40",
    });
  });
});

describe("employer boards", () => {
  it("recognizes career-site URLs with an API", () => {
    expect(boardOf("https://cadence.wd1.myworkdayjobs.com/en-US/External_Careers")).toEqual({
      ats: "workday",
      slug: "cadence",
      site: "External_Careers",
      host: "cadence.wd1.myworkdayjobs.com",
    });
    expect(boardOf("https://job-boards.greenhouse.io/amperesand")).toEqual({ ats: "greenhouse", slug: "amperesand" });
    expect(boardOf("https://jobs.lever.co/upscale-ai")).toEqual({ ats: "lever", slug: "upscale-ai" });
    expect(boardOf("https://jobs.sap.com/search/?q=intern")).toBeNull();
  });

  it("dates Workday postings and compares titles loosely", () => {
    const now = 1_000_000_000_000;
    expect(workdayPosted("Posted Today", now)).toBe(now);
    expect(workdayPosted("Posted 3 Days Ago", now)).toBe(now - 3 * 86400e3);
    expect(workdayPosted("Posted 30+ Days Ago", now)).toBe(now - 30 * 86400e3);
    expect(sameTitle("Software Engineer Intern - Summer 2027", "software engineer intern")).toBe(true);
    expect(sameTitle("Software Engineer Intern", "Hardware Engineer Intern")).toBe(false);
  });

  it("reads job links off a rendered career page", () => {
    const out = jobLinks(
      [
        { href: "/job/Kirkland-Data-Intern-WA/1450518033/", text: "Data Intern", card: "Data Intern\nKirkland, WA" },
        { href: "/job/Kirkland-Data-Intern-WA/1450518033/", text: "Apply now" },
        { href: "/about-us", text: "About us" },
      ],
      "paccar",
      "https://jobs.paccar.com/search?q=intern",
    );
    expect(out).toEqual([
      {
        url: "https://jobs.paccar.com/job/Kirkland-Data-Intern-WA/1450518033/",
        title: "Data Intern",
        company: "paccar",
        location: "Kirkland, WA",
        source: "careers",
      },
    ]);
    // Recruitee's posting links carry no number.
    const recruitee = jobLinks(
      [
        { href: "https://huaweicanada.recruitee.com/o/intern-engineer-ai", text: "Intern Engineer - AI" },
        { href: "https://huaweicanada.recruitee.com/o/intern-engineer-ai", text: "Apply" },
        { href: "https://huaweicanada.recruitee.com/?jobs[search]=intern", text: "Search jobs" },
      ],
      "huaweicanada",
      "https://huaweicanada.recruitee.com/",
    );
    expect(recruitee.map((l) => [l.url, l.title])).toEqual([
      ["https://huaweicanada.recruitee.com/o/intern-engineer-ai", "Intern Engineer - AI"],
    ]);
  });

  it("finds a board listing on the employer's own ATS, remembering which board it is", async () => {
    const calls: string[] = [];
    const f = async (url: string) => {
      calls.push(url);
      if (url === "https://boards-api.greenhouse.io/v1/boards/lyft/jobs")
        return new Response(
          JSON.stringify({
            jobs: [
              {
                absolute_url: "https://lyft.com/jobs/1?gh_jid=1",
                title: "Software Engineer Intern",
                location: { name: "Toronto" },
              },
            ],
          }),
        );
      return new Response("", { status: 404 });
    };
    const known: Record<string, string> = {};
    const l: Listing = {
      url: "https://www.linkedin.com/jobs/view/1",
      company: "Lyft",
      title: "Software Engineer Intern - Summer 2027",
      location: "Toronto",
      source: "linkedin",
    };
    expect(await findOnEmployerBoard(f, l, known, new Map())).toBe("https://lyft.com/jobs/1?gh_jid=1");
    expect(known).toEqual({ lyft: "greenhouse:lyft" });
    calls.length = 0;
    expect(await findOnEmployerBoard(f, { ...l, company: "Nobody Corp" }, known, new Map())).toBeNull();
    expect(known["nobody corp"]).toBe("");
    const n = calls.length;
    await findOnEmployerBoard(f, { ...l, company: "Nobody Corp" }, known, new Map());
    expect(calls.length).toBe(n); // the miss is remembered
  });
});

describe("filters", () => {
  it("matches titles by every query word, with plurals and synonyms", () => {
    expect(titleMatches("Software Engineering Internship - Summer 2027", "Software Engineer Intern")).toBe(true);
    expect(titleMatches("Software Developer Co-op (Fall 2027)", "Software Engineer Intern")).toBe(true);
    expect(titleMatches("SWE Intern", "Software Engineer Intern")).toBe(true);
    expect(titleMatches("Application/Software Developer Co-op (Winter 2027)", "Software Developer Intern")).toBe(true);
    expect(titleMatches("Embedded C/C++ SW Developer Co-op/Intern", "Software Developer Co-op")).toBe(true);
    expect(titleMatches("Hardware Engineer Intern", "Software Engineer Intern")).toBe(false);
    expect(titleMatches("International Sales Associate", "Intern")).toBe(false);
  });

  it("matches places by country, city or remote", () => {
    expect(locationMatches("Toronto, ON, Canada", ["Canada"], false)).toBe(true);
    expect(locationMatches("Waterloo, ON", ["Canada"], false)).toBe(true);
    expect(locationMatches("San Francisco, CA; Toronto, ON", ["Canada"], false)).toBe(true);
    expect(locationMatches("Seattle, WA", ["Canada"], true)).toBe(false);
    expect(locationMatches("Remote in USA", ["Canada"], true)).toBe(false);
    expect(locationMatches("Remote", ["Canada"], true)).toBe(true);
    expect(locationMatches("Remote", ["Canada"], false)).toBe(false);
    expect(locationMatches("Seattle, WA", ["Seattle"], false)).toBe(true);
    expect(locationMatches("Anywhere", [], false)).toBe(true);
  });

  it("matches a city or region inside a wanted country or region", () => {
    expect(locationMatches("Kelowna", ["Canada"], false)).toBe(true);
    expect(locationMatches("Kelowna, BC", ["British Columbia"], false)).toBe(true);
    expect(locationMatches("Burnaby", ["BC"], false)).toBe(true);
    expect(locationMatches("Toronto, ON", ["Ontario"], false)).toBe(true);
    expect(locationMatches("Toronto, ON", ["British Columbia"], false)).toBe(false);
    expect(locationMatches("Ontario", ["Canada"], false)).toBe(true);
    expect(locationMatches("Redmond, Washington", ["United States"], false)).toBe(true);
    expect(locationMatches("Munich", ["Bavaria"], false)).toBe(true);
    expect(locationMatches("Bengaluru, IN", ["India"], false)).toBe(true);
    // The likeliest place for a bare name; a region or country part picks another.
    expect(locationMatches("London", ["Canada"], false)).toBe(false);
    expect(locationMatches("London, ON", ["Canada"], false)).toBe(true);
    expect(locationMatches("Vancouver, WA", ["British Columbia"], false)).toBe(false);
    expect(locationMatches("Vancouver, British Columbia", ["Vancouver, BC"], false)).toBe(true);
    // A country-wide remote job covers a wanted region; a region-wide one does not cover another region.
    expect(locationMatches("Remote - Canada", ["Ontario"], true)).toBe(true);
    expect(locationMatches("Remote - Ontario", ["British Columbia"], true)).toBe(false);
  });

  it("explains why a posting is skipped", () => {
    const y = { ...defaultYolo(), queries: ["Software Engineer Intern"], locations: ["Canada"] };
    const now = Date.UTC(2026, 9, 26);
    const l: Listing = {
      url: "u",
      company: "Acme",
      title: "Software Engineer Intern",
      location: "Toronto, ON",
      source: "x",
      postedAt: now,
    };
    expect(rejectReason(l, y, now)).toBeNull();
    expect(rejectReason({ ...l, easyApply: true }, y, now)).toMatch(/Easy Apply/);
    expect(rejectReason({ ...l, title: "Senior Software Engineer Intern" }, y, now)).toBe('Title has "senior"');
    expect(rejectReason({ ...l, location: "Austin, TX" }, y, now)).toBe("Location");
    expect(rejectReason({ ...l, postedAt: now - 30 * 86400e3 }, y, now)).toBe("Too old");
    expect(rejectReason({ ...l, company: "ACME" }, { ...y, skipCompanies: ["acme"] }, now)).toBe("Company skipped");
    // A career site the user pasted rarely says where each job is.
    expect(rejectReason({ ...l, location: "", source: "careers" }, y, now)).toBeNull();
  });

  it("never re-applies to YOLO's own attempts; to the user's only when allowed", () => {
    const a = (mode: Application["mode"], status: Application["status"]): Application => ({
      key: "k",
      alt: "",
      url: "",
      company: "",
      title: "",
      location: "",
      source: "",
      doneUrl: "",
      mode,
      status,
      reason: "",
      guesses: [],
      at: 0,
    });
    expect(applied([a("yolo", "failed")], "k", "", true)).toBe(true);
    expect(applied([a("manual", "submitted")], "k", "", false)).toBe(true);
    expect(applied([a("manual", "submitted")], "k", "", true)).toBe(false);
    expect(applied([a("yolo", "submitted")], "other", "", false)).toBe(false);
  });
});

describe("verification emails", () => {
  it("finds the verification link, not the unsubscribe one", () => {
    const html = `<a href="https://x.com/unsubscribe?u=1">Unsubscribe</a>
      <a href="https://wd5.myworkday.com/acme/verify?token=abc&amp;t=1">Verify Account</a>`;
    expect(extract(html, "link")).toBe("https://wd5.myworkday.com/acme/verify?token=abc&t=1");
  });

  it("only takes a link back to the run's sites, or a tracked Verify button", () => {
    const html = `<a href="https://evil.example/verify?t=1">Verify</a>
      <a href="https://acme.wd5.myworkdayjobs.com/en-US/careers/activate/abc">Activate</a>`;
    expect(extract(html, "link", [siteOf("acme.wd5.myworkdayjobs.com")])).toBe(
      "https://acme.wd5.myworkdayjobs.com/en-US/careers/activate/abc",
    );
    expect(extract(html, "link", [siteOf("jobs.other.com")])).toBeNull();
    // A click tracker hides where it leads: only its Verify button, never its other links or an unknown host's.
    const tracked = `<a href="https://u1.ct.sendgrid.net/ls/click?upn=aaa">Unsubscribe</a>
      <a href="https://evil.example/c/xyz"><b>Confirm email</b></a>
      <a href="https://u1.ct.sendgrid.net/ls/click?upn=bbb"><span>Verify my email</span></a>`;
    expect(extract(tracked, "link", ["acme.com"])).toBe("https://u1.ct.sendgrid.net/ls/click?upn=bbb");
    // The site's own link wins over a tracked one.
    expect(extract(`${tracked}<a href="https://jobs.acme.com/confirm?t=1">here</a>`, "link", ["acme.com"])).toBe(
      "https://jobs.acme.com/confirm?t=1",
    );
    expect(siteOf("careers.acme.co.uk")).toBe("acme.co.uk");
    expect(siteOf("wd5.myworkday.com")).toBe(siteOf("acme.wd1.myworkdaysite.com"));
    expect(siteOf("myworkday.com.evil.io")).toBe("evil.io");
  });

  it("reads codes from Gmail's unread-mail feed for the right account", () => {
    const xml = `<feed><title>Gmail - Inbox for andywu9509@gmail.com</title>
      <entry><title>Security code for your application to HeyGen</title><summary>Copy and paste this code into the security code field on your application: x7Kq9mPa This code expires</summary><issued>2026-10-26T06:00:00Z</issued></entry>
      <entry><title>Old</title><summary>Your code is 111111</summary><issued>2026-10-20T06:00:00Z</issued></entry></feed>`;
    const since = Date.parse("2026-10-26T05:55:00Z");
    const texts = feedTexts(xml, "andywu9509+jobs@gmail.com", since)!;
    expect(texts).toHaveLength(1);
    expect(extract(texts[0], "code")).toBe("x7Kq9mPa");
    expect(feedTexts(xml, "someone@gmail.com", since)).toBeNull();
  });

  it("finds a one-time code", () => {
    expect(extract("<p>Your verification code is: <b>482913</b></p><p>Ref 2026</p>", "code")).toBe("482913");
    expect(extract("Use passcode X7K2QP to sign in", "code")).toBe("X7K2QP");
    expect(extract("Hello there", "code")).toBeNull();
  });
});

describe("cover letter PDF", () => {
  it("wraps text and writes a PDF whose cross-reference offsets point at its objects", () => {
    expect(wrap("one two three", 7)).toEqual(["one two", "three"]);
    const pdf = atob(textPdf(`Dear Hiring Team,\n\n${"I build things (well). ".repeat(400)}\n\nSincerely,\nAda`));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    const offsets = [...pdf.split("xref\n")[1].matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o).startsWith(`${i + 1} 0 obj<<`)).toBe(true));
    expect(Number(/startxref\n(\d+)/.exec(pdf)![1])).toBe(pdf.indexOf("xref\n"));
    expect(/\/Count (\d+)/.exec(pdf)![1]).not.toBe("1"); // long letters span pages
  });

  const pages = (text: string) => Number(/\/Count (\d+)/.exec(atob(textPdf(text)))![1]);
  const letter = (lines: number) => Array.from({ length: lines }, (_, i) => `Line ${i}.`).join("\n");

  it("knows before writing the PDF whether it fits on one page", () => {
    expect(textLines(letter(LINES_PER_PAGE))).toBe(LINES_PER_PAGE);
    expect(pages(letter(LINES_PER_PAGE))).toBe(1);
    expect(pages(letter(LINES_PER_PAGE + 1))).toBe(2);
  });

  it("with the one-page limit, caps the target, rewrites a letter that runs over once, and never passes a long one", async () => {
    const asked: number[] = [];
    const drafts =
      (...texts: string[]) =>
      async (words: number) => (asked.push(words), { text: texts.shift() ?? "" });
    const long = letter(60);

    // Off: the target as set, any length.
    expect(await letterText(drafts(long), 900, false)).toEqual({ text: long });
    expect(asked).toEqual([900]);

    asked.length = 0;
    expect(await letterText(drafts(letter(30)), 900, true)).toEqual({ text: letter(30) });
    expect(await letterText(drafts(letter(30)), 250, true)).toEqual({ text: letter(30) });
    expect(asked).toEqual([ONE_PAGE_WORDS, 250]);

    asked.length = 0;
    expect(await letterText(drafts(long, letter(40)), 300, true)).toEqual({ text: letter(40) });
    expect(asked[1]).toBeLessThan(120); // 120 words over 60 lines: about 44/60 of that, less a margin

    expect(await letterText(drafts(long, long), 300, true)).toEqual({
      error: "The cover letter ran over the one-page limit",
    });
    expect(await letterText(async () => ({ text: null, note: "Draft failed" }), 300, true)).toEqual({
      error: "Draft failed",
    });
  });
});

describe("vault", () => {
  it("round-trips passwords and makes ones every ATS accepts", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const e = await encrypt(key, "s3cret!");
    expect(e.ct).not.toContain("s3cret");
    expect(await decrypt(key, e)).toBe("s3cret!");
    for (let i = 0; i < 20; i++) {
      const p = newPassword();
      expect(p).toHaveLength(18);
      for (const re of [/[A-Z]/, /[a-z]/, /\d/, /[!@#$%^*_-]/]) expect(p).toMatch(re);
    }
  });
});

describe("Gmail sign-in", () => {
  it("keeps the refresh token so an extension reload renews silently", async () => {
    const chrome = installChromeMock();
    const saved = { fetch: globalThis.fetch, indexedDB: globalThis.indexedDB };
    onTestFinished(() => void Object.assign(globalThis, saved));
    // The vault's IndexedDB, in memory: one object store, get and put.
    const keys = new Map<string, unknown>();
    const req = (result: unknown) => {
      const r = { result } as { result: unknown; onsuccess?: () => void };
      queueMicrotask(() => r.onsuccess?.());
      return r;
    };
    const os = { get: (k: string) => req(keys.get(k)), put: (v: unknown, k: string) => req(keys.set(k, v)) };
    const db = { transaction: () => ({ objectStore: () => os }) };
    (globalThis as unknown as { indexedDB: unknown }).indexedDB = { open: () => req(db) };
    let url = "";
    Object.assign(chrome, {
      identity: {
        getRedirectURL: () => "https://ext.chromiumapp.org/",
        launchWebAuthFlow: async (o: { url: string }) => ((url = o.url), "https://ext.chromiumapp.org/?code=c1"),
      },
    });
    const bodies: URLSearchParams[] = [];
    const replies: [number, object][] = [
      [200, { access_token: "a1", refresh_token: "r1", expires_in: 3600 }],
      [200, { access_token: "a2", expires_in: 3600 }],
      [400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }],
      [503, {}],
    ];
    globalThis.fetch = (async (_u: string, init: { body: URLSearchParams }) => {
      bodies.push(init.body);
      const [status, json] = replies.shift()!;
      return new Response(JSON.stringify(json), { status });
    }) as unknown as typeof fetch;
    const c = { gmailClientId: "id", gmailClientSecret: "sec" };

    await connectGmail(c, "me+jobs@gmail.com");
    const q = new URL(url).searchParams;
    expect(q.get("login_hint")).toBe("me@gmail.com");
    expect(q.get("access_type")).toBe("offline");
    expect(bodies[0].get("code_verifier")).toBeTruthy();
    expect(JSON.stringify(chrome.storage.local.data())).not.toContain("r1");

    await chrome.storage.session.clear(); // extension reload
    expect(await gmailToken(c)).toBe("a2");
    expect(bodies[1].get("grant_type")).toBe("refresh_token");
    expect(bodies[1].get("refresh_token")).toBe("r1");
    expect(await gmailToken(c)).toBe("a2"); // cached: no request

    await chrome.storage.session.clear();
    await expect(gmailToken(c)).rejects.toBeInstanceOf(GmailAuthError);
    // Google down says nothing about the sign-in
    await expect(gmailToken(c)).rejects.not.toBeInstanceOf(GmailAuthError);
    expect(replies).toHaveLength(0);
  });
});

describe("discovery", () => {
  beforeEach(() => installChromeMock());

  it("queues new matching postings once, and re-downloads a feed only when it changed", async () => {
    const feed = "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/listings.json";
    const now = Date.UTC(2026, 9, 26);
    const rows = [
      {
        company_name: "Lyft",
        title: "Software Engineer Intern",
        url: "https://jobs.lever.co/lyft/a1",
        locations: ["Toronto, ON"],
        date_posted: now / 1000,
        active: true,
      },
      {
        company_name: "Acme",
        title: "Mechanical Intern",
        url: "https://jobs.lever.co/acme/b2",
        locations: ["Toronto, ON"],
        date_posted: now / 1000,
        active: true,
      },
      {
        company_name: "Done",
        title: "Software Engineer Intern",
        url: "https://jobs.lever.co/done/c3",
        locations: ["Toronto, ON"],
        date_posted: now / 1000,
        active: true,
      },
    ];
    const seenHeaders: Record<string, string>[] = [];
    const f = async (_url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenHeaders.push(h);
      return h["if-none-match"] === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify(rows), { headers: { etag: '"v1"' } });
    };
    await chrome.storage.local.set({
      applications: [{ key: "lever:c3", alt: "", url: "", mode: "manual", status: "submitted", at: 1 }],
    });
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      locations: ["Canada"],
      feeds: [feed],
      boards: [],
    };
    expect(await discover({ yolo: y, fetch: f, now })).toBe(1);
    const { yoloQueue } = (await chrome.storage.local.get("yoloQueue")) as {
      yoloQueue: { key: string; url: string }[];
    };
    expect(yoloQueue.map((i) => [i.key, i.url])).toEqual([["lever:a1", "https://jobs.lever.co/lyft/a1"]]);
    expect(await discover({ yolo: y, fetch: f, now })).toBe(0);
    expect(seenHeaders[1]).toEqual({ "if-none-match": '"v1"' });
  });

  it("pages LinkedIn only while the batch wants more postings on an employer's board, stopping at a failed page", async () => {
    const card = (id: number, title = `Software Engineer Intern ${id}`, company = "Acme") =>
      `<li data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">${title}</h3>
      <h4 class="base-search-card__subtitle">${company}</h4><span class="job-search-card__location">Toronto, ON</span></li>`;
    // Acme posts its jobs on Lever; Nobody's aren't on any board, so they don't count toward the batch.
    const lever = JSON.stringify(
      [1, 2, 3].map((n) => ({ text: `Software Engineer Intern ${n}`, hostedUrl: `https://jobs.lever.co/acme/${n}` })),
    );
    const pages: Record<number, string> = {
      0: card(1) + card(9, "Mechanical Intern"),
      10: card(1) + card(2) + card(7, "Software Engineer Intern", "Nobody"),
      20: card(8, "Software Engineer Intern", "Nobody"),
      30: card(3),
    };
    const gaps: number[] = [];
    const later = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(
      ((fn: () => void, ms?: number) => (gaps.push(ms ?? 0), later(fn, 0))) as typeof setTimeout,
    );
    onTestFinished(() => void vi.restoreAllMocks());
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      locations: ["Canada"],
      boards: ["linkedin" as const],
    };
    const run = async (want: number | undefined, fail = Infinity, fresh = true) => {
      if (fresh) installChromeMock();
      const starts: number[] = [];
      const f = async (url: string) => {
        if (url === "https://api.lever.co/v0/postings/acme?mode=json") return new Response(lever);
        if (!url.includes("linkedin")) return new Response("", { status: 404 });
        const start = Number(new URL(url).searchParams.get("start"));
        starts.push(start);
        return start >= fail ? new Response("", { status: 429 }) : new Response(pages[start] ?? "");
      };
      const n = await discover({ yolo: y, fetch: f, want });
      return [starts, n];
    };
    expect(await run(undefined)).toEqual([[0], 1]);
    expect(await run(0)).toEqual([[0], 1]);
    expect(await run(2)).toEqual([[0, 10], 2]);
    expect(await run(3)).toEqual([[0, 10, 20, 30], 3]);
    expect(await run(50)).toEqual([[0, 10, 20, 30, 40], 3]);
    expect(await run(50, 10)).toEqual([[0, 10], 1]);
    // LinkedIn is asked a second apart at most.
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((ms) => ms > 0 && ms <= 1000)).toBe(true);
    // Topping up the same batch reads past the pages already looked at.
    installChromeMock();
    expect(await run(1)).toEqual([[0], 1]);
    expect(await run(1, Infinity, false)).toEqual([[0, 10], 1]);
    expect(await run(1, Infinity, false)).toEqual([[0, 10, 20, 30], 1]);
    const { yoloQueue, employerBoards } = (await chrome.storage.local.get(["yoloQueue", "employerBoards"])) as {
      yoloQueue: { url: string }[];
      employerBoards: Record<string, string>;
    };
    expect(yoloQueue.map((i) => i.url)).toEqual([1, 2, 3].map((n) => `https://jobs.lever.co/acme/${n}`));
    // Nobody has no board on record, so its postings are dropped again without asking any board.
    expect(employerBoards.nobody).toBe("");
  });

  it("leaves LinkedIn postings without an employer posting out of the AI's batch", async () => {
    const card = (id: number, company: string) =>
      `<li data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">Software Engineer Intern</h3>
      <h4 class="base-search-card__subtitle">${company}</h4><span class="job-search-card__location">Toronto, ON</span></li>`;
    const f = async (url: string) => {
      if (url.includes("linkedin")) return new Response(card(1, "Acme") + card(2, "Nobody"));
      if (url === "https://api.lever.co/v0/postings/acme?mode=json")
        return new Response(
          JSON.stringify([{ text: "Software Engineer Intern", hostedUrl: "https://jobs.lever.co/acme/1" }]),
        );
      return new Response("", { status: 404 });
    };
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      locations: ["Canada"],
      boards: ["linkedin" as const],
    };
    const asked: string[][] = [];
    const n = await discover({
      yolo: y,
      fetch: f,
      relevance: async (items) => (asked.push(items.map((i) => i.company)), new Set(items.keys())),
    });
    expect(asked).toEqual([["Acme"]]);
    expect(n).toBe(1);
  });

  it("queues one application for a job's copies across requisitions and sources", async () => {
    const rows = ["J000704364", "J000704365"].map((id) => ({
      company_name: "Aptiv",
      title: "Cloud Software Engineer Intern",
      url: `https://aptiv.wd5.myworkdayjobs.com/aptiv_careers/job/CAN-Kanata/Engineering-Intern_${id}`,
      locations: ["Kanata, Ottawa, ON, Canada"],
      active: true,
    }));
    const glassdoor = `<li data-jobid="1"><span class="EmployerProfile_compactEmployerName__x">Aptiv</span>
      <a data-test="job-title" href="https://fr.glassdoor.ca/job-listing/x.htm?jl=1">Cloud Software Engineering Intern</a>
      <div data-test="emp-location">Ottawa</div></li>`;
    const f = async (url: string) =>
      new Response(url.includes("glassdoor") ? glassdoor : url.includes("greenhouse") ? "" : JSON.stringify(rows), {
        status: url.includes("greenhouse") || url.includes("lever") || url.includes("ashby") ? 404 : 200,
      });
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      locations: ["Canada"],
      feeds: ["https://x/feed.json"],
      boards: ["glassdoor" as const],
    };
    expect(await discover({ yolo: y, fetch: f })).toBe(1);
    const queued = (await chrome.storage.local.get("yoloQueue")).yoloQueue as { sourceGroups: string[] }[];
    expect(queued[0].sourceGroups).toEqual(expect.arrayContaining(["feeds", "glassdoor"]));
  });

  it("asks the AI about the batch and drops what it rejects", async () => {
    const rows = ["Software Engineer Intern", "Software Engineer Intern (PhD)"].map((title, i) => ({
      company_name: "Co",
      title,
      url: `https://jobs.lever.co/co/${i}`,
      locations: ["Remote"],
      active: true,
    }));
    const f = async () => new Response(JSON.stringify(rows));
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      excludeTitleWords: [],
      feeds: ["https://x/feed.json"],
      boards: [],
    };
    const asked: string[][] = [];
    const n = await discover({
      yolo: y,
      fetch: f,
      relevance: async (items) => (asked.push(items.map((i) => i.title)), new Set([0])),
    });
    expect(asked).toEqual([["Software Engineer Intern", "Software Engineer Intern (PhD)"]]);
    expect(n).toBe(1);
  });

  it("queues any job not in Applications, the queue or the running application, and remembers only AI rejects", async () => {
    const rows = ["a", "b", "c", "d"].map((id) => ({
      company_name: `Co ${id}`,
      title: "Software Engineer Intern",
      url: `https://jobs.lever.co/co/${id}`,
      locations: ["Remote"],
      active: true,
    }));
    const f = async () => new Response(JSON.stringify(rows));
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      feeds: ["https://x/feed.json"],
      boards: [],
    };
    const asked: string[][] = [];
    // The AI rejects d.
    const relevance = async (items: Listing[]) => (
      asked.push(items.map((i) => i.url.slice(-1))),
      new Set([...items.keys()].filter((i) => !items[i].url.endsWith("d")))
    );
    const queue = async () =>
      ((await chrome.storage.local.get("yoloQueue")).yoloQueue as { key: string }[]).map((i) => i.key).sort();
    expect(await discover({ yolo: y, fetch: f, relevance })).toBe(3);
    expect(await queue()).toEqual(["lever:a", "lever:b", "lever:c"]);

    // a was applied to, b is running (out of the queue, not yet recorded), c was dropped (turned off, removed).
    const [a, b] = ["a", "b"].map((id) => ({
      key: `lever:${id}`,
      alt: altKey(`Co ${id}`, "Software Engineer Intern"),
    }));
    await chrome.storage.local.set({
      yoloQueue: [],
      applications: [{ ...a, url: "", mode: "yolo", status: "failed", at: 1 }],
    });
    await chrome.storage.session.set({ yoloRun: { mode: "apply", item: { ...b, listing: b.key } } });
    asked.length = 0;
    expect(await discover({ yolo: y, fetch: f, relevance })).toBe(1);
    expect(await queue()).toEqual(["lever:c"]);
    // d, rejected by the AI, isn't asked about again.
    expect(asked).toEqual([["c"]]);
  });

  it("asks the AI again about a job it rejected once aiRejectDays have passed", async () => {
    const rows = [
      {
        company_name: "Co d",
        title: "Software Engineer Intern",
        url: "https://jobs.lever.co/co/d",
        locations: ["Remote"],
        active: true,
      },
    ];
    const f = async () => new Response(JSON.stringify(rows));
    const y = { ...defaultYolo(), queries: ["Software Engineer Intern"], feeds: ["https://x/feed.json"], boards: [] };
    let asked = 0;
    const relevance = async () => (asked++, new Set<number>());
    await chrome.storage.local.set({ yoloRejected: { "lever:d": Date.now() - 10 * 86400e3 } });
    await discover({ yolo: { ...y, aiRejectDays: 30 }, fetch: f, relevance });
    expect(asked).toBe(0);
    await discover({ yolo: { ...y, aiRejectDays: 7 }, fetch: f, relevance });
    expect(asked).toBe(1);
  });

  it("adds to the queue as it is when discovery ends, and leaves the hidden page to a running application", async () => {
    const job = (id: string) => ({
      key: `lever:${id}`,
      alt: altKey(`Co ${id}`, "Software Engineer Intern"),
      listing: `lever:${id}`,
      url: `https://jobs.lever.co/co/${id}`,
      company: `Co ${id}`,
      title: "Software Engineer Intern",
      location: "Remote",
      source: "x/feed",
      postedAt: 1,
      addedAt: 1,
    });
    const rows = ["n", "r"].map((id) => ({
      company_name: `Co ${id}`,
      title: "Software Engineer Intern",
      url: `https://jobs.lever.co/co/${id}`,
      locations: ["Remote"],
      active: true,
    }));
    await chrome.storage.local.set({ yoloQueue: [job("x")] });
    const scraped: string[] = [];
    const f = async (url: string) => {
      if (url === "https://x/feed.json") {
        // Meanwhile the pump starts x, and r is put back from an application stopped mid-way.
        await chrome.storage.local.set({ yoloQueue: [{ ...job("r"), postedAt: RETRY }] });
        await chrome.storage.session.set({ yoloRun: { mode: "apply", item: job("x") } });
        return new Response(JSON.stringify(rows));
      }
      return new Response("", { status: 404 });
    };
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      feeds: ["https://x/feed.json"],
      boards: [],
      careerSites: ["https://careers.example.com/jobs"],
    };
    const n = await discover({ yolo: y, fetch: f, scrape: async (u) => (scraped.push(u), []) });
    const q = (await chrome.storage.local.get("yoloQueue")).yoloQueue as { key: string; postedAt: number }[];
    // x isn't put back (it would be applied to twice), r isn't lost or doubled, n is added.
    expect(q.map((i) => [i.key, i.postedAt === RETRY])).toEqual([
      ["lever:r", true],
      ["lever:n", false],
    ]);
    expect(n).toBe(1);
    // The career site waits: scraping it would take the hidden page from x's application.
    expect(scraped).toEqual([]);
  });

  it("reads the signed-in Jobright feed until it runs out, trusting its roles over the queries", async () => {
    const job = (jobTitle: string, jobLocation: string, n: number) => ({
      jobResult: {
        jobTitle,
        jobLocation,
        publishTime: "2026-11-02 10:00:00",
        applyLink: `https://jobs.lever.co/co/${n}`,
      },
      companyResult: { companyName: `Co${n}` },
    });
    const pages = [
      // Not a "software intern" title, but what the user's Jobright preferences ask for; excluded words still count.
      [job("Backend Developer - Intern", "Toronto, ON", 1), job("Senior Software Intern", "Toronto, ON", 2)],
      [job("Software Engineer Intern", "Seattle, WA", 3)],
      [],
    ];
    const asked: [string, RequestCredentials | undefined][] = [];
    let signedIn = true;
    const f = async (url: string, init?: RequestInit) => {
      if (!url.startsWith("https://jobright.ai/swan/recommend/list/jobs")) return new Response("", { status: 404 });
      const u = new URL(url);
      asked.push([`${u.searchParams.get("refresh")}@${u.searchParams.get("position")}`, init?.credentials]);
      if (!signedIn) return new Response('{"success":false,"errorCode":41001}', { status: 401 });
      return new Response(
        JSON.stringify({ success: true, result: { jobList: pages[Number(u.searchParams.get("position")) / 20] } }),
      );
    };
    const y = {
      ...defaultYolo(),
      queries: ["Software Intern"],
      locations: ["Canada"],
      feeds: [],
      boards: [],
      jobright: ["recommendations"],
    };
    const now = Date.UTC(2026, 10, 3);
    const out: boolean[] = [];
    const jobrightSignedOut = (o: boolean) => out.push(o);
    expect(await discover({ yolo: y, fetch: f, now, jobrightSignedOut })).toBe(1);
    expect(asked).toEqual([
      ["true@0", "include"],
      ["false@20", "include"],
      ["false@40", "include"],
    ]);
    const { yoloQueue } = (await chrome.storage.local.get("yoloQueue")) as {
      yoloQueue: { url: string; title: string; source: string }[];
    };
    expect(yoloQueue.map((i) => [i.url, i.title, i.source])).toEqual([
      ["https://jobs.lever.co/co/1", "Backend Developer - Intern", "jobright"],
    ]);
    // Signed out: Jobright answers 401 and is left alone.
    installChromeMock();
    signedIn = false;
    asked.length = 0;
    expect(await discover({ yolo: y, fetch: f, now, jobrightSignedOut })).toBe(0);
    expect(asked).toHaveLength(1);
    // Told once per read, for the settings page and popup to warn.
    expect(out).toEqual([false, true]);
  });

  it("searches the country's own Glassdoor on its search page, which keeps the age filter", () => {
    expect(glassdoorSearch("Software Intern", "Canada", 14)).toBe(
      "https://www.glassdoor.ca/Job/software-intern-jobs-SRCH_KO0,15.htm?fromAge=14",
    );
    expect(glassdoorSearch("C++ Développeur / Intern", "Austin, TX", 60)).toBe(
      "https://www.glassdoor.com/Job/c-developpeur-intern-jobs-SRCH_KO0,20.htm?fromAge=30",
    );
  });

  it("searches Indeed as the signed-in user, in a tab when Cloudflare checks the fetch, and tells what stood in", async () => {
    const page = (jk: string) =>
      `<script>window.mosaic.providerData["mosaic-provider-jobcards"]=${JSON.stringify({
        metaData: {
          mosaicProviderJobCardsModel: {
            results: [
              { jobkey: jk, displayTitle: "Software Intern", company: `Co ${jk}`, formattedLocation: "Toronto, ON" },
            ],
          },
        },
      })};</script>`;
    const y = {
      ...defaultYolo(),
      queries: ["Software Intern"],
      locations: ["Canada"],
      boards: ["indeed" as const],
      feeds: [],
      jobright: [],
    };
    let signedIn = true;
    let search: () => Response = () => new Response(page("a1"));
    const asked: [string, string | undefined, RequestCredentials | undefined][] = [];
    const f = async (url: string, init?: RequestInit) => {
      // Indeed's own requests: an employer-board lookup per posting follows, as for every board.
      if (url.includes("indeed.com/")) asked.push([url.replace(/\?.*/, ""), init?.method, init?.credentials]);
      if (url === "https://secure.indeed.com/settings/account") {
        const r = new Response("");
        Object.defineProperty(r, "url", {
          value: signedIn ? url : "https://secure.indeed.com/auth?hl=en&continue=%2Fsettings%2Faccount",
        });
        return r;
      }
      if (url.startsWith("https://ca.indeed.com/jobs?")) return search();
      return new Response("", { status: 404 });
    };
    const tabbed: string[] = [];
    let tab: string | null = null;
    const signedOut: boolean[] = [];
    const blocked: boolean[] = [];
    const run = () =>
      discover({
        yolo: y,
        fetch: f,
        indeedTab: async (url) => (tabbed.push(url), tab),
        indeedSignedOut: (o) => signedOut.push(o),
        indeedBlocked: (b) => blocked.push(b),
      });

    // Signed in, the fetch passes: no tab, and the user's cookies go with both requests.
    expect(await run()).toBe(1);
    expect(asked).toEqual([
      ["https://secure.indeed.com/settings/account", "HEAD", "include"],
      ["https://ca.indeed.com/jobs", undefined, "include"],
    ]);
    expect(tabbed).toEqual([]);

    // Cloudflare checks the fetch: the search is rendered in a tab, which reads it.
    installChromeMock();
    search = () => new Response("<title>Just a moment...</title>", { status: 403 });
    tab = page("b2").replace(/^<script>|<\/script>$/g, "");
    expect(await run()).toBe(1);
    expect(tabbed).toEqual(["https://ca.indeed.com/jobs?q=Software%20Intern&l=Canada&fromage=14&sort=date"]);

    // Checked both ways: nothing, and the user told.
    installChromeMock();
    tab = null;
    expect(await run()).toBe(0);

    // Signed out: Indeed isn't searched at all.
    installChromeMock();
    signedIn = false;
    asked.length = 0;
    expect(await run()).toBe(0);
    expect(asked).toEqual([["https://secure.indeed.com/settings/account", "HEAD", "include"]]);

    expect(signedOut).toEqual([false, false, false, true]);
    expect(blocked).toEqual([false, false, true]);
  });

  it("pages LinkedIn only for what the lists read before it don't supply", async () => {
    const linkedin: number[] = [];
    const f = async (url: string) => {
      if (url.startsWith("https://jobright.ai/swan/"))
        return new Response(
          JSON.stringify({
            result: {
              jobList: url.includes("position=0&")
                ? [
                    {
                      jobResult: {
                        jobTitle: "Software Intern",
                        jobLocation: "Toronto, ON",
                        applyLink: "https://jobs.lever.co/co/1",
                      },
                      companyResult: { companyName: "Co" },
                    },
                  ]
                : [],
            },
          }),
        );
      if (!url.includes("linkedin")) return new Response("", { status: 404 });
      const start = Number(new URL(url).searchParams.get("start"));
      linkedin.push(start);
      return new Response(
        start
          ? ""
          : `<li data-entity-urn="urn:li:jobPosting:9"><h3 class="base-search-card__title">Software Intern</h3>
          <h4 class="base-search-card__subtitle">Nobody</h4><span class="job-search-card__location">Toronto, ON</span></li>`,
      );
    };
    const later = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => later(fn, 0)) as typeof setTimeout);
    onTestFinished(() => void vi.restoreAllMocks());
    const y = (jobright: string[]) => ({
      ...defaultYolo(),
      queries: ["Software Intern"],
      locations: ["Canada"],
      feeds: [],
      boards: ["linkedin" as const],
      jobright,
    });
    await discover({ yolo: y([]), fetch: f, want: 1 });
    expect(linkedin).toEqual([0, 10]);
    installChromeMock();
    linkedin.length = 0;
    await discover({ yolo: y(["recommendations"]), fetch: f, want: 1 });
    expect(linkedin).toEqual([0]);
  });
});

describe("source check", () => {
  beforeEach(() => installChromeMock());
  const feed = "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/listings.json";
  const now = Date.UTC(2026, 9, 26);
  const row = (company: string, title: string, id: string) => ({
    company_name: company,
    title,
    url: `https://jobs.lever.co/${company.toLowerCase()}/${id}`,
    locations: ["Toronto, ON"],
    date_posted: now / 1000,
  });
  const report = async () =>
    ((await chrome.storage.local.get("yoloSourceCheck")) as { yoloSourceCheck: SourceCheck }).yoloSourceCheck;
  const byGroup = (c: SourceCheck) => Object.fromEntries(c.groups.map((g) => [g.group, g]));

  it("reports each enabled source's funnel and what went wrong, and only the enabled ones", async () => {
    const later = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => later(fn, 0)) as typeof setTimeout);
    onTestFinished(() => void vi.restoreAllMocks());
    const rows = [row("Lyft", "Software Engineer Intern", "a1"), row("Acme", "Mechanical Intern", "b2")];
    const f = async (url: string, init?: RequestInit) => {
      if (url === feed)
        return (init?.headers as Record<string, string>)?.["if-none-match"]
          ? new Response(null, { status: 304 })
          : new Response(JSON.stringify(rows), { headers: { etag: '"v1"' } });
      if (url.includes("jobright.ai")) return new Response("", { status: 401 });
      if (url.includes("linkedin.com"))
        return new URL(url).searchParams.get("start") === "0"
          ? new Response(`<li data-entity-urn="urn:li:jobPosting:7"><h3 class="base-search-card__title">Software Engineer Intern</h3>
              <h4 class="base-search-card__subtitle">Nobody</h4><span class="job-search-card__location">Toronto, ON</span></li>`)
          : new Response("", { status: 429 });
      return new Response("", { status: 404 });
    };
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      locations: ["Canada"],
      feeds: [feed],
      boards: ["linkedin" as const],
      jobright: ["recommendations"],
      careerSites: ["https://boards.greenhouse.io/missing", "https://example.com/careers"],
    };
    const scrape = async () => [{ href: "https://example.com/about", text: "About us" }];
    expect(await discover({ yolo: y, fetch: f, scrape, want: 50, now })).toBe(1);
    const c = await report();
    expect(c.doneAt).toBeGreaterThan(0);
    expect(c.groups.map((g) => g.group)).toEqual(["linkedin", "jobright", "feeds", "careers"]);
    const g = byGroup(c);
    expect(g.feeds).toMatchObject({
      level: "ok",
      found: 2,
      fresh: 2,
      matched: 1,
      queued: 1,
      drops: { "Title doesn't match a search": 1 },
    });
    expect(g.linkedin).toMatchObject({
      level: "warn",
      problem: "Rate limited by LinkedIn (HTTP 429) after 1 page",
      found: 1,
      matched: 1,
      queued: 0,
      drops: { "No posting on the employer's own site": 1 },
    });
    expect(g.jobright).toMatchObject({ level: "error", problem: "Signed out: sign in to jobright.ai in this browser" });
    expect(g.careers.level).toBe("error");
    expect(g.careers.rows.map((r) => [r.label, r.problem])).toEqual([
      ["boards.greenhouse.io/missing", "No Greenhouse job board answered at this URL: check it"],
      [
        "example.com/careers",
        "No job links found on the page: no openings, or not the page that lists jobs (a search URL with {q} works)",
      ],
    ]);
    expect(g.careers.problem).toMatch(/^boards\.greenhouse\.io\/missing: .* \(\+1 more\)$/);

    // Read again: the list hasn't changed, so it's a note rather than a problem.
    await discover({ yolo: { ...y, boards: [], jobright: [], careerSites: [] }, fetch: f, now, topUp: true });
    const again = await report();
    expect(again.topUp).toBe(true);
    expect(again.groups.map((x) => [x.group, x.level, x.problem])).toEqual([
      ["feeds", "info", "Unchanged since its last read: its jobs were already looked at"],
    ]);
  });

  it("says why a source that read jobs queued none", async () => {
    const f = async () => new Response(JSON.stringify([row("Acme", "Mechanical Intern", "b2")]));
    const y = { ...defaultYolo(), queries: ["Software Engineer Intern"], feeds: [feed], boards: [] };
    expect(await discover({ yolo: y, fetch: f, now })).toBe(0);
    expect(byGroup(await report()).feeds).toMatchObject({
      level: "info",
      problem: "Nothing queued: Title doesn't match a search (1 of 1)",
    });
  });
});

describe("queue order", () => {
  const jobs = [
    { source: "linkedin", postedAt: 3, addedAt: 1 },
    { source: "SimplifyJobs/Summer2027-Internships", postedAt: 1, addedAt: 2 },
    { source: "greenhouse", postedAt: 2, addedAt: 3 },
    { source: "careers", postedAt: 4, addedAt: 4 },
  ];
  const order = (o: Partial<ReturnType<typeof defaultYolo>>, items = jobs) =>
    inQueueOrder(items, { ...defaultYolo(), ...o }).map((j) => j.postedAt);

  it("sorts by date or by when found", () => {
    expect(order({})).toEqual([4, 3, 2, 1]);
    expect(order({ queueSort: "oldest" })).toEqual([1, 2, 3, 4]);
    expect(order({ queueSort: "foundFirst" })).toEqual([3, 1, 2, 4]);
    expect(order({ queueSort: "foundLast" })).toEqual([4, 2, 1, 3]);
    expect(order({ queueSort: "random" }).sort()).toEqual([1, 2, 3, 4]);
  });

  it("ranks sources first when asked, and runs a retry next regardless", () => {
    // Unlisted sources (Indeed, Glassdoor) go last.
    expect(order({ queueBySource: true, sourceOrder: ["feeds", "linkedin", "careers"] })).toEqual([1, 3, 4, 2]);
    expect(order({ queueSort: "oldest" }, [...jobs, { source: "indeed", postedAt: RETRY, addedAt: 5 }])[0]).toBe(RETRY);
    // An order saved before a source existed gains it at the end.
    expect(YoloSchema.parse({ sourceOrder: ["feeds", "careers"] }).sourceOrder.slice(-1)).toEqual(["jobright"]);
  });
});

describe("YOLO best guesses", () => {
  const field = (id: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
    id,
    kind: "text",
    label: id,
    required: true,
    optionsKnown: true,
    ...extra,
  });

  it("answers what the profile can't, in one more call that sees why each field was flagged", async () => {
    const systems: string[] = [];
    let guessPayload: { fields: { id: string; whyUnanswered?: string }[] } | undefined;
    const gemini = {
      call: async (s: { system: string; payload: { fields?: { id: string }[]; items?: unknown[] } }) => {
        systems.push(s.system.slice(0, 40));
        if (s.payload.items) return { data: { verdicts: [] }, usedModel: "m", keyLabel: "k" };
        if (/best chance/.test(s.system)) {
          guessPayload = s.payload as typeof guessPayload;
          return {
            data: { decisions: [{ fieldId: "deadline", action: "fill", text: "No", confidence: "low", sources: [] }] },
            usedModel: "m",
            keyLabel: "k",
          };
        }
        return {
          data: { decisions: [{ fieldId: "deadline", action: "flag", confidence: "low" }] },
          usedModel: "m",
          keyLabel: "k",
        };
      },
    } as unknown as Gemini;
    const ctx = { ai: gemini, settings: defaultSettings(), model: "m", fallback: null };
    const fields = [field("deadline", { label: "Do you have any offer deadlines?" })];
    const plain = await mapFields(ctx, { fields, profile: emptyProfile(), documents: [], job: null });
    expect(plain.decisions[0].action).toBe("flag");
    expect(systems.some((s) => /candidate is applying automatically/.test(s))).toBe(false);
    const yolo = await mapFields(ctx, { fields, profile: emptyProfile(), documents: [], job: null, yolo: true });
    expect(guessPayload?.fields.map((f) => f.id)).toEqual(["deadline"]);
    expect(yolo.decisions[0]).toMatchObject({ action: "fill", text: "No", sources: ["guess"], confidence: "medium" });
  });

  it("guesses required fields and optional single choices, never opt-ins, optional text or blank options", async () => {
    const asked: string[][] = [];
    const gemini = {
      call: async (s: { system: string; payload: { fields?: { id: string }[]; items?: unknown[] } }) => {
        if (s.payload.items) return { data: { verdicts: [] }, usedModel: "m", keyLabel: "k" };
        const fields = s.payload.fields ?? [];
        if (/best chance/.test(s.system)) {
          asked.push(fields.map((f) => f.id));
        }
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const fields = [
      field("deadline", { label: "Do you have any offer deadlines?" }),
      field("optin", { kind: "checkbox", label: "Send me job alerts", required: false }),
      field("blank", { kind: "radio_group", label: "Are you a citizen of Iran?", options: [" ", ""] }),
      field("heard", {
        kind: "radio_group",
        label: "Where did you first hear about this position?",
        options: ["Newsletter", "Colleague"],
        required: false,
      }),
      field("note", { kind: "textarea", label: "Anything else?", required: false }),
    ];
    await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields, profile: emptyProfile(), documents: [], job: null, yolo: true },
    );
    expect(asked).toEqual([["deadline", "heard"]]);
  });
});

describe("run watchdog", () => {
  const min = 60_000;
  const run = (host: Run["host"], step: string): Run =>
    ({ host, startedAt: 0, helloAt: 1, stepAt: 11 * min, steps: [`${step}|/apply||5`] }) as Run;

  it("gives a visible tab the whole CAPTCHA wait, past the run's time limit", () => {
    expect(overdue(run("visible", "captcha"), 20 * min)).toBeNull();
    expect(overdue(run("visible", "captcha"), 25 * min)).toMatchObject({ reason: "The CAPTCHA wasn't solved" });
  });

  it("still ends stalled or overlong runs", () => {
    expect(overdue(run("visible", "form"), 15 * min)).toMatchObject({ reason: "No progress for 3 minutes" });
    expect(overdue(run("frame", "captcha"), 15 * min)).toMatchObject({ reason: "No progress for 3 minutes" });
    expect(overdue(run("tab", "form"), 13 * min)).toMatchObject({ reason: "Took over 12 minutes" });
  });

  it("doesn't count the time the computer slept", () => {
    const r = run("frame", "form");
    // Asleep from 12 min (the watchdog's missed tick) for 2 hours.
    credit(r, 12 * min, 132 * min);
    expect(overdue(r, 132 * min)).toBeNull();
    expect(r).toMatchObject({ startedAt: 120 * min, stepAt: 131 * min, wokeAt: 132 * min });
    // Its limits still hold over awake time.
    expect(overdue(r, 133 * min)).toMatchObject({ reason: "Took over 12 minutes" });
  });

  it("keeps progress made since waking", () => {
    const r = run("frame", "form");
    r.stepAt = 131 * min; // a step reported after waking, before the watchdog's late tick
    credit(r, 12 * min, 132 * min);
    expect(r.stepAt).toBe(131 * min);
  });

  it("blames the sleep for a failure only right after waking", () => {
    const r = run("frame", "form");
    expect(woke(r, 20 * min)).toBe(false);
    credit(r, 12 * min, 20 * min);
    expect(woke(r, 22 * min)).toBe(true);
    expect(woke(r, 24 * min)).toBe(false);
  });

  it("gives a verification step the email's whole wait", () => {
    expect(overdue(run("visible", "verify"), 11 * min + 7 * min)).toBeNull();
    expect(overdue(run("visible", "verify"), 11 * min + 9 * min)).toMatchObject({
      reason: "No progress for 3 minutes",
    });
  });
});

describe("embedded steps", () => {
  it("reads a page with required questions of its own beside an iframe as a form", async () => {
    const { kindOf } = await import("../../src/background/yolo/classify");
    const facts = {
      text: "Enter Your Information Email",
      title: "Login",
      path: "/jobs/35297/login",
      headings: "Enter Your Information",
      alerts: "",
      fields: 2,
      passwords: 0,
      codeInput: false,
      captcha: false,
      scored: false,
      embedded: true,
      apply: false,
      applyKind: "none" as const,
      applyInForm: false,
      requiredFields: 1,
      onward: false,
    };
    expect(kindOf(facts, false)).toBe("form");
    expect(kindOf({ ...facts, requiredFields: 0, fields: 0 }, false)).toBe("embedded");
  });

  it('reads a create-account address headed "Sign in" as a sign-up (TikTok)', async () => {
    const { kindOf } = await import("../../src/background/yolo/classify");
    const page = {
      text: "Sign in Email Password Create",
      title: "TikTok Careers",
      path: "/create-account",
      headings: "Sign in",
      alerts: "",
      fields: 2,
      passwords: 1,
      codeInput: false,
      captcha: false,
      scored: false,
      embedded: false,
      apply: false,
      applyKind: "none" as const,
      applyInForm: false,
      requiredFields: 0,
      onward: false,
    };
    expect(kindOf(page, false)).toBe("signup");
    expect(kindOf({ ...page, path: "/login" }, false)).toBe("signin");
  });
});
