// Employers' own job boards. Each ATS has a public JSON API listing every posting, so checking a company costs one
// small request instead of rendering its career site.
import { alnum, normalize } from "../../shared/normalize";
import type { Listing } from "../../shared/yolo";
import type { Link } from "./sources";

type Ats = "greenhouse" | "lever" | "ashby" | "smartrecruiters";
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface Board {
  ats: Ats | "workday";
  slug: string;
  /** Workday only: the career site's path segment and its host. */
  site?: string;
  host?: string;
}

const json = async <T>(f: Fetcher, url: string, init?: RequestInit): Promise<T | null> => {
  const r = await f(url, init).catch(() => null);
  return r?.ok ? ((await r.json().catch(() => null)) as T | null) : null;
};

/** Every posting on a board; null when the board doesn't exist. */
async function boardJobs(f: Fetcher, b: Board, company: string, query = ""): Promise<Listing[] | null> {
  const L = (url: string, title: string, location: string, posted?: string | number): Listing => ({
    url,
    title,
    company,
    location,
    postedAt: posted ? new Date(posted).getTime() || undefined : undefined,
    source: b.ats,
  });
  switch (b.ats) {
    case "greenhouse": {
      type R = {
        jobs: { absolute_url: string; title: string; location?: { name?: string }; first_published?: string }[];
      };
      const r = await json<R>(f, `https://boards-api.greenhouse.io/v1/boards/${b.slug}/jobs`);
      return r && r.jobs.map((j) => L(j.absolute_url, j.title, j.location?.name ?? "", j.first_published));
    }
    case "lever": {
      type R = { text: string; hostedUrl: string; categories?: { location?: string }; createdAt?: number }[];
      const r = await json<R>(f, `https://api.lever.co/v0/postings/${b.slug}?mode=json`);
      return r && r.map((j) => L(j.hostedUrl, j.text, j.categories?.location ?? "", j.createdAt));
    }
    case "ashby": {
      type R = { jobs: { title: string; jobUrl: string; location?: string; publishedAt?: string }[] };
      const r = await json<R>(f, `https://api.ashbyhq.com/posting-api/job-board/${b.slug}`);
      return r && r.jobs.map((j) => L(j.jobUrl, j.title, j.location ?? "", j.publishedAt));
    }
    case "smartrecruiters": {
      type R = {
        content: {
          id: string;
          name: string;
          location?: { fullLocation?: string; city?: string };
          releasedDate?: string;
        }[];
      };
      const q = query ? `&q=${encodeURIComponent(query)}` : "";
      const r = await json<R>(f, `https://api.smartrecruiters.com/v1/companies/${b.slug}/postings?limit=100${q}`);
      return (
        r &&
        r.content.map((j) =>
          L(
            `https://jobs.smartrecruiters.com/${b.slug}/${j.id}`,
            j.name,
            j.location?.fullLocation ?? j.location?.city ?? "",
            j.releasedDate,
          ),
        )
      );
    }
    case "workday": {
      type R = { jobPostings?: { title: string; externalPath: string; locationsText?: string; postedOn?: string }[] };
      const r = await json<R>(f, `https://${b.host}/wday/cxs/${b.slug}/${b.site}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: query }),
      });
      return (
        r &&
        (r.jobPostings ?? []).map((j) =>
          L(`https://${b.host}/${b.site}${j.externalPath}`, j.title, j.locationsText ?? "", workdayPosted(j.postedOn)),
        )
      );
    }
  }
}

/** "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" / "Posted 30+ Days Ago". */
export function workdayPosted(s = "", now = Date.now()): number | undefined {
  if (/today/i.test(s)) return now;
  if (/yesterday/i.test(s)) return now - 86400e3;
  const n = /(\d+)\+?\s*days?/i.exec(s)?.[1];
  return n ? now - Number(n) * 86400e3 : undefined;
}

/** The ATS board a career-site URL points at, if it is one with an API. */
export function boardOf(raw: string): Board | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split("/").filter(Boolean);
  if (/\.myworkday(jobs|site)\.com$/.test(host)) {
    const site = seg.find((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s));
    return site ? { ats: "workday", slug: host.split(".")[0], site, host } : null;
  }
  if (/(^|\.)greenhouse\.io$/.test(host) && seg[0] && seg[0] !== "embed") return { ats: "greenhouse", slug: seg[0] };
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && seg[0]) return { ats: "lever", slug: seg[0] };
  if (host === "jobs.ashbyhq.com" && seg[0]) return { ats: "ashby", slug: seg[0] };
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && seg[0]) return { ats: "smartrecruiters", slug: seg[0] };
  return null;
}

const companyOf = (host: string) => {
  const parts = host.replace(/^(www|jobs|careers?|apply)\./, "").split(".");
  return parts.length > 2 ? parts[parts.length - 3] : parts[0];
};

const ATS_NAMES: Record<Board["ats"], string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  workday: "Workday",
};

/**
 * A user's career-site URL: its board's API when it has one (one request for all postings), else the page rendered
 * in the hidden host with its job links read off it. "{q}" in the URL is replaced by each search query. `onProblem`
 * hears why the site gave no jobs, when that's a fault rather than no openings.
 */
export async function careerSite(
  f: Fetcher,
  scrape: (url: string) => Promise<Link[] | null>,
  raw: string,
  query: string,
  onProblem?: (problem: string) => void,
): Promise<Listing[]> {
  const url = raw.replace(/\{q\}/g, encodeURIComponent(query));
  const b = boardOf(url);
  if (b) {
    const jobs = await boardJobs(f, b, b.slug, query);
    if (!jobs) onProblem?.(`No ${ATS_NAMES[b.ats]} job board answered at this URL: check it`);
    return jobs ?? [];
  }
  const host = new URL(url).hostname;
  const links = await scrape(url);
  const jobs = jobLinks(links ?? [], companyOf(host), url);
  if (!links) onProblem?.("A bot check stood in for the page");
  else if (!links.length) onProblem?.("The page didn't load in the hidden page, or had no links");
  else if (!jobs.length)
    onProblem?.(
      "No job links found on the page: no openings, or not the page that lists jobs (a search URL with {q} works)",
    );
  return jobs;
}

const RE_JOB_LINK =
  /\/(jobs?|positions?|openings?|requisitions?|vacanc\w*|careers?\/job)\/[^?#]*\d|jobdetail|[?&](job_?id|gh_jid|jobreq|req_?id)=|\/j\/[A-Z0-9]{6,}|\.recruitee\.com\/o\/[^/?#]/i;
const RE_NOT_TITLE = /^(apply( now)?|learn more|view( job| details)?|see (details|more)|read more|details|more)$/i;

/** Job-detail links on a rendered career page: title = link text, location = the card's next line. */
export function jobLinks(links: Link[], company: string, base: string): Listing[] {
  const seen = new Set<string>();
  return links.flatMap((l) => {
    let href: string;
    try {
      href = new URL(l.href, base).toString();
    } catch {
      return [];
    }
    const title = l.text.trim();
    if (!RE_JOB_LINK.test(href) || title.length < 4 || title.length > 140 || RE_NOT_TITLE.test(title) || seen.has(href))
      return [];
    seen.add(href);
    const lines = (l.card ?? "").split("\n").map((s) => s.trim());
    return [{ url: href, title, company, location: lines[lines.indexOf(title) + 1] ?? "", source: "careers" }];
  });
}

/** Same title, ignoring case, punctuation, and term or year decorations. */
export const sameTitle = (a: string, b: string) => {
  const t = (s: string) =>
    normalize(s)
      .replace(/\b(20\d\d|summer|fall|winter|spring)\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  return t(a) === t(b);
};

/**
 * Where a board listing (LinkedIn hides its "Apply" link from logged-out visitors) is posted on the employer's own
 * ATS: their Greenhouse, Ashby or Lever board, found by trying slugs made from the company name. `known` caches the
 * company → board answer ("" = none found) across calls.
 */
export async function findOnEmployerBoard(
  f: Fetcher,
  l: Listing,
  known: Record<string, string>,
  boards: Map<string, Listing[] | null>,
): Promise<string | null> {
  const name = normalize(l.company);
  if (!name) return null;
  const tries: Board[] =
    name in known
      ? known[name]
        ? [{ ats: known[name].split(":")[0] as Ats, slug: known[name].split(":")[1] }]
        : []
      : (["greenhouse", "ashby", "lever"] as const).flatMap((ats) =>
          [...new Set([alnum(name), name.replace(/ /g, "-"), name.split(" ")[0]])].map((slug) => ({ ats, slug })),
        );
  for (const b of tries) {
    const id = `${b.ats}:${b.slug}`;
    if (!boards.has(id)) boards.set(id, await boardJobs(f, b, l.company));
    const jobs = boards.get(id);
    if (!jobs) continue;
    known[name] = id;
    return jobs.find((j) => sameTitle(j.title, l.title))?.url ?? null;
  }
  known[name] ??= "";
  return null;
}
