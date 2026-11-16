// §13.3 option matching without AI. Only safe matches; anything else returns null and goes to the AI.
import { canonicalCountry, canonicalRegion } from "../../shared/constants";
import { normalize } from "../../shared/normalize";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number | string) => String(n).padStart(2, "0");

/** Canonical number/date form, or null when `s` is not purely numeric or a date. */
export function dateish(s: string): string | null {
  const t = s.trim().toLowerCase().replace(/,/g, "");
  let m: RegExpExecArray | null;
  if (/^\d+(\.\d+)?$/.test(t)) return `n:${parseFloat(t)}`;
  if ((m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(t))) return `d:${m[1]}-${m[2]}${m[3] ? "-" + m[3] : ""}`;
  if ((m = /^(\d{1,2})\/(\d{4})$/.exec(t))) return `d:${m[2]}-${pad(m[1])}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) return `d:${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  if ((m = /^([a-z]{3})[a-z]*\.? (\d{4})$/.exec(t)) && MONTHS.includes(m[1]))
    return `d:${m[2]}-${pad(MONTHS.indexOf(m[1]) + 1)}`;
  return null;
}

function unique(options: string[], key: (s: string) => string | null, target: string | null): number | null {
  if (!target) return null;
  const hits = options.map((o, i) => (key(o) === target ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

/** A name an option qualifies in parentheses: "Mandarin" in "Chinese (Mandarin)". */
const qualified = (o: string) => normalize(/\(([^()]+)\)\s*$/.exec(o)?.[1] ?? "") || null;

/** Language proficiency, highest first; longer wordings before the ones they contain ("lower intermediate"). */
const PROFICIENCY: RegExp[] = [
  /\b(native|mother tongue|first language|bilingual)\b/,
  /\b(fluent|fluency)\b/,
  /\b(advanced|full professional|expert)\b/,
  /\bupper intermediate\b/,
  /\b(professional working|proficient)\b/,
  /\blower intermediate\b/,
  /\b(intermediate|conversational)\b/,
  /\b(limited working|elementary)\b/,
  /\b(basic|beginner|novice)\b/,
];
const proficiency = (s: string) => {
  const t = normalize(s);
  return t.split(" ").length > 5 ? -1 : PROFICIENCY.findIndex((re) => re.test(t));
};

/**
 * A level the options don't word: the highest they offer at or below it. "Native" on Teck's Basic … Fluent scale is
 * Fluent. Only on a scale (two or more levels listed); an answer no level names matches nothing.
 */
function proficiencyMatch(answer: string, options: string[]): number | null {
  const want = proficiency(answer);
  const levels = options.map(proficiency);
  if (want < 0 || levels.filter((l) => l >= 0).length < 2) return null;
  let best: number | null = null;
  for (const [i, l] of levels.entries()) if (l >= want && (best === null || l < levels[best])) best = i;
  return best !== null && levels.filter((l) => l === levels[best!]).length === 1 ? best : null;
}

export function localMatch(answer: string, options: string[]): number | null {
  const a = normalize(answer);
  if (!a) return null;
  const exact = options.map((o, i) => (normalize(o) === a ? i : -1)).filter((i) => i >= 0);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  // Worded with a leading "The": Intel's Workday lists "The University of British Columbia" (beside "University of
  // Northern British Columbia"), and the AI's pick, seconds later, never took.
  const bare = (s: string) => normalize(s).replace(/^the /, "");
  const t = unique(options, bare, bare(answer));
  if (t !== null) return t;
  // The one option qualifying the answer: "Chinese (Mandarin)" for Mandarin, on lists naming no plain "Mandarin".
  const q = unique(options, qualified, a);
  if (q !== null) return q;
  const p = proficiencyMatch(answer, options);
  if (p !== null) return p;
  // A Yes or No a list words out ("No, I was not referred"): the one option starting so. Rules answer an unread list
  // with a bare Yes/No; the AI matching it could pick the other.
  // Never a country or region: "No" is Norway's ISO code.
  if (a === "yes" || a === "no") return unique(options, (o) => normalize(o).split(" ")[0], a);
  const c = unique(options, canonicalCountry, canonicalCountry(answer));
  if (c !== null) return c;
  const r = unique(options, canonicalRegion, canonicalRegion(answer));
  if (r !== null) return r;
  const d = unique(options, dateish, dateish(answer));
  if (d !== null) return d;
  // A number on a list of ranges: 41600 is "$40,001 - $50,000" (Oracle's salary expectations).
  const n = /^\$?\s*(\d[\d,]*(?:\.\d+)?)$/.exec(answer.trim());
  if (!n) return null;
  const v = parseFloat(n[1].replace(/,/g, ""));
  const within = (o: string) => {
    const m = /^\D{0,4}?(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|to)\s*\D{0,4}?(\d[\d,]*(?:\.\d+)?)\D{0,20}$/i.exec(o.trim());
    const [lo, hi] = m ? [m[1], m[2]].map((x) => parseFloat(x.replace(/,/g, ""))) : [NaN, NaN];
    return lo <= v && v <= hi;
  };
  const hits = options.map((o, i) => (within(o) ? i : -1)).filter((i) => i >= 0);
  return hits.length === 1 ? hits[0] : null;
}

/** Multi-value answers are stored joined with " | ". All parts must match. */
export function localMatchAll(answer: string, options: string[]): number[] | null {
  const parts = answer.split(" | ").filter(Boolean);
  const idx = parts.map((p) => localMatch(p, options));
  return idx.length && idx.every((i) => i !== null) ? (idx as number[]) : null;
}
