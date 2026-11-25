import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { installChromeMock } from "./chromeMock";
import {
  altKey,
  applyUrl,
  jobKey,
  leftPosting,
  namesPosting,
  postingNumber,
  restartUrl,
} from "../../src/background/yolo/jobKey";
import {
  glassdoorMore,
  glassdoorSearch,
  indeedSearch,
  feedFile,
  jobrightFeed,
  parseFeed,
  parseGlassdoor,
  indeedSignedOut,
  parseIndeed,
  parseJobrightFeed,
  parseLinkedIn,
  parseZipRecruiter,
  zipRecruiterSearch,
} from "../../src/background/yolo/sources";
import {
  boardOf,
  careerSite,
  findOnEmployerBoard,
  jobLinks,
  sameTitle,
  workdayPosted,
} from "../../src/background/yolo/careers";
import { locationMatches, rejectReason, titleMatches } from "../../src/background/yolo/filter";
import { loadPlaces, PLACES_FILE } from "../../src/background/yolo/places";
import {
  connectGmail,
  extract,
  feedTexts,
  GmailAuthError,
  gmailToken,
  siteOf,
  siteOfUrl,
} from "../../src/background/yolo/gmail";
import { letterText, LINES_PER_PAGE, textLines, textPdf, wrap } from "../../src/background/yolo/pdf";
import { ONE_PAGE_WORDS, topLevelUrl } from "../../src/shared/constants";
import { accountKey, accountSite, decrypt, encrypt, newPassword } from "../../src/background/yolo/vault";
import { applied, discover, inQueueOrder, RETRY, runnable } from "../../src/background/yolo/discover";
import { credit, overdue, woke, type Run } from "../../src/background/yolo/runner";
import { mapFields } from "../../src/background/services/mapFields";
import type { Gemini } from "../../src/background/gemini/client";
import { defaultSettings } from "../../src/shared/settings";
import { emptyProfile } from "../../src/shared/profileSchema";
import {
  defaultYolo,
  YoloSchema,
  type Application,
  type Listing,
  type QueueItem,
  type SourceCheck,
} from "../../src/shared/yolo";
import type { FieldDescriptor } from "../../src/shared/types";

beforeAll(() => loadPlaces(() => readFile(`public/${PLACES_FILE}`, "utf8")));

/** A Glassdoor search's results object, as page 1's payload and the "Show more jobs" answer carry it. */
const glassdoorResults = (
  jobs: {
    id: number;
    title?: string;
    company?: string;
    location?: string;
    age?: number;
    easy?: boolean;
    expired?: boolean;
    host?: string;
  }[],
  cursors: number[] = [],
) => ({
  jobListings: jobs.map((j) => ({
    jobview: {
      header: {
        jobTitleText: j.title ?? `Student, Software Test ${j.id}`,
        seoJobLink: `https://${j.host ?? "www.glassdoor.ca"}/job-listing/x-JV_IC1.htm?jl=${j.id}`,
        employer: { shortName: j.company ?? "" },
        employerNameFromSearch: j.company ?? "Co",
        locationName: j.location ?? "London",
        ageInDays: j.age ?? 0,
        easyApply: !!j.easy,
        expired: !!j.expired,
      },
      job: { listingId: j.id },
    },
  })),
  paginationCursors: cursors.map((n) => ({ cursor: `cursor-${n}`, pageNumber: n })),
  totalJobsCount: jobs.length,
});
/** A Glassdoor search page: its results streamed in the Next.js payload, in pieces. */
const glassdoorPage = (results: object) => {
  const payload = `9:["$","div",null,{"jobListings":${JSON.stringify(results)}}]`;
  return [payload.slice(0, 30), payload.slice(30)]
    .map((p) => `<script>self.__next_f.push([1,${JSON.stringify(p)}])</script>`)
    .join("");
};

describe("job keys", () => {
  it("names a Workday requisition once across its location copies and apply steps", () => {
    const a = jobKey(
      "https://manulife.wd3.myworkdayjobs.com/en-US/MFCJH_AdminJobs/job/Waterloo%2C-Ontario/Summer-Intern-2027---Software-Engineering_JR26081686-1/apply/applyManually?utm_source=x",
    );
    const b = jobKey("https://manulife.wd3.myworkdayjobs.com/MFCJH_AdminJobs/job/Toronto/Summer-Intern_JR26081686-2");
    expect(a).toBe("workday:manulife:jr26081686");
    expect(b).toBe(a);
  });

  it("keeps hyphenated requisitions and Eightfold pid links apart", () => {
    const wd = (req: string) =>
      jobKey(`https://workday.wd5.myworkdayjobs.com/Workday_Early_Career/job/Canada-BC-Vancouver/Intern_${req}`);
    expect(wd("JR-0110807")).toBe("workday:workday:jr-0110807");
    expect(wd("JR-0110807-1")).toBe("workday:workday:jr-0110807");
    expect(wd("JR-0110900")).not.toBe(wd("JR-0110807"));
    const ef = (id: string) => jobKey(`https://qualcomm.eightfold.ai/careers?pid=${id}&domain=qualcomm.com`);
    expect(ef("446721229661")).toBe("eightfold:qualcomm.eightfold.ai:446721229661");
    expect(ef("446721229661")).toBe(jobKey("https://qualcomm.eightfold.ai/careers/job/446721229661"));
    expect(ef("446721156615")).not.toBe(ef("446721229661"));
  });

  it("keys custom-domain pid links apart and knows SuccessFactors' shared page names no posting", () => {
    const qc = (id: string) => jobKey(`https://careers.qualcomm.com/careers/apply?pid=${id}&domain=qualcomm.com`);
    expect(qc("446721229661")).not.toBe(qc("446721156615"));
    expect(jobKey("https://career4.successfactors.com/careers?career_job_req_id=4242&company=x")).toBe(
      "sf:career4.successfactors.com:4242",
    );
    expect(namesPosting("https://career4.successfactors.com/careers?company=acuitybrands")).toBe(false);
    expect(namesPosting("https://career-hcm20.ns2cloud.com/careers?company=L3HHCM20")).toBe(false);
    expect(namesPosting("https://career17.sapsf.com/careers?company=cmhcschl")).toBe(false);
    expect(namesPosting("https://careers.acuityinc.com/job/Brossard-Intern/1433678100/?ats=successfactors")).toBe(true);
    expect(namesPosting(qc("1"))).toBe(true);
    // A site's root, locale root or sign-in page is shared by every posting there.
    expect(namesPosting("https://passport.amazon.jobs/")).toBe(false);
    expect(namesPosting("https://login.icims.com/u/login/password?state=x")).toBe(false);
    expect(namesPosting("https://careers.example.com/candidate/login")).toBe(false);
    expect(namesPosting("https://careers.example.com/jobs/login-systems-engineer-intern")).toBe(true);
    expect(namesPosting("https://career5.successfactors.eu/careers?company=SAP")).toBe(false);
    expect(namesPosting("https://careers.zimmerbiomet.com/us/en")).toBe(false);
    expect(namesPosting("https://altera.wd1.myworkdayjobs.com/en-US/Altera/userHome")).toBe(false);
    expect(namesPosting("https://altera.wd1.myworkdayjobs.com/en-US/Altera/job/San-Jose/Intern_JR1/apply")).toBe(true);
    // A closed posting's link landing on the site's job list (D2L), not a posting page or another site's.
    const d2l = "https://www.d2l.com/careers/jobs/?job_id=8289767&gh_jid=8289767";
    expect(leftPosting(d2l, "https://www.d2l.com/careers/jobs/")).toBe(true);
    expect(leftPosting(d2l, d2l)).toBe(false);
    expect(leftPosting(d2l, "https://job-boards.greenhouse.io/d2l/jobs/8289767")).toBe(false);
    expect(leftPosting("https://www.d2l.com/careers/", "https://www.d2l.com/careers/jobs/")).toBe(false);
    // A posting's number, and whether a page still carries it (EA's careers home after a password reset doesn't).
    const ea = "https://jobs.ea.com/en_US/careers/JobDetail/Software-Engineer-Intern-Summer-2027-8-months-UFC/216226";
    expect(postingNumber(ea)).toBe("216226");
    expect(postingNumber("https://jobs.ea.com/en_US/careers/ApplicationEEO?jobId=216226", "216226")).toBe("216226");
    expect(postingNumber("https://jobs.ea.com/en_US/careers", "216226")).toBeUndefined();
    expect(postingNumber("https://intel.wd1.myworkdayjobs.com/external/job/Toronto/Intern_JR0287933")).toBe("0287933");
    expect(postingNumber("https://jobs.lever.co/acme/backend-intern")).toBeUndefined();
    expect(namesPosting("https://dfid.dayforcehcm.com/globalidentity/account/login?returnUrl=x")).toBe(false);
    expect(namesPosting("https://careers.zimmerbiomet.com/us/en/job/13309/software-intern")).toBe(true);
    expect(namesPosting("https://jobs.bce.ca/bell/job/Montreal-Intern/1433151100")).toBe(true);
    expect(namesPosting("https://www.d2l.com/careers/jobs/?job_id=8289767")).toBe(true);
  });

  it("resumes a SuccessFactors application from its posting, not the page it stopped on", () => {
    expect(
      restartUrl(
        "https://career4.successfactors.com/career?company=Teck&site=&lang=en_US&requestParams=x&login_ns=forgot_pwd&career_ns=job%5fapplication&career_job_req_id=54593&jobPipeline=Indeed",
      ),
    ).toBe("https://career4.successfactors.com/career?career_ns=job_listing&company=Teck&career_job_req_id=54593");
    expect(restartUrl("https://career-hcm20.ns2cloud.com/careers?company=L3HHCM20")).toBe(
      "https://career-hcm20.ns2cloud.com/careers?company=L3HHCM20",
    );
    expect(restartUrl("https://jobs.lever.co/x/1/apply")).toBe("https://jobs.lever.co/x/1/apply");
  });

  it("opens an iCIMS page's own frame as its mobile view in a tab", () => {
    const u = new URL(topLevelUrl("https://campuscanada-amd.icims.com/jobs/90305/login?_gl=x&in_iframe=1"));
    expect(u.pathname).toBe("/jobs/90305/login");
    expect([
      u.searchParams.get("in_iframe"),
      u.searchParams.get("mobile"),
      u.searchParams.get("needsRedirect"),
    ]).toEqual([null, "true", "false"]);
    expect(topLevelUrl("https://careers.amd.com/jobs/90305?icims=1")).toBe(
      "https://careers.amd.com/jobs/90305?icims=1",
    );
    expect(topLevelUrl("https://job-boards.greenhouse.io/x/jobs/1")).toBe("https://job-boards.greenhouse.io/x/jobs/1");
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
    expect(
      jobKey("https://www.ziprecruiter.com/c/paypal/Job/Software-Engineer-Intern/-in-Austin,TX?jid=06a5d35f0de7929e"),
    ).toBe("ziprecruiter:06a5d35f0de7929e");
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
| ↳ | Open Intern | NYC | [Apply](https://jobs.lever.co/closedco/3) | 3d |
| Paren Co | HW Intern | QC | [![Apply](https://img.shields.io/x)](https://careers.example.com/job/Intern-(hardware)-QC/12/?ats=sf) | 1d |
<table><tr><td><strong><a href="https://simplify.jobs/c/Beta">Beta</a></strong></td><td>SWE Intern</td><td>Seattle, WA</br>Remote</td><td><a href="https://job-boards.greenhouse.io/beta/jobs/9"><img></a></td><td>0d</td></tr></table>`;
    expect(parseFeed(md, "r").map((l) => [l.company, l.title, l.location, l.url])).toEqual([
      ["Beta", "SWE Intern", "Seattle, WA; Remote", "https://job-boards.greenhouse.io/beta/jobs/9"],
      ["Acme", "Software Engineer Intern", "Toronto, ON", "https://jobs.lever.co/acme/1?utm_source=Simplify"],
      ["Acme", "Data Intern", "Remote", "https://jobs.lever.co/acme/2"],
      ["Closed Co", "Open Intern", "NYC", "https://jobs.lever.co/closedco/3"],
      ["Paren Co", "HW Intern", "QC", "https://careers.example.com/job/Intern-(hardware)-QC/12/?ats=sf"],
    ]);
  });

  it("reads a GitHub file page's list from the file itself", () => {
    expect(feedFile("https://github.com/SimplifyJobs/Summer2027-Internships/blob/dev/README.md")).toBe(
      "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md",
    );
    const raw = "https://raw.githubusercontent.com/o/r/dev/.github/scripts/listings.json";
    expect(feedFile(raw)).toBe(raw);
    expect(feedFile("https://example.com/o/r/blob/main/jobs.md")).toBe("https://example.com/o/r/blob/main/jobs.md");
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

  it("reads Glassdoor results from page 1's Next.js payload and from later pages' JSON, with the next page's cursor", () => {
    const now = Date.UTC(2026, 9, 26);
    const results = glassdoorResults(
      [
        { id: 1, company: "General Dynamics", age: 3 },
        { id: 2, easy: true, host: "fr.glassdoor.ca" },
        { id: 3, expired: true },
        { id: 1 },
      ],
      [2, 3],
    );
    const page1 = parseGlassdoor(glassdoorPage(results), 1, now);
    expect(page1.jobs).toEqual([
      {
        url: "https://www.glassdoor.ca/job-listing/x-JV_IC1.htm?jl=1",
        title: "Student, Software Test 1",
        company: "General Dynamics",
        location: "London",
        postedAt: now - 3 * 86400e3,
        source: "glassdoor",
        easyApply: undefined,
      },
      expect.objectContaining({ url: "https://www.glassdoor.ca/job-listing/x-JV_IC1.htm?jl=2", easyApply: true }),
    ]);
    expect(page1.next).toBe("cursor-2");
    // The "Show more jobs" answer: the same object, under data.
    const page2 = parseGlassdoor(JSON.stringify({ data: { jobListings: results } }), 2, now);
    expect(page2.jobs.map((l) => l.url)).toEqual(page1.jobs.map((l) => l.url));
    expect(page2.next).toBe("cursor-3");
    expect(parseGlassdoor(JSON.stringify({ data: { jobListings: results } }), 3, now).next).toBeUndefined();
    // A bot check's page carries no payload.
    expect(parseGlassdoor("<title>Just a moment...</title>")).toEqual({ jobs: [], next: undefined });
    expect(parseGlassdoor("{not json")).toEqual({ jobs: [], next: undefined });
  });

  it("asks Glassdoor for a later page as its Show more jobs button does", () => {
    const { url, init } = glassdoorMore("Software Intern", "Canada", 14, 2, "c2");
    expect(url).toBe("https://www.glassdoor.ca/job-search-next/bff/jobSearchResultsQuery");
    expect(init).toMatchObject({ method: "POST", credentials: "omit" });
    expect(JSON.parse(init.body)).toMatchObject({
      keyword: "software intern",
      filterParams: [{ filterKey: "fromAge", values: "14" }],
      originalPageUrl: "https://www.glassdoor.ca/Job/software-intern-jobs-SRCH_KO0,15.htm?fromAge=14",
      pageCursor: "c2",
      pageNumber: 2,
      parameterUrlInput: "KO0,15",
      seoFriendlyUrlInput: "software-intern-jobs",
    });
  });

  it("reads ZipRecruiter's result cards from the Next.js payload its search page streams, marking Quick Apply ones", () => {
    const at = Date.UTC(2026, 10, 5) / 1000;
    const card = (jid: string, type: number, extra: object = {}) => ({
      $typeName: "job_services.job_card.public.v1.JobCard",
      title: `Software Engineer Intern ${jid}`,
      rawCanonicalZipJobPageUrl: `/c/PayPal/Job/Software-Engineer-Intern/-in-Austin,TX?jid=${jid}`,
      company: { name: "PayPal" },
      location: { displayName: "Austin, TX US 78716" },
      display: { location: "Austin, TX", locationTypes: "On-site" },
      status: { isActive: true, postedAtUtc: { seconds: `$n${at}`, nanos: 0 } },
      applyButtonConfig: { applyButtonType: type },
      ...extra,
    });
    const payload = `5:["$","div",null,{"jobKeys":[{"listingKey":"x"}],"jobCards":${JSON.stringify([
      card("a1", 4),
      card("b2", 3),
      card("c3", 4, { display: { location: "Austin, TX", locationTypes: "Remote" } }),
      card("d4", 4, { status: { isActive: false } }),
      card("a1", 4),
    ])}}]`;
    // Streamed in pieces, each a JS string literal.
    const html = [payload.slice(0, 40), payload.slice(40)]
      .map((s) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`)
      .join("");
    const out = parseZipRecruiter(html);
    expect(out.map((l) => l.title)).toEqual([
      "Software Engineer Intern a1",
      "Software Engineer Intern b2",
      "Software Engineer Intern c3",
    ]);
    expect(out[0]).toEqual({
      url: "https://www.ziprecruiter.com/c/PayPal/Job/Software-Engineer-Intern/-in-Austin,TX?jid=a1",
      title: "Software Engineer Intern a1",
      company: "PayPal",
      location: "Austin, TX",
      postedAt: at * 1000,
      source: "ziprecruiter",
      easyApply: undefined,
    });
    expect(out[1].easyApply).toBe(true);
    expect(out[2].location).toBe("Remote - Austin, TX");
    // A bot check's page carries no payload.
    expect(parseZipRecruiter("<title>Just a moment...</title>")).toEqual([]);
    expect(zipRecruiterSearch("C++ intern", "Toronto, ON", 14)).toBe(
      "https://www.ziprecruiter.com/jobs-search?search=C%2B%2B%20intern&location=Toronto%2C%20ON&days=14",
    );
    expect(zipRecruiterSearch("C++ intern", "Toronto, ON", 14, 1)).toBe(
      "https://www.ziprecruiter.com/jobs-search/2?search=C%2B%2B%20intern&location=Toronto%2C%20ON&days=14",
    );
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
    // Greenhouse's embed, as its script frames it on a company's careers page.
    expect(boardOf("https://job-boards.greenhouse.io/embed/job_board?for=onbe&b=https%3A%2F%2Fwww.onbe.com")).toEqual({
      ats: "greenhouse",
      slug: "onbe",
    });
    expect(boardOf("https://boards.greenhouse.io/embed/job_board")).toBeNull();
  });

  it("reads a careers page's embedded ATS board from its API when the page itself lists no jobs", async () => {
    const f = async (url: string) =>
      url === "https://boards-api.greenhouse.io/v1/boards/onbe/jobs"
        ? new Response(JSON.stringify({ jobs: [{ absolute_url: "https://gh/onbe/1", title: "Software Intern" }] }))
        : new Response("", { status: 404 });
    const frame = { href: "https://job-boards.greenhouse.io/embed/job_board?for=onbe", text: "", frame: true };
    const problems: string[] = [];
    const site = (links: { href: string; text: string; frame?: boolean }[]) =>
      careerSite(
        f,
        async () => links,
        "https://www.onbe.com/careers",
        "",
        (p) => problems.push(p),
      ).then((jobs) => jobs.map((j) => j.title));
    expect(await site([{ href: "https://www.onbe.com/about", text: "About us" }, frame])).toEqual(["Software Intern"]);
    // The page's own job links still win.
    expect(await site([{ href: "https://www.onbe.com/jobs/7", text: "Data Analyst" }, frame])).toEqual([
      "Data Analyst",
    ]);
    expect(problems).toEqual([]);
    // Any other frame is no board, and no link either.
    expect(await site([{ ...frame, href: "https://www.youtube.com/embed/x1" }])).toEqual([]);
    expect(problems).toEqual(["The page didn't load in the hidden page, or had no links"]);
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

  it("places a city by its state when the city list has it only elsewhere", () => {
    // Simplify's short forms.
    expect(locationMatches("SF", ["United States"], false)).toBe(true);
    expect(locationMatches("South SF", ["California"], false)).toBe(true);
    expect(locationMatches("Toronto, ON, Canada; SF", ["Bay Area", "NYC", "Seattle"], false)).toBe(true);
    // Malvern is listed in Ontario and Arkansas only, St Paul (as "St") in Alberta only, Malta as a country.
    expect(locationMatches("Malvern, PA", ["United States"], false)).toBe(true);
    expect(locationMatches("Malvern, PA", ["Canada"], false)).toBe(false);
    expect(locationMatches("St Paul, MN", ["Minnesota"], false)).toBe(true);
    expect(locationMatches("St Paul, MN", ["Canada"], false)).toBe(false);
    expect(locationMatches("Malta, NY", ["United States"], false)).toBe(true);
    expect(locationMatches("Folsom, NJ", ["California"], false)).toBe(false);
    // "LA" is Los Angeles as well as Louisiana.
    expect(locationMatches("Woodland Hills, LA", ["California"], false)).toBe(true);
    expect(locationMatches("Baton Rouge, LA", ["Louisiana"], false)).toBe(true);
    expect(locationMatches("Baton Rouge, LA", ["California"], false)).toBe(false);
    // Outside the US stays out.
    expect(locationMatches("London, UK", ["United States"], true)).toBe(false);
    expect(locationMatches("Remote in Canada", ["Bay Area", "NYC", "Seattle"], true)).toBe(false);
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
    expect(applied([a("added", "submitted")], "k", "", true)).toBe(true); // added by hand: never re-applied
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
    expect(extract(html, "link", [siteOfUrl("https://acme.wd5.myworkdayjobs.com/en-US/careers/login")])).toBe(
      "https://acme.wd5.myworkdayjobs.com/en-US/careers/activate/abc",
    );
    expect(extract(html, "link", [siteOf("jobs.other.com")])).toBeNull();
    // Every company's Workday is one site; the tenant tells them apart (Intel's reset followed SOTI's emailed link).
    const intel = siteOfUrl("https://intel.wd1.myworkdayjobs.com/en-US/External/job/x/apply");
    expect(
      extract(`<a href="https://soti.wd3.myworkdayjobs.com/SOTI/passwordreset/abc">Reset</a>`, "link", [intel]),
    ).toBeNull();
    expect(siteOfUrl("https://wd5.myworkday.com/acme/verify?t=1")).toBe(
      siteOfUrl("https://acme.wd5.myworkdayjobs.com/x"),
    );
    expect(siteOfUrl("https://wd1.myworkdaysite.com/en-US/recruiting/acme/External")).toBe(
      siteOfUrl("https://ACME.wd1.myworkdayjobs.com/x"),
    );
    expect(siteOfUrl("https://careers.acme.com/x")).toBe("acme.com");
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
  it("names a user-added account as the sign-in page will", () => {
    expect(accountSite("https://acme.wd5.myworkdayjobs.com/en-US/careers/login")).toBe("workday:acme");
    expect(accountSite("https://www.careers.example.com/signin")).toBe("careers.example.com");
    expect(accountSite("https://career17.sapsf.com/careers?company=cmhcschl")).toBe("sf:career17.sapsf.com:cmhcschl");
    expect(accountSite("https://career4.successfactors.com/career?company=Teck&x=1")).toBe(
      "sf:career4.successfactors.com:teck",
    );
    // No company: it would be no company's account, so it isn't saved.
    expect(accountSite("https://career4.successfactors.com/career")).toBeNull();
  });

  it("keys accounts on shared sites by the job's company", () => {
    // One sign-in host for every employer, and sibling hosts on one site share the key.
    expect(accountKey("signin-ca.ultipro.ca", "McCain Foods Limited")).toBe("ultipro.ca|mccain foods");
    expect(accountKey("recruiting.ultipro.ca", "McCain Foods")).toBe("ultipro.ca|mccain foods");
    expect(accountKey("dfid.dayforcehcm.com", "Acme, Inc.")).toBe("dayforcehcm.com|acme");
    expect(accountKey("dfid.dayforcehcm.com", "Other Co")).toBe("dayforcehcm.com|other");
    expect(accountKey("login.icims.com", "Kinaxis")).toBe(accountKey("careers-kinaxis.icims.com", "Kinaxis Inc."));
    expect(accountKey("jobs.example.co.uk", "Acme")).toBe("example.co.uk|acme");
    // The address names the company already.
    expect(accountKey("workday:intel", "Intel Corporation")).toBe("workday:intel");
    expect(accountKey("sf:career4.successfactors.com:teck", "Teck Resources")).toBe(
      "sf:career4.successfactors.com:teck",
    );
    expect(accountKey("sf:career4.successfactors.com:", "Teck Resources")).toBe("successfactors.com|teck resources");
    // No company known: the page's key, as before.
    expect(accountKey("signin-ca.ultipro.ca", "")).toBe("signin-ca.ultipro.ca");
    expect(accountKey("sf:career4.successfactors.com:", "")).toBe("sf:career4.successfactors.com:");
  });

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

  it("pages LinkedIn to the end of its results, and reads on after other sources from a page a lasting 429 stopped", async () => {
    const card = (id: number, title = `Software Engineer Intern ${id}`, company = "Acme") =>
      `<li data-entity-urn="urn:li:jobPosting:${id}"><h3 class="base-search-card__title">${title}</h3>
      <h4 class="base-search-card__subtitle">${company}</h4><span class="job-search-card__location">Toronto, ON</span></li>`;
    // Acme posts its jobs on Lever; Nobody's aren't on any board.
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
    /** `refused`: how many times each page answers 429 before it's read, as LinkedIn does at random. */
    const run = async (refused: Record<number, number> = {}, fresh = true) => {
      if (fresh) installChromeMock();
      gaps.length = 0;
      const starts: number[] = [];
      const f = async (url: string) => {
        if (url === "https://api.lever.co/v0/postings/acme?mode=json") return new Response(lever);
        if (!url.includes("linkedin")) return new Response("", { status: 404 });
        const start = Number(new URL(url).searchParams.get("start"));
        starts.push(start);
        return starts.filter((s) => s === start).length <= (refused[start] ?? 0)
          ? new Response("", { status: 429 })
          : new Response(pages[start] ?? "");
      };
      const n = await discover({ yolo: y, fetch: f });
      return [starts, n];
    };
    // Every page, to the first empty one, whatever room the batch has.
    expect(await run()).toEqual([[0, 10, 20, 30, 40], 3]);
    // A page refused once is read on retry, and paging goes on.
    expect(await run({ 0: 1, 20: 1 })).toEqual([[0, 0, 10, 20, 20, 30, 40], 3]);
    // LinkedIn is asked a second apart at most.
    const paced = gaps.filter((ms) => ms <= 1000);
    expect(paced.length).toBeGreaterThan(0);
    expect(paced.every((ms) => ms > 0)).toBe(true);
    // A burst outlasting the retries (2, 4, 6 s on): the search is put aside and read on from that page 30 s later.
    expect(await run({ 10: 4 })).toEqual([[0, 10, 10, 10, 10, 10, 20, 30, 40], 3]);
    expect(gaps.filter((ms) => ms > 1000)).toEqual([2000, 4000, 6000, expect.any(Number)]);
    expect(gaps.at(gaps.indexOf(6000) + 1)).toBeGreaterThan(29_000);
    // Refused again then: paging stops there and the limit is reported.
    expect(await run({ 10: Infinity })).toEqual([[0, ...Array(8).fill(10)], 1]);
    const { yoloSourceCheck } = (await chrome.storage.local.get("yoloSourceCheck")) as { yoloSourceCheck: SourceCheck };
    expect(yoloSourceCheck.groups[0]).toMatchObject({
      level: "warn",
      problem: "Rate limited by LinkedIn (HTTP 429) after 1 page",
    });
    // The next check reads every page again, and queues nothing twice.
    installChromeMock();
    expect(await run()).toEqual([[0, 10, 20, 30, 40], 3]);
    expect(await run({}, false)).toEqual([[0, 10, 20, 30, 40], 0]);
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
      if (url.includes("linkedin"))
        return new Response(url.includes("start=0") ? card(1, "Acme") + card(2, "Nobody") : "");
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
    const glassdoor = glassdoorPage(
      glassdoorResults([
        {
          id: 1,
          company: "Aptiv",
          title: "Cloud Software Engineering Intern",
          location: "Ottawa",
          host: "fr.glassdoor.ca",
        },
      ]),
    );
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

  it("reads every page of a Glassdoor search, each later one at the cursor the page before gave", async () => {
    const later = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => later(fn, 0)) as typeof setTimeout);
    onTestFinished(() => void vi.restoreAllMocks());
    const job = (id: number) => ({ id, company: `Co${id}`, title: "Software Engineer Intern", location: "Ottawa" });
    const asked: [string, unknown][] = [];
    const f = async (url: string, init?: RequestInit) => {
      if (!url.includes("glassdoor")) return new Response("", { status: 404 });
      const body = init?.body ? (JSON.parse(init.body as string) as { pageNumber: number; pageCursor: string }) : null;
      asked.push([url.replace(/^https:\/\/www\.glassdoor\.ca/, ""), body && [body.pageNumber, body.pageCursor]]);
      // Page 2 shows page 1's last posting again; page 3 is the last (no cursor past it).
      if (!body) return new Response(glassdoorPage(glassdoorResults([job(1), job(2)], [2, 3])));
      const results =
        body.pageNumber === 2 ? glassdoorResults([job(2), job(3)], [1, 3, 4]) : glassdoorResults([job(4)], [1, 2]);
      return new Response(JSON.stringify({ data: { jobListings: results } }));
    };
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern"],
      locations: ["Canada"],
      feeds: [],
      boards: ["glassdoor" as const],
    };
    expect(await discover({ yolo: y, fetch: f })).toBe(4);
    expect(asked).toEqual([
      ["/Job/software-engineer-intern-jobs-SRCH_KO0,24.htm?fromAge=14", null],
      ["/job-search-next/bff/jobSearchResultsQuery", [2, "cursor-2"]],
      ["/job-search-next/bff/jobSearchResultsQuery", [3, "cursor-3"]],
    ]);
    const { yoloSourceCheck } = (await chrome.storage.local.get("yoloSourceCheck")) as { yoloSourceCheck: SourceCheck };
    expect(yoloSourceCheck.groups[0].rows[0]).toMatchObject({ found: 4, level: "ok" });
  });

  it("queues ZipRecruiter jobs from every page of a search, past a page a bot check stood in for", async () => {
    const later = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => later(fn, 0)) as typeof setTimeout);
    onTestFinished(() => void vi.restoreAllMocks());
    const card = (jid: string) => ({
      title: "Software Engineer Intern",
      rawCanonicalZipJobPageUrl: `/c/Nobody${jid}/Job/Software-Engineer-Intern/-in-Ottawa,ON?jid=${jid}`,
      company: { name: `Nobody${jid}` },
      display: { location: "Ottawa, ON" },
      applyButtonConfig: { applyButtonType: 4 },
    });
    const page = (...jids: string[]) =>
      new Response(
        `<script>self.__next_f.push([1,${JSON.stringify(`"jobCards":${JSON.stringify(jids.map(card))}`)}])</script>`,
      );
    const challenge = () =>
      new Response("<title>Just a moment...</title>", { status: 403, headers: { "cf-mitigated": "challenge" } });
    const asked: string[] = [];
    const f = async (url: string) => {
      if (!url.includes("ziprecruiter")) return new Response("", { status: 404 });
      asked.push(url.replace(/\?.*/, "").replace("https://www.ziprecruiter.com", ""));
      if (!url.includes("search=Software")) return challenge();
      const n = /jobs-search\/(\d+)/.exec(url)?.[1] ?? "1";
      // Page 2 is checked; page 3 repeats a posting of page 1 (its pages shuffle); page 4 is past the last.
      return n === "1" ? page("9f") : n === "2" ? challenge() : n === "3" ? page("9f", "8e") : page();
    };
    const y = {
      ...defaultYolo(),
      queries: ["Software Engineer Intern", "Co-op"],
      locations: ["Canada"],
      feeds: [],
      boards: ["ziprecruiter" as const],
    };
    expect(await discover({ yolo: y, fetch: f })).toBe(2);
    // Two checked pages in a row leave the search for the next check.
    expect(asked).toEqual([
      "/jobs-search",
      "/jobs-search/2",
      "/jobs-search/3",
      "/jobs-search/4",
      "/jobs-search",
      "/jobs-search/2",
    ]);
    const { yoloQueue, yoloSourceCheck } = (await chrome.storage.local.get(["yoloQueue", "yoloSourceCheck"])) as {
      yoloQueue: { url: string; sourceGroups: string[] }[];
      yoloSourceCheck: SourceCheck;
    };
    expect(yoloQueue[0]).toMatchObject({
      url: "https://www.ziprecruiter.com/c/Nobody9f/Job/Software-Engineer-Intern/-in-Ottawa,ON?jid=9f",
      sourceGroups: ["ziprecruiter"],
    });
    expect(yoloSourceCheck.groups[0].rows.map((r) => [r.label, r.found, r.level, r.problem ?? ""])).toEqual([
      ['"Software Engineer Intern" · Canada', 2, "warn", expect.stringMatching(/^A bot check .* on page 2\./)],
      ['"Co-op" · Canada', 0, "warn", expect.stringMatching(/^A bot check \(Cloudflare\) stood in for the search\./)],
    ]);
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
    const later = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => later(fn, 0)) as typeof setTimeout);
    onTestFinished(() => void vi.restoreAllMocks());
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
    // Page 2 is shown again past it: the search ends there.
    let search = (url: string) => new Response(page(url.includes("&start=") ? "a2" : "a1"));
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
      if (url.startsWith("https://ca.indeed.com/jobs?")) return search(url);
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

    // Signed in, the fetch passes: no tab, the user's cookies go with every request, and each page is read until one
    // has nothing new.
    expect(await run()).toBe(2);
    expect(asked).toEqual([
      ["https://secure.indeed.com/settings/account", "HEAD", "include"],
      ["https://ca.indeed.com/jobs", undefined, "include"],
      ["https://ca.indeed.com/jobs", undefined, "include"],
      ["https://ca.indeed.com/jobs", undefined, "include"],
    ]);
    expect(tabbed).toEqual([]);

    // Cloudflare checks the fetch: the search is read in the tab the user clears the check in.
    installChromeMock();
    search = () => new Response("<title>Just a moment...</title>", { status: 403 });
    tab = page("b2").replace(/^<script>|<\/script>$/g, "");
    expect(await run()).toBe(1);
    expect(tabbed).toEqual([
      "https://ca.indeed.com/jobs?q=Software%20Intern&l=Canada&fromage=14&sort=date",
      "https://ca.indeed.com/jobs?q=Software%20Intern&l=Canada&fromage=14&sort=date&start=10",
    ]);
    expect(indeedSearch("Software Intern", "Canada", 14, 3)).toMatch(/&sort=date&start=30$/);

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
    expect(await discover({ yolo: y, fetch: f, scrape, now })).toBe(1);
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
    // Each site's row links to the page the user entered.
    expect(g.careers.rows.map((r) => r.url)).toEqual(y.careerSites);

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
    expect(YoloSchema.parse({ sourceOrder: ["feeds", "careers"] }).sourceOrder.slice(-2)).toEqual([
      "jobright",
      "added",
    ]);
  });

  it("drops a retry whose job was submitted since it was queued, never one stopped mid-way", () => {
    const item = { key: "geo", alt: "geo|dev", postedAt: RETRY, addedAt: 100 } as QueueItem;
    const app = (status: Application["status"], at: number, key = "geo") =>
      ({ key, alt: "geo|dev", status, at, mode: "yolo" }) as Application;
    // Stopped mid-way (needs, failed, or no record yet): it runs.
    expect(runnable([app("needs", 200)], item, false)).toBe(true);
    expect(runnable([], item, false)).toBe(true);
    // Submitted meanwhile, under its key or another copy's (GeoSpectrum): applying again would apply twice.
    expect(runnable([app("submitted", 200)], item, false)).toBe(false);
    expect(runnable([app("submitted", 200, "other")], item, false)).toBe(false);
    // The user's own submission before it was queued, re-applying allowed: it runs.
    expect(runnable([{ ...app("submitted", 50), mode: "manual" }], item, true)).toBe(true);
    // Not a retry: the already-applied check as before.
    expect(runnable([app("failed", 50)], { ...item, postedAt: 1 }, false)).toBe(false);
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

  it("guesses required fields and optional questions that help, never opt-ins, fact boxes or blank options", async () => {
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
        options: ["Employee referral", "Colleague"],
        required: false,
      }),
      field("note", { kind: "textarea", label: "Anything else?", required: false }),
      field("twitter", { kind: "text", label: "Twitter handle", required: false }),
      field("teams", {
        kind: "checkbox_group",
        label: "Which teams interest you?",
        options: ["Web", "ML"],
        required: false,
      }),
    ];
    await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields, profile: emptyProfile(), documents: [], job: null, yolo: true },
    );
    expect(asked).toEqual([["deadline", "heard", "note", "teams"]]);
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

  it("gives a background tab the CAPTCHA wait too, but not the hidden frame", () => {
    expect(overdue(run("tab", "captcha"), 20 * min)).toBeNull();
    expect(overdue(run("tab", "captcha"), 25 * min)).toMatchObject({ reason: "The CAPTCHA wasn't solved" });
    expect(overdue(run("frame", "captcha"), 15 * min)).toMatchObject({ status: "blocked" });
  });

  it("still ends stalled or overlong runs", () => {
    expect(overdue(run("visible", "form"), 15 * min)).toMatchObject({ reason: "No progress for 3 minutes" });
    expect(overdue(run("frame", "form"), 15 * min)).toMatchObject({ reason: "No progress for 3 minutes" });
    expect(overdue(run("tab", "form"), 13 * min)).toMatchObject({ reason: "Took over 12 minutes" });
  });

  it("retries a hidden frame that went quiet before any form in a tab", () => {
    expect(overdue(run("frame", "job"), 15 * min)).toMatchObject({ status: "blocked" });
    expect(overdue(run("frame", "captcha"), 15 * min)).toMatchObject({ status: "blocked" });
    expect(overdue(run("tab", "job"), 15 * min)).toMatchObject({ status: "failed" });
    // A form was filled: its submission may have gone through, so no retry.
    const filled = run("frame", "unknown");
    filled.steps.unshift("form|/apply||5");
    expect(overdue(filled, 15 * min)).toMatchObject({ status: "failed" });
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
    // Two password boxes under SuccessFactors' "Password Reset" set a new password, not a new account (L3Harris).
    const reset = { ...page, path: "/career", passwords: 2, fields: 2 };
    expect(kindOf({ ...reset, headings: "Career Opportunities: Password Reset" }, false)).toBe("reset");
    expect(kindOf({ ...reset, headings: "Career Opportunities: Create an Account" }, false)).toBe("signup");
  });
});
