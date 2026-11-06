// The source check: per enabled source, what discovery read, what went wrong, and why found postings weren't queued.
// Written as each source finishes, so the Applications page shows it live; kept whatever Debug logging is set to.
import { createStorage } from "../../shared/storage";
import {
  SOURCE_LEVELS,
  type Listing,
  type SourceCheck,
  type SourceGroup,
  type SourceGroupCheck,
  type SourceLevel,
  type SourceRow,
  type Yolo,
} from "../../shared/yolo";

const store = createStorage("background");

/** The settings page's order. */
const ORDER: SourceGroup[] = ["linkedin", "indeed", "glassdoor", "jobright", "feeds", "careers"];
const on = (y: Yolo, g: SourceGroup) =>
  g === "feeds"
    ? y.feeds.length > 0
    : g === "careers"
      ? y.careerSites.length > 0
      : g === "jobright"
        ? y.jobright.length > 0
        : y.boards.includes(g);

const rank = (l: SourceLevel) => SOURCE_LEVELS.indexOf(l);

/** A thrown error as the user reads it. */
export function plainError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/failed to fetch|network ?error|load failed/i.test(m)) return "Couldn't connect (offline, or the site refused)";
  if (/invalid url/i.test(m)) return "Not a valid URL";
  if (/json|unexpected token/i.test(m)) return "Couldn't read the site's answer";
  return m || "Failed";
}

/** Marks a check discovery didn't finish (it threw), so it doesn't read as still running. */
export async function failSourceCheck(error: string) {
  const c = await store.get("yoloSourceCheck");
  if (c && !c.doneAt) await store.set({ yoloSourceCheck: { ...c, doneAt: Date.now(), error } });
}

export type SourceTracker = Awaited<ReturnType<typeof startSourceCheck>>;

export async function startSourceCheck(y: Yolo, topUp: boolean, now = Date.now()) {
  const check: SourceCheck = {
    at: now,
    topUp,
    doneAt: 0,
    error: "",
    groups: ORDER.filter((g) => on(y, g)).map((group) => ({
      group,
      done: false,
      found: 0,
      matched: 0,
      fresh: 0,
      queued: 0,
      drops: {},
      rows: [],
      problem: "",
      level: "ok",
    })),
  };
  const save = () => store.set({ yoloSourceCheck: check });
  const groupOf = (g: SourceGroup) => check.groups.find((x) => x.group === g);
  const owner = new Map<SourceRow, SourceGroupCheck>();
  const from = new WeakMap<Listing, SourceRow>();
  const ofListing = (l: Listing) => owner.get(from.get(l)!);

  /** A group's found count, level and headline problem, from its rows. */
  const roll = (g: SourceGroupCheck) => {
    g.found = g.rows.reduce((n, r) => n + r.found, 0);
    const worst = g.rows.reduce<SourceRow | null>(
      (w, r) => (r.problem && (!w || rank(r.level) > rank(w.level)) ? r : w),
      null,
    );
    if (!worst) return;
    const others = g.rows.filter((r) => r !== worst && r.problem && rank(r.level) >= rank("warn")).length;
    g.problem =
      (g.rows.length > 1 ? `${worst.label}: ${worst.problem}` : worst.problem) + (others ? ` (+${others} more)` : "");
    // A source that still found jobs had a partial problem.
    g.level = worst.level === "error" && g.found > 0 ? "warn" : worst.level;
  };

  await save();
  return {
    /** One feed, site or search of a source; the same label gives the same row. */
    row(group: SourceGroup, label: string): SourceRow {
      const g = groupOf(group);
      const found = g?.rows.find((r) => r.label === label);
      if (found) return found;
      const r: SourceRow = { label, found: 0, problem: "", level: "ok" };
      if (g) {
        g.rows.push(r);
        owner.set(r, g);
      }
      return r;
    },
    read(row: SourceRow, list: Listing[]) {
      row.found += list.length;
      for (const l of list) from.set(l, row);
    },
    /** The row's worst problem is kept: the first one at its level. */
    problem(row: SourceRow, text: string, level: SourceLevel) {
      if (rank(level) > rank(row.level)) Object.assign(row, { problem: text, level });
    },
    drop(at: Listing | SourceGroup, reason: string, n = 1) {
      const g = typeof at === "string" ? groupOf(at) : ofListing(at);
      if (g && n > 0) g.drops[reason] = (g.drops[reason] ?? 0) + n;
    },
    count(l: Listing, stage: "fresh" | "matched" | "queued") {
      const g = ofListing(l);
      if (g) g[stage]++;
    },
    async done(group: SourceGroup) {
      const g = groupOf(group);
      if (!g) return;
      g.done = true;
      roll(g);
      await save();
    },
    async finish() {
      for (const g of check.groups) {
        g.done = true;
        roll(g);
        if (g.problem || g.queued) continue;
        const [reason, n] = Object.entries(g.drops).sort((a, b) => b[1] - a[1])[0] ?? [];
        g.problem = reason ? `Nothing queued: ${reason} (${n} of ${g.found})` : "No jobs found";
        g.level = "info";
      }
      check.doneAt = Date.now();
      await save();
    },
  };
}
