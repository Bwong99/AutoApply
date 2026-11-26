// Which found postings YOLO applies to: the user's queries, places, age and exclusions, decided locally.
import { normalize } from "../../shared/normalize";
import type { Listing, Yolo } from "../../shared/yolo";
import { resolvePlace, within } from "./places";

/** Roles written as one word or two; a query's two-word form is read as the one word, so it matches either. */
const SPLIT = [
  ["backend", "back end"],
  ["frontend", "front end"],
  ["fullstack", "full stack"],
  ["devops", "dev ops"],
] as const;

const SYNONYMS: string[][] = [
  ["intern", "internship", "coop", "co op", "work term", "placement"],
  ["engineer", "engineering", "developer", "development", "swe", "sde"],
  ["software", "swe", "sde", "sw"],
  ["data", "analytics"],
  ["ml", "machine learning", "ai"],
  // One word or two: "Back-End Developer", "Full Stack Engineer", "Dev Ops".
  ...SPLIT.map(([one, two]) => [one, two]),
];
const forms = (w: string) => [w, `${w}s`, `${w}es`, `${w}ing`, `${w}ship`, `${w}ships`, w.replace(/s$/, "")];

/** Words split at punctuation too: "Application/Software Developer Co-op/Intern". */
const words = (s: string) => normalize(s.replace(/[^\p{L}\p{N}+#]+/gu, " "));

/** Every word of the query appears in the title, as itself, a plural/-ing/-ship form, or a synonym. */
export function titleMatches(title: string, query: string): boolean {
  const t = ` ${words(title)} `;
  return SPLIT.reduce((q, [one, two]) => ` ${q} `.replace(` ${two} `, ` ${one} `).trim(), words(query))
    .split(" ")
    .filter(Boolean)
    .every((w) => {
      const group = SYNONYMS.find((g) => g.some((s) => forms(s).includes(w))) ?? [w];
      return [...group, w].some((s) => forms(s).some((f) => t.includes(` ${f} `)));
    });
}

const RE_REMOTE = /\b(remote|anywhere|work from home)\b/i;

/**
 * Places are ";"-separated. A place matches a wanted country, region or city it lies in ("Kelowna" is in British
 * Columbia and Canada), or one it names word for word. Remote places match when remote work is allowed and their
 * area, if any, overlaps a wanted one ("Remote - Canada" for Ontario, not "Remote in USA").
 */
export function locationMatches(location: string, wanted: string[], remoteOk: boolean): boolean {
  if (!wanted.length) return true;
  const areas = wanted.flatMap(resolvePlace);
  return location.split(/[;|]/).some((place) => {
    const remote = RE_REMOTE.test(place);
    const rest = place.replace(/\b(remote|anywhere)\b( in| -|,)?/gi, "").trim();
    const p = rest ? resolvePlace(rest)[0] : undefined;
    if (remote && remoteOk && (!p || areas.some((a) => within(p, a) || within(a, p)))) return true;
    const words = ` ${normalize(place)} `;
    return (p && areas.some((a) => within(p, a))) || wanted.some((w) => words.includes(` ${normalize(w)} `));
  });
}

/** Why a posting is not for this user, or null when it is. */
export function rejectReason(l: Listing, y: Yolo, now = Date.now()): string | null {
  if (l.easyApply) return "Easy Apply (not supported yet)";
  // Jobright recommends by the roles in the user's Jobright preferences, not by these queries.
  if (l.source !== "jobright" && !y.queries.some((q) => titleMatches(l.title, q)))
    return "Title doesn't match a search";
  const t = ` ${words(l.title)} `;
  const bad = y.excludeTitleWords.find((w) => normalize(w) && t.includes(` ${normalize(w)} `));
  if (bad) return `Title has "${bad}"`;
  const company = normalize(l.company);
  if (y.skipCompanies.some((c) => normalize(c) === company)) return "Company skipped";
  // A career site the user pasted is already their own search: its pages rarely state where each job is.
  if (!(l.source === "careers" && !l.location) && !locationMatches(l.location, y.locations, y.remoteOk))
    return "Location";
  if (l.postedAt && now - l.postedAt > y.postedWithinDays * 86400e3) return "Too old";
  return null;
}
