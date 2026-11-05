import { defang } from "./injection";
import { todayIso } from "./time";
import type { Decision, FieldDescriptor, JobContext, Profile } from "./types";

/** Saved answers to screening questions must be reconsidered against this job and the current profile. */
export function isScreeningQuestion(f: Pick<FieldDescriptor, "label" | "hint">): boolean {
  const text = `${defang(f.label)} ${defang(f.hint ?? "")}`;
  if (
    /\b(authori[sz]\w*|sponsor\w*|visa|citizen\w*|immigration|clearance|criminal|age|background check|drug test|consent|gender|race|ethnicity|veteran|disability)\b/i.test(
      text,
    )
  )
    return false;
  return /\b(experience|proficien\w*|qualif\w*|requirements?|availab\w*|willing\w*|relocat\w*|eligible|conflicts?|non-compete|shifts?|overtime|licen[cs]e|vehicle|travel|weekends?|hours|on-?site|hybrid|skills?|familiar|comfortable|able to)\b|\bhow many (years?|months?)\b.*\b(used|using|worked|working)\b|\bhave you\b.*\bused\b/i.test(
    text,
  );
}

export const SCREENING_SOURCE = "screening";

const WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const NUM = String.raw`(?:\d+(?:\.\d+)?|${Object.keys(WORDS).join("|")})`;
const UNIT = String.raw`(years?|months?)`;
const valueOf = (s: string) => WORDS[s.toLowerCase()] ?? Number(s);
const inMonths = (n: number, unit: string) => n * (/year/i.test(unit) ? 12 : 1);

function quantity(label: string): "experience" | "availability" | null {
  if (/^\s*(?:describe|explain|tell|why|please (?:describe|explain|tell))\b/i.test(label)) return null;
  if (!/\b(years?|months?)\b/i.test(label)) return null;
  if (/\bexperience\b|\bhow many (years?|months?)\b.*\b(used|using|worked|working)\b/i.test(label)) return "experience";
  return /\b(availab\w*|commit\w*|term lengths?|internships?)\b/i.test(label) ? "availability" : null;
}

/** Only stated applicant requirements count; instructions addressed to AI have already been removed. */
function minimums(text: string): number[] {
  const patterns = [
    String.raw`\b(?:at least|minimum(?: of)?|no (?:less|fewer) than)\s+(${NUM})\s*[- ]?${UNIT}\b`,
    String.raw`\b(${NUM})\s*\+\s*${UNIT}\b`,
    String.raw`\b(?:requires?|needs?|prefers?|recommends?|minimum)\b[^.!?;\n\d]{0,45}?\b(${NUM})\s*[- ]?${UNIT}\b`,
    String.raw`\b(${NUM})\s*[- ]?${UNIT}\b[^.!?;\n]{0,40}?\b(?:required|preferred|recommended|minimum)\b`,
  ];
  return patterns.flatMap((p) => [...text.matchAll(new RegExp(p, "gi"))].map((m) => inMonths(valueOf(m[1]), m[2])));
}

/** Ambiguous requirements still belong with the mapper, never an inferred experience cap. */
export function hasExperienceMinimum(text: string): boolean {
  const clean = defang(text);
  return /\bexperience\b/i.test(clean) && minimums(clean).length > 0;
}

/** A posting's requirement must name the subject of the question, not a different skill. */
function jobMinimums(label: string, job: JobContext | null, kind: "experience" | "availability"): number[] {
  if (!job) return [];
  const sentences = defang(job.text || job.header || "").split(/[!?;\n]|\.(?:\s|$)/);
  if (kind === "availability")
    return sentences.filter((s) => /\b(internships?|terms?|duration|availab\w*)\b/i.test(s)).flatMap(minimums);
  const subject = /\b(?:experience(?: do you have)? (?:with|in|using)|(?:used|using))\s+([^?;\n]+)/i
    .exec(label)?.[1]
    ?.split(/[.,]|\b(?:the|this|our|role|position|at least|minimum)\b/i)[0]
    .trim()
    .toLowerCase();
  if (!subject) return [];
  const values = sentences
    .filter((s) => s.toLowerCase().includes(subject) && /\bexperience\b/i.test(s))
    .flatMap(minimums);
  // Several skills or tiers in one sentence need semantic matching to the right requirement.
  return new Set(values).size > 1 ? [] : values;
}

interface Bounds {
  low: number;
  high: number;
}

/** Conservative option bounds: a bracket starting below the minimum is not a passing answer. */
function bounds(option: string, unit: string): Bounds | null {
  const s = option.trim();
  if (
    !new RegExp(
      `^(?:${NUM}\\b|[<>]|less than\\b|under\\b|fewer than\\b|at least\\b|more than\\b|over\\b|above\\b|between\\b)`,
      "i",
    ).test(s)
  )
    return null;
  const ns = [...s.matchAll(new RegExp(`\\b${NUM}\\b`, "gi"))].map((m) => valueOf(m[0]));
  if (!ns.length || ns.length > 2) return null;
  const scale = /\byears?\b/i.test(s) ? "year" : /\bmonths?\b/i.test(s) ? "month" : unit;
  const n = ns.map((v) => inMonths(v, scale));
  if (/^(?:less than|under|fewer than|<)/i.test(s)) return { low: 0, high: n[0] - 0.001 };
  if (n.length === 2 && /[-–—,]|\b(to|and)\b/i.test(s)) return { low: n[0], high: n[1] };
  if (n.length !== 1) return null;
  return { low: n[0], high: /\+|\b(?:more|over|above|at least)\b/i.test(s) ? Infinity : n[0] };
}

/**
 * Resolve clear numeric screening thresholds locally, in both modes. Employment history and prose are not
 * dedicated experience-duration fields. Availability lengths and dates are explicit constraints, however.
 * Ambiguous questions stay with the existing mapper; no extra request or background work is needed here.
 */
export function screeningDecision(
  f: FieldDescriptor,
  profile: Profile,
  job: JobContext | null = null,
): Decision | null {
  const label = defang(f.label);
  const kind = quantity(label);
  if (!kind || !isScreeningQuestion(f)) return null;
  const requirements = minimums(`${label} ${defang(f.hint ?? "")}`);
  if (!requirements.length) requirements.push(...jobMinimums(label, job, kind));
  if (!requirements.length) return null;
  const minimum = Math.max(...requirements);
  const unit = /\bhow many\s+(months?|years?)\b/i.exec(label)?.[1] ?? (/\byears?\b/i.test(label) ? "year" : "month");
  let target = minimum;
  let cap = Infinity;
  let allowed: number[] | null = null;
  const sources: string[] = [];
  if (kind === "availability") {
    const lengths = profile.coop.acceptableTermLengths.map((s) => s.trim()).filter(Boolean);
    if (lengths.length) {
      sources.push("coop.acceptableTermLengths");
      if (!lengths.some((s) => /^(all|any)$/i.test(s))) {
        allowed = lengths.flatMap((s) => {
          const m = new RegExp(`^(${NUM})\\s*[- ]?${UNIT}$`, "i").exec(s);
          return m ? [inMonths(valueOf(m[1]), m[2])] : [];
        });
        if (allowed.length !== lengths.length) return null;
      }
    }
    const { earliestStartDate, availableUntil: to } = profile.preferences;
    if (to) {
      const today = todayIso();
      const from = earliestStartDate && earliestStartDate > today ? earliestStartDate : today;
      const [y1, m1, d1 = 1] = from.split("-").map(Number);
      const [y2, m2, d2 = 1] = to.split("-").map(Number);
      cap = Math.max(0, (y2 - y1) * 12 + m2 - m1 - (d2 < d1 ? 1 : 0));
      if (!Number.isFinite(cap)) return screeningFlag(f.id, "Profile availability dates are invalid");
      sources.push("preferences.earliestStartDate", "preferences.availableUntil");
    }
    if (allowed) {
      const fit = allowed.filter((n) => n <= cap);
      if (!fit.length) return screeningFlag(f.id, "Profile availability constraints conflict");
      target = Math.min(...fit.filter((n) => n >= minimum));
      if (!Number.isFinite(target)) target = Math.max(...fit);
    } else target = Math.min(minimum, cap);
  }
  const meets = target >= minimum;
  const base = {
    fieldId: f.id,
    action: "fill" as const,
    confidence: "medium" as const,
    sources: sources.length ? sources : [SCREENING_SOURCE],
  };
  // Negated questions need semantic mapping, rather than assuming Yes means eligible.
  const negated = /\bnot\b|n['’]t\b|\b(?:less|fewer) than\b/i.test(label.replace(/\bno (?:less|fewer) than\b/gi, ""));
  if (f.options?.length) {
    const options = f.options.map(defang);
    const yes = options.findIndex((s, i) => s === f.options![i] && /^yes\W*$/i.test(s.trim()));
    const no = options.findIndex((s, i) => s === f.options![i] && /^no\W*$/i.test(s.trim()));
    if (yes >= 0 && no >= 0) {
      if (negated) return null;
      const i = meets ? yes : no;
      return { ...base, optionIndexes: [i], intendedAnswer: f.options[i] };
    }
    // Qualified yes/no answers and proficiency labels need the semantic mapper.
    if (!options.some((s) => bounds(s, unit))) return null;
    const fits = options
      .flatMap((s, i) => {
        // Never select an option whose original text contained a trap.
        if (s !== f.options![i]) return [];
        const b = bounds(s, unit);
        if (!b || (meets && b.low < minimum) || b.low > cap) return [];
        if (allowed && !allowed.some((n) => n >= b.low && n <= b.high && n <= cap)) return [];
        return b.high >= target ? [{ i, low: b.low }] : [];
      })
      .sort((a, b) => a.low - b.low);
    if (!fits.length) return screeningFlag(f.id, "No option meets screening and profile constraints");
    const picks =
      kind === "availability" && (f.multiple || f.kind === "multiselect" || f.kind === "checkbox_group")
        ? fits.map((v) => v.i)
        : [fits[0].i];
    return { ...base, optionIndexes: picks, intendedAnswer: picks.map((i) => f.options![i]).join(", ") };
  }
  if (negated) return null;
  if (f.kind === "checkbox") return { ...base, checked: meets };
  const text =
    /^(?:do|are|can|will|would|have)\b/i.test(label.trim()) && label.includes("?")
      ? meets
        ? "Yes"
        : "No"
      : String(/year/i.test(unit) ? target / 12 : target);
  if (f.maxLength && text.length > f.maxLength) return screeningFlag(f.id, "Screening answer exceeds field limit");
  if (["dropdown", "select", "typeahead"].includes(f.kind)) return { ...base, intendedAnswer: text, searchQuery: text };
  if (!["text", "number", "textarea", "contenteditable"].includes(f.kind)) return null;
  return { ...base, text };
}

function screeningFlag(fieldId: string, note: string): Decision {
  return { fieldId, action: "flag", confidence: "low", note, sources: [SCREENING_SOURCE] };
}
