// One discovery cycle: read every source, keep the new postings that fit the user, queue them for applying.
import { createStorage } from "../../shared/storage";
import {
  SOURCE_GROUPS,
  type Application,
  type Listing,
  type QueueItem,
  type QueueSort,
  type SourceGroup,
  type Yolo,
} from "../../shared/yolo";
import { boardOf, careerSite, findOnEmployerBoard, type Fetcher } from "./careers";
import { rejectReason } from "./filter";
import { altKey, jobKey } from "./jobKey";
import { loadPlaces } from "./places";
import {
  glassdoorSearch,
  indeedHost,
  indeedSearch,
  jobrightApply,
  jobrightList,
  linkedinSearch,
  parseFeed,
  parseGlassdoor,
  parseIndeed,
  parseJobright,
  parseLinkedIn,
  type Link,
} from "./sources";

const store = createStorage("background");
const SEEN_DAYS = 90;
/** Postings checked by the AI per cycle; the rest wait for the next one. */
const BATCH = 60;
/** LinkedIn search pages read per search when `want` asks for more: ~20 fast pages draw a 429, 40 a second apart don't (live, 2026-11-03). */
const LINKEDIN_PAGES = 30;
const LINKEDIN_GAP_MS = 1000;

export interface DiscoverDeps {
  yolo: Yolo;
  fetch: Fetcher;
  /** Renders a page in the hidden host and reads its links; absent while an application is running there. */
  scrape?: (url: string) => Promise<Link[]>;
  /** Indexes of the listings the AI judges a match; absent = keep all. */
  relevance?: (items: Listing[]) => Promise<Set<number>>;
  /** Jobs the batch still has room for: LinkedIn is paged until that many fit and have an employer posting. Absent = its first page only. */
  want?: number;
  now?: number;
}

/** Already applied: always for YOLO's own attempts, and for the user's submissions unless re-applying is allowed. */
export function applied(apps: Application[], key: string, alt: string, reapplyManual: boolean): boolean {
  return apps.some(
    (a) =>
      (a.key === key || (!!alt && a.alt === alt)) &&
      (a.mode === "yolo" || (a.status === "submitted" && !reapplyManual)),
  );
}

/** A requeued job's `postedAt`: it runs next, whatever the order. */
export const RETRY = Number.MAX_SAFE_INTEGER;
// careerSite's sources: its ATS APIs' names, or "careers" for a rendered page.
const CAREERS = new Set(["careers", "greenhouse", "lever", "ashby", "smartrecruiters", "workday"]);
const groupOf = (source: string): SourceGroup =>
  (SOURCE_GROUPS as readonly string[]).includes(source)
    ? (source as SourceGroup)
    : CAREERS.has(source)
      ? "careers"
      : "feeds";

type Ranked = Pick<Listing, "source" | "postedAt"> & { addedAt?: number };

/** Jobs in the order the user wants them applied to. Undated jobs count as posted when found. */
export function inQueueOrder<T extends Ranked>(items: T[], y: Yolo, now = Date.now()): T[] {
  const posted = (i: Ranked) => i.postedAt ?? now;
  const found = (i: Ranked) => i.addedAt ?? now;
  const rank = (i: Ranked) => {
    const r = y.sourceOrder.indexOf(groupOf(i.source));
    return r < 0 ? SOURCE_GROUPS.length : r;
  };
  const within: Record<QueueSort, (a: Ranked, b: Ranked) => number> = {
    newest: (a, b) => posted(b) - posted(a),
    oldest: (a, b) => posted(a) - posted(b),
    foundFirst: (a, b) => found(a) - found(b),
    foundLast: (a, b) => found(b) - found(a),
    random: () => 0,
  };
  const out = items.slice();
  // Shuffled first, then a stable sort keeps the shuffle within each source.
  if (y.queueSort === "random")
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
  return out.sort(
    (a, b) =>
      +(b.postedAt === RETRY) - +(a.postedAt === RETRY) ||
      (y.queueBySource ? rank(a) - rank(b) : 0) ||
      within[y.queueSort](a, b),
  );
}

const sourceName = (url: string) => {
  const m = /github(?:usercontent)?\.com\/([^/]+)\/([^/]+)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : new URL(url).hostname;
};

export async function discover(d: DiscoverDeps): Promise<number> {
  const { yolo: y } = d;
  const now = d.now ?? Date.now();
  const s = await store.getMany(["yoloSeen", "applications", "yoloQueue", "feedCache", "employerBoards"]);
  const found: Listing[] = [];
  const safely = async (fn: () => Promise<Listing[]>) => {
    try {
      found.push(...(await fn()));
    } catch (e) {
      console.warn("[AutoApply] YOLO source failed:", (e as Error)?.message);
    }
  };

  const readFeed = (url: string, parse: (body: string) => Listing[]) =>
    safely(async () => {
      // Conditional: GitHub answers 304 while the file is unchanged (most polls), so only changes are downloaded.
      const c = s.feedCache[url];
      const r = await d.fetch(url, {
        headers: {
          ...(c?.etag ? { "if-none-match": c.etag } : {}),
          ...(c?.modified ? { "if-modified-since": c.modified } : {}),
        },
      });
      if (r.status === 304 || !r.ok) return [];
      s.feedCache[url] = { etag: r.headers.get("etag") ?? "", modified: r.headers.get("last-modified") ?? "" };
      return parse(await r.text());
    });
  for (const url of y.feeds) await readFeed(url, (body) => parseFeed(body, sourceName(url)));
  for (const repo of y.jobright) await readFeed(jobrightList(repo), (body) => parseJobright(body, now));

  await loadPlaces();
  const seen = s.yoloSeen;
  const queued = new Set(s.yoloQueue.map((i) => i.key));
  // What the pass below keeps before the AI and employer lookups, so LinkedIn stops paging once there's enough.
  const fits = (l: Listing, key = jobKey(l.url), alt = altKey(l.company, l.title)) =>
    !seen[key] &&
    !seen[alt] &&
    !queued.has(key) &&
    !rejectReason(l, y, now) &&
    !applied(s.applications, key, alt, y.reapplyManual);
  const boards = new Map<string, Listing[] | null>();
  // LinkedIn shows logged-out visitors no way to the employer, so each fitting card is looked up on the employer's own
  // board while paging: about 3 in 4 have none (live, 2026-11-03), and only those that do count toward `want`.
  const linkedin = new Map<string, string | null>();
  /** The employer postings found that way, new to YOLO: what `want` counts. */
  const linkedinOwn = new Set<string>();
  let linkedinAt = 0;
  const days = y.postedWithinDays;
  for (const q of y.queries)
    for (const loc of y.locations.length ? y.locations : [""]) {
      if (y.boards.includes("linkedin"))
        for (let page = 0; page < (d.want ? LINKEDIN_PAGES : 1); page++) {
          let more = false;
          await safely(async () => {
            const wait = linkedinAt + LINKEDIN_GAP_MS - Date.now();
            if (linkedinAt && wait > 0) await new Promise((r) => setTimeout(r, wait));
            linkedinAt = Date.now();
            const r = await d.fetch(linkedinSearch(q, loc, days, page * 10), { credentials: "omit" });
            const jobs = r.ok ? parseLinkedIn(await r.text()) : [];
            for (const l of jobs) {
              const key = jobKey(l.url);
              if (linkedin.has(key) || !fits(l, key)) continue;
              const own = await findOnEmployerBoard(d.fetch, l, s.employerBoards, boards).catch(() => null);
              linkedin.set(key, own);
              if (own && !seen[jobKey(own)]) linkedinOwn.add(jobKey(own));
            }
            // An empty page is the end of the results; a failed one (429) means stop asking. Pages already seen add
            // nothing, so a later search for the same batch reads on past them.
            more = jobs.length > 0 && linkedinOwn.size < (d.want ?? 0);
            return jobs;
          });
          if (!more) break;
        }
      if (y.boards.includes("glassdoor"))
        await safely(async () => {
          const r = await d.fetch(glassdoorSearch(q, loc, days), { credentials: "omit" });
          return r.ok ? parseGlassdoor(await r.text(), now) : [];
        });
      if (y.boards.includes("indeed") && d.scrape)
        await safely(async () => parseIndeed(await d.scrape!(indeedSearch(q, loc, days)), indeedHost(loc)));
    }

  for (const url of y.careerSites) {
    // Workday and SmartRecruiters search server-side; the other boards' APIs list every posting at once.
    const ats = boardOf(url)?.ats;
    const perQuery = /\{q\}/.test(url) || ats === "workday" || ats === "smartrecruiters";
    if (!ats && !d.scrape) continue;
    for (const q of perQuery ? y.queries : [""])
      await safely(() => careerSite(d.fetch, d.scrape ?? (async () => []), url, q));
  }

  // New postings that fit, each looked at once.
  const fresh: Listing[] = [];
  const keys = new Set<string>();
  for (const l of found) {
    const key = jobKey(l.url);
    const alt = altKey(l.company, l.title);
    // Also once per cycle: the same job from two sources, or a requisition's copies, are one application.
    if (seen[key] || seen[alt] || keys.has(key) || keys.has(alt) || queued.has(key)) continue;
    keys.add(key);
    keys.add(alt);
    // Not marked seen: a posting the filters reject now may fit after the user changes them.
    if (rejectReason(l, y, now) || applied(s.applications, key, alt, y.reapplyManual)) continue;
    // Looked up while paging and not on the employer's board: done with, without taking a place in the AI's batch.
    if (l.source === "linkedin" && !linkedin.get(key)) {
      seen[key] = seen[alt] = now;
      continue;
    }
    fresh.push(l);
  }
  // In queue order, so the jobs the user ranks first aren't the ones left for the next cycle.
  const batch = inQueueOrder(fresh, y, now).slice(0, BATCH);
  const keep = d.relevance && batch.length ? await d.relevance(batch) : null;

  const items: QueueItem[] = [];
  let jobrightDown = false;
  for (const [i, l] of batch.entries()) {
    const key = jobKey(l.url);
    const alt = altKey(l.company, l.title);
    seen[key] = seen[alt] = now;
    if (keep && !keep.has(i)) continue;
    let url = l.url;
    // Boards: apply on the employer's own posting. LinkedIn shows logged-out visitors no way there; Glassdoor and
    // Indeed pages have an "Apply on company site" button the run can click instead.
    if (["linkedin", "glassdoor", "indeed"].includes(l.source)) {
      const own =
        l.source === "linkedin"
          ? linkedin.get(key)
          : await findOnEmployerBoard(d.fetch, l, s.employerBoards, boards).catch(() => null);
      if (own) url = own;
      else if (l.source === "linkedin") continue;
    }
    // Jobright's page names the employer's posting to a signed-in user (their cookies); otherwise look on its ATS.
    if (l.source === "jobright") {
      const page = jobrightDown
        ? undefined
        : await d
            .fetch(l.url, { credentials: "include" })
            .then(async (r) => (r.status === 404 ? null : r.ok ? jobrightApply(await r.text()) : undefined))
            .catch(() => undefined);
      // Rate-limited or unreachable: left unseen for the next cycle, and Jobright left alone for this one.
      if (page === undefined) {
        jobrightDown = true;
        delete seen[key];
        delete seen[alt];
        continue;
      }
      const own = page ?? (await findOnEmployerBoard(d.fetch, l, s.employerBoards, boards).catch(() => null));
      if (!own) continue;
      url = own;
    }
    const k = jobKey(url);
    if (k !== key && (seen[k] || applied(s.applications, k, alt, y.reapplyManual))) continue;
    seen[k] = now;
    items.push({
      key: k,
      alt,
      listing: key,
      url,
      company: l.company,
      title: l.title,
      location: l.location,
      source: l.source,
      postedAt: l.postedAt ?? now,
      addedAt: now,
    });
  }

  for (const [k, at] of Object.entries(seen)) if (now - at > SEEN_DAYS * 86400e3) delete seen[k];
  await store.set({
    yoloSeen: seen,
    yoloQueue: [...s.yoloQueue, ...items],
    feedCache: s.feedCache,
    employerBoards: s.employerBoards,
  });
  return items.length;
}
