// One discovery cycle: read every source, keep the new postings that fit the user, queue them for applying.
import { createStorage } from "../../shared/storage";
import {
  SOURCE_GROUPS,
  sourceGroup,
  type Application,
  type Listing,
  type QueueItem,
  type QueueSort,
  type SourceGroup,
  type SourceRow,
  type Yolo,
} from "../../shared/yolo";
import { boardOf, careerSite, findOnEmployerBoard, type Fetcher } from "./careers";
import { rejectReason } from "./filter";
import { altKey, jobKey } from "./jobKey";
import { loadPlaces } from "./places";
import { updateQueue } from "./applicationStore";
import { getRun } from "./runner";
import { plainError, startSourceCheck } from "./sourceCheck";
import {
  glassdoorSearch,
  INDEED_ACCOUNT,
  indeedHost,
  indeedSearch,
  jobrightFeed,
  linkedinSearch,
  parseFeed,
  parseGlassdoor,
  parseIndeed,
  parseJobrightFeed,
  parseLinkedIn,
  indeedSignedOut,
  type Link,
} from "./sources";

const store = createStorage("background");
/** Postings checked by the AI per cycle; the rest wait for the next one. */
const BATCH = 60;
/** LinkedIn search pages read per search when `want` asks for more: ~20 fast pages draw a 429, 40 a second apart don't (live, 2026-11-03). */
const LINKEDIN_PAGES = 30;
const LINKEDIN_GAP_MS = 1000;
/** Jobright recommendation pages of 20 (~240 kB each) read per cycle; the feed held 160 jobs (live, 2026-11-03). */
const JOBRIGHT_PAGES = 15;
const NO_OWN = "No posting on the employer's own site";

export interface DiscoverDeps {
  yolo: Yolo;
  fetch: Fetcher;
  /** Renders a page in the hidden host and reads its links; absent while an application is running there. */
  scrape?: (url: string) => Promise<Link[] | null>;
  /** Indexes of the listings the AI judges a match; absent = keep all. */
  relevance?: (items: Listing[]) => Promise<Set<number>>;
  /**
   * Jobs the batch still has room for: LinkedIn is paged until that many fit, counting the lists read before it and
   * LinkedIn's postings that have an employer posting. Absent = its first page only.
   */
  want?: number;
  /** Told whether Jobright's feed answered as signed out, each time it's read. */
  jobrightSignedOut?: (out: boolean) => unknown;
  /**
   * Renders an Indeed search in a tab with the user's session, for when Cloudflare checks the fetch: what
   * `indeedCardsInPage` read there, or null if a bot check still stood in. Absent = the fetch only.
   */
  indeedTab?: (url: string) => Promise<string | null>;
  /** Told whether Indeed answered as signed out, each time discovery asks (Indeed is skipped while it is). */
  indeedSignedOut?: (out: boolean) => unknown;
  /** Told whether Indeed's search showed a bot check instead of results, each time it's read. */
  indeedBlocked?: (blocked: boolean) => unknown;
  /** A mid-batch top-up, as the source check reports it. */
  topUp?: boolean;
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
const groupOf = sourceGroup;

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

/** Whether Indeed answers the user as signed out (its account page sends them to sign in); null = it couldn't be asked. */
export async function indeedSignedOutNow(fetch: Fetcher): Promise<boolean | null> {
  const r = await fetch(INDEED_ACCOUNT, { method: "HEAD", credentials: "include" }).catch(() => null);
  return r ? indeedSignedOut(r.url) : null;
}

/**
 * One Indeed search, read as the signed-in user: fetched with their cookies, and when Cloudflare checks the fetch,
 * rendered in a tab instead (whose passed check also lets the next fetch through). null = a bot check stood in both ways.
 */
export async function readIndeed(
  d: Pick<DiscoverDeps, "fetch" | "indeedTab">,
  q: string,
  loc: string,
  days: number,
): Promise<Listing[] | null> {
  const url = indeedSearch(q, loc, days);
  const host = indeedHost(loc);
  const r = await d.fetch(url, { credentials: "include" });
  const list = r.ok ? parseIndeed(await r.text(), host) : null;
  if (list || !d.indeedTab) return list;
  const page = await d.indeedTab(url);
  return page === null ? null : (parseIndeed(page, host) ?? []);
}

const sourceName = (url: string) => {
  const m = /github(?:usercontent)?\.com\/([^/]+)\/([^/]+)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : new URL(url).hostname;
};
/** A URL as the source check names it: never throws. */
const labelOf = (url: string, name: (u: string) => string) => {
  try {
    return name(url);
  } catch {
    return url;
  }
};
const sitePath = (url: string) => {
  const u = new URL(url);
  return (u.host + u.pathname).replace(/\/$/, "");
};
const pages = (n: number) => (n ? ` after ${n} page${n === 1 ? "" : "s"}` : "");

export async function discover(d: DiscoverDeps): Promise<number> {
  const { yolo: y } = d;
  const now = d.now ?? Date.now();
  const [s, running] = await Promise.all([
    store.getMany(["yoloRejected", "applications", "yoloQueue", "feedCache", "employerBoards"]),
    getRun(),
  ]);
  const found: Listing[] = [];
  const t = await startSourceCheck(y, !!d.topUp, now);
  const safely = async (row: SourceRow, fn: () => Promise<Listing[]>) => {
    try {
      const list = await fn();
      t.read(row, list);
      found.push(...list);
    } catch (e) {
      console.warn("[AutoApply] YOLO source failed:", (e as Error)?.message);
      t.problem(row, plainError(e), "error");
    }
  };

  const readFeed = (url: string, parse: (body: string) => Listing[]) => {
    const row = t.row("feeds", labelOf(url, sourceName));
    return safely(row, async () => {
      // Conditional: GitHub answers 304 while the file is unchanged (most polls), so only changes are downloaded.
      const c = s.feedCache[url];
      const r = await d.fetch(url, {
        headers: {
          ...(c?.etag ? { "if-none-match": c.etag } : {}),
          ...(c?.modified ? { "if-modified-since": c.modified } : {}),
        },
      });
      if (r.status === 304) t.problem(row, "Unchanged since its last read: its jobs were already looked at", "info");
      else if (!r.ok) t.problem(row, `The list answered HTTP ${r.status}: check the URL`, "error");
      if (r.status === 304 || !r.ok) return [];
      s.feedCache[url] = { etag: r.headers.get("etag") ?? "", modified: r.headers.get("last-modified") ?? "" };
      const list = parse(await r.text());
      if (!list.length) t.problem(row, "No jobs read from it (not a listings.json or a job table?)", "warn");
      return list;
    });
  };
  for (const url of y.feeds) await readFeed(url, (body) => parseFeed(body, sourceName(url)));
  await t.done("feeds");
  if (y.jobright.length) {
    const row = t.row("jobright", "Your recommendations");
    await safely(row, async () => {
      const out: Listing[] = [];
      let page = 0;
      for (; page < JOBRIGHT_PAGES; page++) {
        // The user's cookies: the feed is theirs, filtered by their Jobright preferences.
        const r = await d.fetch(jobrightFeed(page), { credentials: "include" });
        if (page === 0) await d.jobrightSignedOut?.(r.status === 401);
        if (r.status === 401) t.problem(row, "Signed out: sign in to jobright.ai in this browser", "error");
        else if (!r.ok) t.problem(row, `Jobright answered HTTP ${r.status}${pages(page)}`, page ? "warn" : "error");
        const list = r.ok ? ((await r.json()) as { result?: { jobList?: [] } }).result?.jobList : undefined;
        if (!list?.length) {
          if (r.ok && !page) t.problem(row, "Jobright recommended no jobs: check your Jobright preferences", "warn");
          break;
        }
        const jobs = parseJobrightFeed(list);
        // Counted as found: the ones linking back to LinkedIn or Jobright are dropped here, not by the filters.
        row.found += list.length - jobs.length;
        t.drop("jobright", "No link to the employer's own site", list.length - jobs.length);
        out.push(...jobs);
      }
      if (page === JOBRIGHT_PAGES)
        t.problem(row, `Read the first ${JOBRIGHT_PAGES * 20} recommendations (the most per check)`, "info");
      return out;
    });
    await t.done("jobright");
  }

  await loadPlaces();
  const rejected = s.yoloRejected;
  // Expired before use, so a shortened `aiRejectDays` applies this check.
  for (const [k, at] of Object.entries(rejected)) if (now - at > y.aiRejectDays * 86400e3) delete rejected[k];
  // Every job not yet in Applications can be queued, once: the queue's, and the one being applied to right now.
  const queued = new Set(
    [...s.yoloQueue, ...(running?.mode === "apply" ? [running.item] : [])]
      .flatMap((i) => [i.key, i.alt, i.listing])
      .filter(Boolean),
  );
  const taken = (key: string, alt: string) => queued.has(key) || queued.has(alt);
  // What the pass below keeps before the AI and employer lookups, so LinkedIn stops paging once there's enough.
  const fits = (l: Listing, key = jobKey(l.url), alt = altKey(l.company, l.title)) =>
    !rejected[key] &&
    !rejected[alt] &&
    !taken(key, alt) &&
    !rejectReason(l, y, now) &&
    !applied(s.applications, key, alt, y.reapplyManual);
  const boards = new Map<string, Listing[] | null>();
  // LinkedIn shows logged-out visitors no way to the employer, so each fitting card is looked up on the employer's own
  // board while paging: about 3 in 4 have none (live, 2026-11-03), and only those that do count toward `want`.
  const linkedin = new Map<string, string | null>();
  /** The employer postings found that way, new to YOLO: what `want` counts. */
  const linkedinOwn = new Set<string>();
  let linkedinAt = 0;
  // What the lists read above already supply, a posting counted once across them.
  const ahead = new Set(found.filter((l) => fits(l)).map((l) => altKey(l.company, l.title))).size;
  const days = y.postedWithinDays;
  // Indeed is searched only as the signed-in user: signed out, it's skipped and the user told.
  let indeed = false;
  /** Indeed's search showed a bot check this cycle: the searches after it are skipped. */
  let indeedWall = false;
  if (y.boards.includes("indeed")) {
    const out = await indeedSignedOutNow(d.fetch);
    if (out !== null) await d.indeedSignedOut?.(out);
    indeed = out === false;
    if (!indeed)
      t.problem(
        t.row("indeed", "Sign-in check"),
        out ? "Signed out: sign in to indeed.com in this browser" : "Couldn't reach Indeed to check the sign-in",
        "error",
      );
  }
  for (const q of y.queries)
    for (const loc of y.locations.length ? y.locations : [""]) {
      const label = `"${q}"${loc ? ` · ${loc}` : ""}`;
      if (y.boards.includes("linkedin")) {
        const row = t.row("linkedin", label);
        let read = 0;
        for (let page = 0; page < (d.want ? LINKEDIN_PAGES : 1); page++) {
          let more = false;
          await safely(row, async () => {
            const wait = linkedinAt + LINKEDIN_GAP_MS - Date.now();
            if (linkedinAt && wait > 0) await new Promise((r) => setTimeout(r, wait));
            linkedinAt = Date.now();
            const r = await d.fetch(linkedinSearch(q, loc, days, page * 10), { credentials: "omit" });
            if (!r.ok)
              t.problem(
                row,
                r.status === 429
                  ? `Rate limited by LinkedIn (HTTP 429)${pages(read)}`
                  : `LinkedIn refused the search (HTTP ${r.status})${pages(read)}`,
                read ? "warn" : "error",
              );
            const jobs = r.ok ? parseLinkedIn(await r.text()) : [];
            if (r.ok && !jobs.length && !page) t.problem(row, "No results for this search", "info");
            if (r.ok) read++;
            for (const l of jobs) {
              const key = jobKey(l.url);
              if (linkedin.has(key) || !fits(l, key)) continue;
              const own = await findOnEmployerBoard(d.fetch, l, s.employerBoards, boards).catch(() => null);
              linkedin.set(key, own);
              const k = own && jobKey(own);
              if (k && !queued.has(k) && !applied(s.applications, k, "", y.reapplyManual)) linkedinOwn.add(k);
            }
            // An empty page is the end of the results; a failed one (429) means stop asking. Pages already seen add
            // nothing, so a later search for the same batch reads on past them.
            more = jobs.length > 0 && ahead + linkedinOwn.size < (d.want ?? 0);
            return jobs;
          });
          if (!more) break;
        }
      }
      if (y.boards.includes("glassdoor")) {
        const row = t.row("glassdoor", label);
        await safely(row, async () => {
          const r = await d.fetch(glassdoorSearch(q, loc, days), { credentials: "omit" });
          if (!r.ok) t.problem(row, `Glassdoor refused the search (HTTP ${r.status})`, "error");
          const list = r.ok ? parseGlassdoor(await r.text(), now) : [];
          if (r.ok && !list.length) t.problem(row, "No results read from the page (none, or a bot check)", "warn");
          return list;
        });
      }
      if (indeed) {
        const row = t.row("indeed", label);
        await safely(row, async () => {
          // Cloudflare guards Indeed's search; YOLO never solves a bot check, it tells the user instead.
          const list = await readIndeed(d, q, loc, days);
          await d.indeedBlocked?.(!list);
          // Blocked both ways: the searches after it would be too, each one a tab.
          if (!list) {
            indeed = false;
            indeedWall = true;
            t.problem(
              row,
              "A bot check (Cloudflare) stood in for the search. YOLO doesn't solve these; using indeed.com yourself in this browser may clear it",
              "error",
            );
          } else if (!list.length) t.problem(row, "No results read from the search", "info");
          return list ?? [];
        });
      } else if (indeedWall) t.problem(t.row("indeed", label), "Skipped after the bot check", "info");
    }
  for (const g of ["linkedin", "glassdoor", "indeed"] as const) await t.done(g);

  for (const url of y.careerSites) {
    const row = t.row("careers", labelOf(url, sitePath));
    // Workday and SmartRecruiters search server-side; the other boards' APIs list every posting at once.
    const ats = boardOf(url)?.ats;
    const perQuery = /\{q\}/.test(url) || ats === "workday" || ats === "smartrecruiters";
    for (const q of perQuery ? y.queries : [""]) {
      // Before each page: an application started since the check began holds the hidden page, and a scrape would
      // take it over.
      if (!ats && (!d.scrape || (await getRun()))) {
        t.problem(row, "Skipped: an application was using the hidden page; it's read next batch", "info");
        break;
      }
      await safely(row, () =>
        careerSite(d.fetch, d.scrape ?? (async () => []), url, q, (p) => t.problem(row, p, "error")),
      );
    }
  }
  await t.done("careers");

  // Merge provenance only: the representative listing, filtering and order stay unchanged.
  const origins = new Map<string, Set<SourceGroup>>();
  for (const l of [...s.yoloQueue, ...found]) {
    for (const k of [jobKey(l.url), altKey(l.company, l.title)]) {
      if (!k) continue;
      const groups = origins.get(k) ?? new Set<SourceGroup>();
      for (const g of l.sourceGroups?.length ? l.sourceGroups : [sourceGroup(l.source)]) groups.add(g);
      origins.set(k, groups);
    }
  }
  const groupsFor = (l: Listing) => [
    ...new Set([...(origins.get(jobKey(l.url)) ?? []), ...(origins.get(altKey(l.company, l.title)) ?? [])]),
  ];
  // New postings that fit.
  const fresh: Listing[] = [];
  const keys = new Set<string>();
  for (const l of found) {
    const key = jobKey(l.url);
    const alt = altKey(l.company, l.title);
    // Also once per cycle: the same job from two sources, or a requisition's copies, are one application.
    const old =
      keys.has(key) || keys.has(alt)
        ? "Found twice (on another source, or a copy)"
        : taken(key, alt)
          ? "Already queued"
          : rejected[key] || rejected[alt]
            ? `AI judged it not a fit (in the last ${y.aiRejectDays} days)`
            : "";
    if (old) {
      t.drop(l, old);
      continue;
    }
    keys.add(key);
    keys.add(alt);
    t.count(l, "fresh");
    const why =
      rejectReason(l, y, now) ?? (applied(s.applications, key, alt, y.reapplyManual) ? "Already applied" : "");
    if (why) {
      t.drop(l, why);
      continue;
    }
    t.count(l, "matched");
    // Looked up while paging and not on the employer's board: done with, without taking a place in the AI's batch.
    if (l.source === "linkedin" && !linkedin.get(key)) {
      t.drop(l, NO_OWN);
      continue;
    }
    fresh.push(l);
  }
  // In queue order, so the jobs the user ranks first aren't the ones left for the next cycle.
  const ordered = inQueueOrder(fresh, y, now);
  const batch = ordered.slice(0, BATCH);
  for (const l of ordered.slice(BATCH)) t.drop(l, `Waits for the next check (${BATCH} per check)`);
  const keep = d.relevance && batch.length ? await d.relevance(batch) : null;

  const items: QueueItem[] = [];
  for (const [i, l] of batch.entries()) {
    const key = jobKey(l.url);
    const alt = altKey(l.company, l.title);
    if (keep && !keep.has(i)) {
      rejected[key] = now;
      if (alt) rejected[alt] = now;
      t.drop(l, "AI judged it not a fit");
      continue;
    }
    let url = l.url;
    // Boards: apply on the employer's own posting. LinkedIn shows logged-out visitors no way there; Glassdoor and
    // Indeed pages have an "Apply on company site" button the run can click instead.
    if (["linkedin", "glassdoor", "indeed"].includes(l.source)) {
      const own =
        l.source === "linkedin"
          ? linkedin.get(key)
          : await findOnEmployerBoard(d.fetch, l, s.employerBoards, boards).catch(() => null);
      if (own) url = own;
      else if (l.source === "linkedin") {
        t.drop(l, NO_OWN);
        continue;
      }
    }
    const k = jobKey(url);
    if (k !== key && (queued.has(k) || applied(s.applications, k, alt, y.reapplyManual))) {
      t.drop(l, "Employer's posting already queued or applied to");
      continue;
    }
    queued.add(k);
    t.count(l, "queued");
    items.push({
      key: k,
      alt,
      listing: key,
      url,
      company: l.company,
      title: l.title,
      location: l.location,
      source: l.source,
      sourceGroups: groupsFor(l),
      postedAt: l.postedAt ?? now,
      addedAt: now,
    });
  }

  await store.set({ yoloRejected: rejected, feedCache: s.feedCache, employerBoards: s.employerBoards });
  // Into the queue as it is now, not as read above: the pump may have started jobs from it meanwhile (written back,
  // they'd be applied to twice), and jobs may have been requeued or removed.
  let added = 0;
  await updateQueue((q) => {
    const have = new Set(q.flatMap((i) => [i.key, i.alt, i.listing]).filter(Boolean));
    const adding = items.filter((i) => ![i.key, i.alt, i.listing].some((k) => k && have.has(k)));
    added = adding.length;
    return [
      ...q.map((l) => ({ ...l, sourceGroups: [...new Set([...groupsFor(l), ...(l.sourceGroups ?? [])])] })),
      ...adding,
    ];
  });
  await t.finish();
  return added;
}
