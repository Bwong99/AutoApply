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

export function localMatch(answer: string, options: string[]): number | null {
  const a = normalize(answer);
  if (!a) return null;
  const exact = options.map((o, i) => (normalize(o) === a ? i : -1)).filter((i) => i >= 0);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  // "No" must never resolve to Norway (ISO code NO).
  if (a !== "yes" && a !== "no") {
    const c = unique(options, canonicalCountry, canonicalCountry(answer));
    if (c !== null) return c;
    const r = unique(options, canonicalRegion, canonicalRegion(answer));
    if (r !== null) return r;
  }
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
