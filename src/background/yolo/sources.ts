// Job sources: GitHub listing feeds and job boards. Parsed with regexes: a service worker has no DOMParser.
import type { Listing } from "../../shared/yolo";

/** A link read from a page rendered in the hidden host; `card` is the text of the result card around it. */
export interface Link {
  href: string;
  text: string;
  card?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : (ENTITIES[e.toLowerCase()] ?? m),
  );
export const text = (html: string) =>
  decode(html.replace(/<\/?br\s*\/?>/gi, "; ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
const enc = encodeURIComponent;

// ---------- GitHub feeds ----------
interface FeedRow {
  url?: string;
  company_name?: string;
  company?: string;
  title?: string;
  locations?: string[];
  location?: string;
  date_posted?: number;
  active?: boolean;
  is_visible?: boolean;
}

/** A Simplify-style listings.json, or a README whose tables hold Company | Role | Location | Apply link. */
export function parseFeed(body: string, source: string): Listing[] {
  const t = body.trimStart();
  if (!t.startsWith("[") && !t.startsWith("{")) return parseTables(t, source);
  const data = JSON.parse(t) as FeedRow[] | { listings?: FeedRow[] };
  return (Array.isArray(data) ? data : (data.listings ?? [])).flatMap((r) =>
    r?.url && r.title && r.active !== false && r.is_visible !== false
      ? [
          {
            url: r.url,
            company: r.company_name ?? r.company ?? "",
            title: r.title,
            location: r.locations?.join("; ") ?? r.location ?? "",
            postedAt: r.date_posted ? r.date_posted * 1000 : undefined,
            source,
          },
        ]
      : [],
  );
}

/** "↳" repeats the company of the row above; 🔒 marks a closed posting. */
function parseTables(md: string, source: string): Listing[] {
  const rows = [...md.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]),
  );
  for (const line of md.split("\n"))
    if (/^\s*\|/.test(line) && !/^\s*\|\s*:?-/.test(line))
      rows.push(
        line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|"),
      );
  const out: Listing[] = [];
  let company = "";
  for (const cells of rows) {
    if (cells.length < 4 || cells.join("").includes("🔒")) continue;
    const name = cellText(cells[0]);
    company = name === "↳" ? company : name;
    const url = cells
      .slice(3)
      .join(" ")
      .match(/https?:\/\/[^\s)"'<>]+/g)
      ?.find((u) => !/simplify\.jobs|github\.com|githubusercontent|imgur|shields\.io/.test(u));
    if (url && company)
      out.push({ url: decode(url), company, title: cellText(cells[1]), location: cellText(cells[2]), source });
  }
  return out;
}
const cellText = (s: string) => text(s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")).replace(/\*\*/g, "");

// ---------- job boards ----------
/** LinkedIn's logged-out search: fetched without cookies, so the user's account is never involved. */
export const linkedinSearch = (q: string, loc: string, days: number, start = 0) =>
  `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${enc(q)}&location=${enc(loc)}&f_TPR=r${days * 86400}&start=${start}`;

export function parseLinkedIn(html: string): Listing[] {
  return html
    .split('data-entity-urn="urn:li:jobPosting:')
    .slice(1)
    .flatMap((c) => {
      const id = /^\d+/.exec(c)?.[0];
      const pick = (re: RegExp) => text(re.exec(c)?.[1] ?? "");
      const date = /datetime="(\d{4}-\d\d-\d\d)"/.exec(c)?.[1];
      const title = pick(/base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
      return id && title
        ? [
            {
              url: `https://www.linkedin.com/jobs/view/${id}`,
              title,
              company: pick(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/),
              location: pick(/job-search-card__location[^>]*>([\s\S]*?)<\/span>/),
              postedAt: date ? Date.parse(date) : undefined,
              source: "linkedin",
            },
          ]
        : [];
    });
}

export const glassdoorSearch = (q: string, loc: string, days: number) =>
  `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${enc(q)}&locKeyword=${enc(loc)}&fromAge=${Math.min(days, 30)}`;

export function parseGlassdoor(html: string, now = Date.now()): Listing[] {
  const seen = new Set<string>();
  return html
    .split('data-jobid="')
    .slice(1)
    .flatMap((c) => {
      const id = /^\d+/.exec(c)?.[0];
      const link = /data-test="job-title"[^>]*href="([^"]+)"[^>]*>([^<]*)/.exec(c);
      if (!id || !link || seen.has(id)) return [];
      seen.add(id);
      const pick = (re: RegExp) => text(re.exec(c)?.[1] ?? "");
      const age = /data-test="job-age"[^>]*>([^<]*)/.exec(c)?.[1] ?? "";
      const n = Number(/\d+/.exec(age)?.[0] ?? NaN);
      return [
        {
          // Glassdoor answers Canadian visitors in French at times; YOLO reads English pages.
          url: decode(link[1]).replace(/:\/\/[a-z]{2}\.glassdoor\./, "://www.glassdoor."),
          title: text(link[2]),
          company: pick(/EmployerProfile_compactEmployerName[^"]*"[^>]*>([^<]*)/),
          location: pick(/data-test="emp-location"[^>]*>([^<]*)/),
          postedAt: Number.isFinite(n) ? now - n * (/h/i.test(age) ? 3600e3 : 86400e3) : undefined,
          source: "glassdoor",
          easyApply: /aria-label="Easy Apply"/.test(c) || undefined,
        },
      ];
    });
}

const INDEED_HOSTS: Record<string, string> = {
  canada: "ca.indeed.com",
  "united kingdom": "uk.indeed.com",
  uk: "uk.indeed.com",
  india: "in.indeed.com",
  australia: "au.indeed.com",
  germany: "de.indeed.com",
};
const indeedHost = (loc: string) => {
  const country = loc.split(",").pop()?.trim().toLowerCase() ?? "";
  return INDEED_HOSTS[country] ?? "www.indeed.com";
};

/** Indeed builds its result cards in script, so the search page is rendered in the hidden host. */
export const indeedSearch = (q: string, loc: string, days: number) =>
  `https://${indeedHost(loc)}/jobs?q=${enc(q)}&l=${enc(loc)}&fromage=${[1, 3, 7, 14].find((d) => d >= days) ?? 14}&sort=date`;

export function parseIndeed(links: Link[], host: string): Listing[] {
  const seen = new Set<string>();
  return links.flatMap((l) => {
    const jk = /[?&]jk=([0-9a-f]+)/.exec(l.href)?.[1];
    if (!jk || !l.card || !l.text || seen.has(jk)) return [];
    seen.add(jk);
    // A card reads: title, company, location, then pay and snippets.
    const lines = l.card
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const i = Math.max(0, lines.indexOf(l.text));
    return [
      {
        url: `https://${host}/viewjob?jk=${jk}`,
        title: l.text,
        company: lines[i + 1] ?? "",
        location: lines[i + 2] ?? "",
        source: "indeed",
        easyApply: /easily apply/i.test(l.card) || undefined,
      },
    ];
  });
}
export { indeedHost };

// ---------- Jobright ----------
/**
 * The signed-in user's Jobright recommendations (jobright.ai/jobs/recommend, filtered by their Jobright preferences):
 * a cursor, so page 0 starts a fresh list and later pages continue it until one comes back empty. Signed out = 401.
 */
export const jobrightFeed = (page: number) =>
  `https://jobright.ai/swan/recommend/list/jobs?refresh=${page === 0}&sortCondition=0&position=${page * 20}&count=20&syncRerank=false`;

interface JobrightJob {
  jobResult?: {
    jobTitle?: string;
    jobLocation?: string;
    jobLocations?: string[];
    workModel?: string;
    isRemote?: boolean;
    publishTime?: string;
    applyLink?: string;
    isDeleted?: boolean;
  };
  companyResult?: { companyName?: string };
}

/** A feed page's jobList, read as postings on the employer's own site (Jobright gives that link to signed-in users). */
export function parseJobrightFeed(list: JobrightJob[]): Listing[] {
  return list.flatMap(({ jobResult: j, companyResult: c }) => {
    let host: string;
    try {
      host = new URL(j?.applyLink ?? "").hostname;
    } catch {
      return [];
    }
    // LinkedIn shows logged-out visitors no way to the employer; Jobright's own links loop back to it.
    if (!j?.jobTitle || j.isDeleted || /(^|\.)(jobright\.ai|linkedin\.com)$/.test(host)) return [];
    const remote = j.isRemote || /^remote$/i.test(j.workModel ?? "");
    const places = j.jobLocations?.length ? j.jobLocations : [j.jobLocation ?? ""];
    // publishTime is UTC: "2026-11-03 16:59:05".
    const at = Date.parse(`${(j.publishTime ?? "").replace(" ", "T")}Z`);
    return [
      {
        url: j.applyLink!,
        title: j.jobTitle,
        company: c?.companyName ?? "",
        location: places.map((p) => (remote && !/\bremote\b/i.test(p) ? `Remote - ${p}` : p)).join("; "),
        postedAt: Number.isFinite(at) ? at : undefined,
        source: "jobright",
      },
    ];
  });
}
