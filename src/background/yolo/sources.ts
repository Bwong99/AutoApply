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
export const jobrightList = (repo: string) => `https://raw.githubusercontent.com/jobright-ai/${repo}/master/README.md`;

/** Rows read | **[Company](site)** | **[Title](jobright.ai/jobs/info/…)** | Location | Work Model | Nov 02 |; "↳" repeats the company above. */
export function parseJobright(md: string, now = Date.now()): Listing[] {
  const out: Listing[] = [];
  let company = "";
  for (const line of md.split("\n")) {
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map(cellText);
    const url = /\((https:\/\/jobright\.ai\/jobs\/info\/[0-9a-f]+)/.exec(line)?.[1];
    if (!url || cells.length < 5) continue;
    company = cells[0] === "↳" ? company : cells[0];
    // The table gives month and day only: a date ahead of today is last year's.
    const year = new Date(now).getFullYear();
    const at = [year, year - 1].map((y) => Date.parse(`${cells[4]} ${y}`)).find((t) => t <= now + 86400e3);
    out.push({
      url,
      company,
      title: cells[1],
      location: /^remote$/i.test(cells[3]) && !/\bremote\b/i.test(cells[2]) ? `Remote - ${cells[2]}` : cells[2],
      postedAt: at,
      source: "jobright",
    });
  }
  return out;
}

/**
 * The employer's posting a Jobright job page links to (Jobright shows it to signed-in visitors only); null when it
 * names none or the job is gone; undefined when the page is unreadable or rate-limited (about 100 pages in 20 s).
 */
export function jobrightApply(html: string): string | null | undefined {
  try {
    const data = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    const props = JSON.parse(data).props?.pageProps;
    const job = props?.dataSource?.jobResult;
    // A job that no longer exists loads the same empty page, minus the flag.
    if (!job) return props && !props.detailLoadFailed ? null : undefined;
    const url = job.isDeleted ? "" : job.applyLink || job.originalUrl || "";
    // LinkedIn shows logged-out visitors no way to the employer; Jobright's own links loop back here.
    return /^https?:\/\//.test(url) && !/(^|\.)(jobright\.ai|linkedin\.com)$/.test(new URL(url).hostname) ? url : null;
  } catch {
    return undefined;
  }
}
