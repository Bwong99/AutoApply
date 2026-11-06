// §10.8.1 main batched mapping call.
import type {
  Decision,
  DocumentMeta,
  FieldDescriptor,
  FieldKind,
  JobContext,
  Pay,
  Profile,
  Settings,
} from "../../shared/types";
import {
  canonicalCountry,
  HUB_REGIONS,
  HUBS,
  isAiReview,
  optInAnswer,
  RE_CONSENT,
  RE_ENTRY_SECTION,
  RE_INTERVIEW_RECORDING,
  RE_JOB_BOARD,
  regionCode,
  regionCountry,
} from "../../shared/constants";
import { plainDashes, RE_AI_TELL, trapLabel } from "../../shared/injection";
import { hasExperienceMinimum, isScreeningQuestion, screeningDecision, SCREENING_SOURCE } from "../../shared/screening";
import { normalize } from "../../shared/normalize";
import { emptyProfile } from "../../shared/profileSchema";
import { todayIso } from "../../shared/time";
import type { Gemini } from "../gemini/client";
import { BadOutputError, BlockedError } from "../gemini/errors";
import { AUDIT_PROMPT, BEST_GUESS_PROMPT, MAP_FIELDS_PROMPT } from "../gemini/prompts";
import { AUDIT_SCHEMA, AuditZ, MAPPING_SCHEMA, MappingZ, type RawDecision } from "../gemini/schemas";

export interface ServiceCtx {
  /** Gemini, or Claude bound to the task's model (serviceCtx in background/index.ts). */
  ai: Pick<Gemini, "call">;
  settings: Settings;
  model: string;
  fallback: string | null;
  signal?: AbortSignal;
}

/** Recursively drops "", [], {} and null. */
export function compactProfile<T>(v: T): T | undefined {
  if (v === null || v === "" || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const a = v.map(compactProfile).filter((x) => x !== undefined);
    return (a.length ? a : undefined) as T | undefined;
  }
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const c = compactProfile(val);
      if (c !== undefined) o[k] = c;
    }
    return (Object.keys(o).length ? o : undefined) as T | undefined;
  }
  return v;
}

const MULTI_KINDS = new Set<FieldKind>(["multiselect", "checkbox_group"]);
const CHOICE_KINDS = new Set<FieldKind>(["select", "multiselect", "radio_group", "checkbox_group", "dropdown"]);

const isMulti = (f: FieldDescriptor) => MULTI_KINDS.has(f.kind) || (f.kind === "dropdown" && !!f.multiple);

function suggestionOf(d: RawDecision, f: FieldDescriptor): string | undefined {
  if (d.text) return d.text;
  if (d.optionIndexes?.length && f.options)
    return d.optionIndexes
      .map((i) => f.options![i])
      .filter(Boolean)
      .join(", ");
  if (d.intendedAnswer) return d.intendedAnswer;
  if (d.checked !== undefined) return d.checked ? "checked" : "unchecked";
  return undefined;
}

const flag = (fieldId: string, note: string, suggestion?: string): Decision => ({
  fieldId,
  action: "flag",
  confidence: "low",
  note,
  ...(suggestion ? { suggestion } : {}),
});

const NOT_IN_PROFILE = "Not in your profile";
const SINGLE_CHOICE = new Set<FieldKind>(["select", "radio_group", "dropdown"]);
const NOT_APPLICABLE = "N/A";
/** The source YOLO's best-guess answers cite: made up for the application, logged for the user to review. */
export const GUESS = "guess";

// A sponsorship question, not "active funding (e.g., grants, sponsorships)?" (Zoox).
const RE_SPONSOR_Q = /\b(requir|need)\w*\b[^?]*\bsponsor|\bsponsor\w*\b[^?]*\b(visa|immigration|employment|work)\b/i;
// Twitch: "would you be legally eligible to begin employment immediately?"; Airwallex: "the right to live and work".
const RE_ELIGIBLE = /\beligible to (work|begin|start)\b|\bright to (live and )?work\b/i;
const RE_WORK_AUTH = /\b(authori[sz]|visa\b|work permit)/i;
const isWorkAuth = (label: string) => RE_WORK_AUTH.test(label) || RE_ELIGIBLE.test(label) || RE_SPONSOR_Q.test(label);
// GitLab: "require sponsorship for a visa to remain in your current location?".
const RE_RESIDENCE = /\b(reside|live|living|currently (located|based)|residence|current (location|country))\b/i;

/** Sources an answer may rest on: the candidate's profile sections, résumé and learned answers. */
const CANDIDATE_DATA = new Set([...Object.keys(emptyProfile()).filter((k) => k !== "resumeText"), "resume"]);
const citesCandidate = (source: string) => CANDIDATE_DATA.has(source.replace(/^profile\./, "").split(/[.[]/)[0]);

/** A signature date: the answer holds today's year (or its last two digits: SoFi's "MM/DD/YY"), month and day. */
function isToday(text = ""): boolean {
  const nums = (text.match(/\d+/g) ?? []).map(Number);
  const [y, m, d] = todayIso().split("-").map(Number);
  return (nums.includes(y) || nums.includes(y % 100)) && nums.includes(m) && nums.includes(d);
}

/**
 * The model answers questions the data never covers ("offer deadlines?" → "No") citing nothing, or only the job
 * posting. Those are guesses: leave them to the user. Consents, uploads and signature dates need no profile source.
 */
function guessed(d: Decision, f: FieldDescriptor): boolean {
  if (
    d.action !== "fill" ||
    d.sources?.some(citesCandidate) ||
    d.sources?.includes(GUESS) ||
    (d.sources?.includes(SCREENING_SOURCE) && isScreeningQuestion(f)) ||
    isToday(d.text) ||
    d.text === NOT_APPLICABLE
  )
    return false;
  // An optional box left unticked claims nothing (Spotify's "Custom" pronouns).
  if (f.kind === "checkbox" && d.checked === false && !f.required) return false;
  return !needsNoSource(f);
}

/** Uploads and acknowledgements: a lone option ("I will read the agreement below"), a policy or agreement, a consent. */
const needsNoSource = (f: FieldDescriptor) =>
  f.kind === "file" ||
  f.options?.length === 1 ||
  /\b(polic(y|ies)|agreement)\b/i.test(f.label) ||
  RE_CONSENT.test(`${f.label} ${f.hint ?? ""} ${(f.options ?? []).join(" ")}`);

/**
 * A work authorization answer for a known country, or a yes/no one: the mapping prompt derives it from the job's
 * country, which the audit won't weigh ("authorized in the country where you are applying?" → "No" for a US job,
 * Waymo's "I require … sponsorship" for Warsaw got flagged).
 */
const workAuthAnswer = (f: FieldDescriptor & { workCountry?: string }, answer: string) =>
  isWorkAuth(f.label) && (!!f.workCountry || /^(yes|no)\b/i.test(answer));

const RE_HEARD = /\b(hear|heard|learn(ed)?) (about|of)\b/i;
/** "Other" for how they heard: no option matches the profile's source; the audit flagged it (Match Group, Vercel). */
const heardOther = (f: FieldDescriptor, answer: string) => RE_HEARD.test(f.label) && /^other\b/i.test(answer);

/**
 * How they heard, when one option is the profile's source: itself, or the company's site for "Company website"
 * ("Character Careers Page", "Riot Games Website"). The model picked "Other" over "Character Careers Page". With
 * neither a site nor "Other", the company's own channel ("Supabase platform / Newsletter"), else blank if optional:
 * the model picked Supabase's "Other online job boards".
 */
function heardDecision(f: FieldDescriptor, heard: string, company = ""): Decision | null {
  if (!f.options || !heard || !RE_HEARD.test(f.label)) return null;
  const site = /\b(web ?site|careers? (page|site))\b/i.test(heard);
  const siteish = (o: string) => /\b(web ?site|careers? (page|site|portal))\b|\w\.(com|io|ai|co)\b/i.test(o);
  let hits = f.options.flatMap((o, i) =>
    normalize(o) === normalize(heard) || (site && siteish(o) && !/^other\b|\bjob ?(board|site)|social|blog/i.test(o))
      ? [i]
      : [],
  );
  // No site among them (Flexport: campus, career platforms, blog, …): "Other" it is. Not beside "Flexport Careers".
  const maybeSite = (o: string) => siteish(o) || /\b(company|official|direct(ly)?)\b|\bcareers$/i.test(o);
  if (site && !hits.length && !f.options.some(maybeSite)) {
    hits = f.options.flatMap((o, i) => (/^other\s*(\([^)]*\))?\W*$/i.test(o) ? [i] : []));
    const name = normalize(company).split(" ")[0];
    if (!hits.length && name.length > 2)
      hits = f.options.flatMap((o, i) =>
        normalize(o).split(" ").includes(name) && !/\b(referr\w*|employee|event)\b/i.test(o) ? [i] : [],
      );
    if (!hits.length && !f.required)
      return { fieldId: f.id, action: "skip", confidence: "high", sources: ["referral"] };
  }
  // A job board under a category of a custom list (Workday's "Job Board" › "LinkedIn"): searched for itself, else
  // chosen among the options as they read. The model picked categories, which open their own list instead.
  const board = RE_JOB_BOARD.test(heard);
  if (
    !hits.length &&
    board &&
    f.kind === "dropdown" &&
    f.options.some((o) => /\bjob ?(boards?|sites?)\b|\bsocial\b/i.test(o))
  )
    return {
      fieldId: f.id,
      action: "fill",
      intendedAnswer: heard,
      searchQuery: heard,
      confidence: "high",
      sources: ["referral"],
    };
  if (hits.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: hits,
    intendedAnswer: f.options[hits[0]],
    confidence: "high",
    sources: ["referral"],
  };
}

/** A country the text names. Short codes only as written ("US", "U.S."), never the pronoun "us". */
function countryIn(text: string): string | undefined {
  if (/\bU\.?S\.?(A\.?)?(?![a-z])|\bUnited States\b/.test(text)) return "united states";
  if (/\bUK\b/.test(text)) return "united kingdom";
  const words = normalize(text).split(" ");
  for (let n = 3; n >= 1; n--)
    for (let i = 0; i + n <= words.length; i++) {
      const s = words.slice(i, i + n).join(" ");
      const c = s.length > 3 ? canonicalCountry(s) : null;
      if (c) return c;
    }
}

const US = "united states";

/** Every country the text names, longest name first so "North Korea" isn't also read as "Korea". */
function countriesIn(text: string): string[] {
  const out = new Set<string>();
  if (/\bU\.?S\.?(A\.?)?(?![a-z])|\bUnited States\b/.test(text)) out.add(US);
  if (/\bUK\b/.test(text)) out.add("united kingdom");
  const words = normalize(text).split(" ");
  for (let i = 0; i < words.length; i++)
    for (let n = 3; n >= 1; n--) {
      const s = words.slice(i, i + n).join(" ");
      const c = s.length > 3 ? canonicalCountry(s) : null;
      if (c) {
        out.add(c);
        i += n - 1;
        break;
      }
    }
  return [...out];
}

/**
 * "Which office are you applying to?": the one option the job's location names. Sentry's "Vienna" for a Vienna job
 * cited only the job, so it was dropped as a guess. With several, the first for a candidate open to anywhere (Shield
 * AI's Dallas / San Diego / Boston).
 */
function appliedOfficeDecision(
  f: FieldDescriptor,
  location: string | undefined,
  prefs: Profile["preferences"],
): Decision | null {
  if (!f.options || isMulti(f) || !location) return null;
  if (
    !/\b(which|what) (office|location)s? are you applying\b|\bapplying (to|for) which (office|location)\b/i.test(
      f.label,
    )
  )
    return null;
  const where = ` ${normalize(location)} `;
  const hits = f.options.flatMap((o, i) => (normalize(o) && where.includes(` ${normalize(o)} `) ? [i] : []));
  const anywhere = /^(any(where)?)?$/i.test(prefs.relocationNotes.trim()) && prefs.preferredLocations.includes("Any");
  if (!hits.length || (hits.length > 1 && !(anywhere && prefs.willingToRelocate === "yes"))) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: hits.slice(0, 1),
    intendedAnswer: f.options[hits[0]],
    confidence: "high",
    sources: ["job.location"],
  };
}

/**
 * "Are you applying to a role in:" a list of countries: the job's, else "Other". Waymo's Warsaw internship got
 * "Other", and a blank on a later run; it asks about the role, not the candidate.
 */
function roleCountryDecision(f: FieldDescriptor, job: string | undefined): Decision | null {
  if (!f.options || isMulti(f) || !job || !/\bapplying (to|for) (an? |this )?(role|position|job)s? in\b/i.test(f.label))
    return null;
  const named = f.options.findIndex((o) => canonicalCountry(o.trim()) === job);
  const i = named >= 0 ? named : f.options.findIndex((o) => /^other\b/i.test(o.trim()));
  if (i < 0) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["job.location"],
  };
}

/**
 * The one country a job's location names, if just one. Each part narrows the candidates, a state or province first:
 * "San Francisco, CA" → united states, "Toronto, ON, CA" → canada, "Atlanta, Georgia" → united states.
 * With neither, a tech hub's name alone ("Hybrid - San Francisco", Vercel).
 * shortcut: a lone code that is also a state ("Bengaluru, IN") reads as the US state, and hubs are a short list;
 * a full city list would fix both.
 */
export function jobCountry(location: string): string | undefined {
  const countries = new Set(
    location.split(";").map((place) => {
      let pick: string[] = [];
      const parts = place.split(/[,()/]| - /);
      for (const p of parts) {
        const options = [regionCountry(p), canonicalCountry(p)].filter((c): c is string => !!c);
        const both = pick.filter((c) => options.includes(c));
        pick = pick.length ? (both.length ? both : pick) : options;
      }
      const hub = parts.map((p) => HUBS[normalize(p)]).find(Boolean);
      return pick[0] ?? (hub ? (canonicalCountry(hub) ?? hub) : null);
    }),
  );
  return countries.size === 1 ? ([...countries][0] ?? undefined) : undefined;
}

/**
 * The country a work authorization question is about: the one it names, the candidate's own for "where you live",
 * else the job's. The model mixed these up ("authorized in the country you reside?" → the job's country). With no
 * job country, a U.S. visa it names: Clever's "require sponsorship for employment visa status (e.g. H-1B visa
 * status)?" got "No" for a U.S. job whose page gave no parseable location.
 */
export function workCountry(label: string, home: string, job: string | undefined): string | undefined {
  if (!isWorkAuth(label)) return undefined;
  const own = canonicalCountry(home) ?? normalize(home);
  // National Bank's "authorized to work in Canada if the position is located in Canada OR … in the USA if the position
  // is located in the USA?": the job's country of those named, else the candidate's (the first named was "the USA").
  const named = /\bif (the |this )?(position|role|job)\b/i.test(label) ? countriesIn(label) : [];
  const pick = named.length > 1 ? [job, own].find((c) => c && named.includes(c)) : undefined;
  return (
    pick ??
    countryIn(label) ??
    ((RE_RESIDENCE.test(label) ? own : job) || undefined) ??
    (/\bH-?1-?B\b/.test(label) ? US : undefined)
  );
}

const SITES: [RegExp, string[]][] = [
  ...["github", "gitlab", "bitbucket", "linkedin", "replit", "kaggle", "leetcode", "devpost", "huggingface"].map(
    (s): [RegExp, string[]] => [new RegExp(`\\b${s}\\b`, "i"), [s]],
  ),
  // Linear labels its Twitter field just "X".
  [/\b(twitter|x\.com)\b|^x( profile)?( url)?$/i, ["twitter", "x.com"]],
  [/\bhugging face\b/i, ["huggingface"]],
];

/**
 * A link for a field that names one site, pointing elsewhere: Replit's "Replit Profile URL" got the GitHub URL and
 * the audit let it through. Fields that also take any site ("LinkedIn, personal website or blog") are left alone.
 */
export function wrongSiteLink(label: string, answer: string, sources: string[] = []): boolean {
  if (/website|portfolio|blog|personal|other|\bor\b/i.test(label)) return false;
  const named = SITES.filter(([re]) => re.test(label));
  const onSite = (x: string) => named.some(([, hosts]) => hosts.some((h) => x.includes(h)));
  const host = answer.match(/^https?:\/\/([^/\s]+)/i)?.[1]?.toLowerCase();
  // A username taken from another site's link: GitLab's "What is your GitLab username?" got the GitHub handle.
  const cited = sources.flatMap((s) => s.match(/links\.(\w+)/)?.[1] ?? []);
  return named.length > 0 && (host ? !onSite(host) : cited.length > 0 && !cited.some(onSite));
}

const entryFor = (country: string, entries: Profile["workAuthorization"]["entries"]) =>
  entries.find((x) => (canonicalCountry(x.country) ?? normalize(x.country)) === country);

/**
 * The explanation a follow-up asks for after a work authorization status answered "Other" here, from the profile:
 * Etched's "If you answered other:" was skipped, leaving "Other (please explain below)" unexplained.
 */
function otherStatusDecision(
  f: FieldDescriptor,
  fields: FieldDescriptor[],
  local: Map<string, Decision>,
  countries: Map<string, string | undefined>,
  entries: Profile["workAuthorization"]["entries"],
): Decision | null {
  const prev = fields[fields.indexOf(f) - 1];
  const d = prev && local.get(prev.id);
  if ((f.kind !== "text" && f.kind !== "textarea") || !f.hint?.startsWith("Follow-up to the previous question"))
    return null;
  if (d?.action !== "fill" || !/^other\b/i.test(suggestionOf(d, prev) ?? "")) return null;
  if (!/\b(authori[sz]ation|visa|immigration|citizenship)\b/i.test(prev.label)) return null;
  const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  const held = entries.filter((e) => e.country && e.authorized === "yes");
  const parts = held.map((e) => (e.status ? `${e.status} of ${e.country}.` : `Authorized to work in ${e.country}.`));
  const there = countries.get(prev.id);
  const e = there && entryFor(there, entries);
  if (there && (!e || e.authorized !== "yes" || e.requiresSponsorshipNow === "yes"))
    parts.push(`I would need employer sponsorship to work in ${/^united /.test(there) ? "the " : ""}${title(there)}.`);
  if (!parts.length) return null;
  return { fieldId: f.id, action: "fill", text: parts.join(" "), confidence: "high", sources: ["workAuthorization"] };
}

// Not after an abbreviation: Notion's "(e.g. H1B, OPT)?" would split off.
const lastSentence = (s: string) => s.split(/(?<=[a-z]{2}[.!])\s+(?=[A-Z])/).pop()!;

/**
 * "What is your current immigration status / basis of your current work authorization?" in a country the profile
 * isn't authorized in: no current authorization. Akuna's got "None", which the list's "N/A (I do not require work
 * authorization)" would have matched. Without a job location, the country of the question it follows up.
 */
function currentStatusDecision(
  f: FieldDescriptor,
  where: string | undefined,
  entries: Profile["workAuthorization"]["entries"],
): Decision | null {
  const q = lastSentence(f.label);
  const country = where ?? countryIn(f.hint ?? "");
  // Cirrus Logic's "If you answered no …, what type of visa are you on": the model picked "F1 or OPT/CPT" for a
  // Canadian with no US visa.
  const visa = /\b(type of|which|what) visa\b[^?]*\b(are you (currently )?on|do you (currently )?(hold|have))\b/i.test(
    q,
  );
  if (
    !country ||
    isMulti(f) ||
    !(
      visa ||
      /\bcurrent (immigration|visa|work authori[sz]ation) status\b|\bbasis of your current work authori[sz]ation\b/i.test(
        q,
      )
    )
  )
    return null;
  if (entryFor(country, entries)?.authorized === "yes" || !(f.options || f.kind === "dropdown")) return null;
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["workAuthorization"] };
  if (!f.options?.length) return { ...base, intendedAnswer: "No current work authorization" };
  let i = f.options.findIndex((o) => /\bno (current )?(work )?(authori[sz]ation|status|visa)\b/i.test(o));
  if (i < 0 && visa) i = f.options.findIndex((o) => /^(none|other)\b/i.test(o.trim()) && !/\bcitizen\b/i.test(o));
  return i < 0 ? null : { ...base, optionIndexes: [i], intendedAnswer: f.options[i] };
}

/**
 * An AI answer of "None"/"No" to a sponsorship question for a country where the profile needs sponsorship (no entry,
 * or one requiring it). Notion's "will you require any of the below sponsorship? J1 / F1 / None / Other" got "None".
 */
export function deniesNeededSponsorship(
  f: FieldDescriptor,
  answer: string,
  country: string | undefined,
  entries: Profile["workAuthorization"]["entries"],
): boolean {
  // Only "will you require/need …": "If you are currently on a visa sponsorship, what type?" → "N/A" is right (Fastly).
  // Not "authorized … without requiring sponsorship?", where "No" is the answer that admits needing it.
  // The question itself, not a lead-in ("If you answered Yes above to requiring visa sponsorship, … What is your
  // current immigration status?", Akuna).
  const q = lastSentence(f.label);
  const asks =
    /\b(requir|need)\w*\b[^?]*\bsponsor/i.test(q) &&
    !/\bcurrently (on|hold)/i.test(q) &&
    !/\bwithout\b[^?]*\bsponsor/i.test(q);
  if (!country || !asks || !/^(none|no|n\/?a|not applicable)\b/i.test(answer)) return false;
  const e = entryFor(country, entries);
  return !e || e.requiresSponsorshipNow === "yes" || e.requiresSponsorshipFuture === "yes";
}

/**
 * Yes/no "authorized to work?" / "require sponsorship?" questions with a known country, answered from the profile.
 * The model, even told the country, still answered from the home country's entry (Okta, Dublin: "require
 * sponsorship?" → "No"). Negated questions ("do you not require sponsorship?") stay with the model.
 */
function workAuthDecision(
  f: FieldDescriptor,
  country: string | undefined,
  entries: Profile["workAuthorization"]["entries"],
): Decision | null {
  // A text box asking a yes/no question takes "Yes"/"No" (Zoox: "Do you require sponsorship ...?").
  // Ro asks in a textarea; Gamma adds "If yes, please share more details below".
  const text =
    (f.kind === "text" || f.kind === "textarea") && /^(are|do|does|will|would|have|is|can)\b[^?]*\?/i.test(f.label);
  // Lever asks yes/no as a two-box checkbox group (Zoox).
  if (!country || (!f.options && !text) || (isMulti(f) && f.options?.length !== 2) || /\bnot\b|n['’]t\b/i.test(f.label))
    return null;
  const sponsor = RE_SPONSOR_Q.test(f.label);
  const authorized = /authori[sz]ed/i.test(f.label) || RE_ELIGIBLE.test(f.label);
  // "Authorized … without requiring sponsorship?" (Funnel): yes only if authorized and needing none.
  const without = authorized && /\bwithout\b[^?]*\bsponsor/i.test(f.label);
  if (!without && (sponsor === authorized || (authorized && /sponsor/i.test(f.label)))) return null;
  const only = (re: RegExp) => {
    const hits = (f.options ?? []).flatMap((o, i) => (re.test(o) ? [i] : []));
    return hits.length === 1 ? hits[0] : -1;
  };
  const e = entryFor(country, entries);
  // Airbnb splits "Yes, … sponsorship now …" from "Yes, … in the future …": pick by when it is needed. Else a bare
  // "Yes" beside a qualified one (Pinecone's "Yes (I have OPT / CPT)").
  const now = !e || e.requiresSponsorshipNow === "yes";
  const when = only(now ? /^yes\b.*\bnow\b/i : /^yes\b.*\bfuture\b/i);
  const yes = only(/^yes\b/i) >= 0 ? only(/^yes\b/i) : sponsor && when >= 0 ? when : only(/^yes\W*$/i);
  const no = only(/^no\b/i);
  if (!text && (yes < 0 || no < 0)) return null;
  // No entry for the country: not authorized there, so sponsorship needed.
  const says = !e
    ? [sponsor ? "yes" : "no"]
    : sponsor
      ? [e.requiresSponsorshipNow, ...(/future/i.test(f.label) ? [e.requiresSponsorshipFuture] : [])]
      : [e.authorized];
  const flip = (s: string) => (s === "yes" ? "no" : s === "no" ? "yes" : s);
  const all = !e
    ? ["no"]
    : [
        e.authorized,
        flip(e.requiresSponsorshipNow),
        ...(/future/i.test(f.label) ? [flip(e.requiresSponsorshipFuture)] : []),
      ];
  const answer = without
    ? all.includes("no")
      ? false
      : all.every((s) => s === "yes")
        ? true
        : null
    : says.includes("yes")
      ? true
      : says.every((s) => s === "no")
        ? false
        : null;
  if (answer === null) return null;
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["workAuthorization"] };
  if (text) return { ...base, text: answer ? "Yes" : "No" };
  const i = answer ? yes : no;
  return { ...base, optionIndexes: [i], intendedAnswer: f.options![i] };
}

/**
 * A right-to-work status list for a country where the profile needs sponsorship: its one option saying so. Octopus
 * Energy's London "what's your current right to work status?" got flagged rather than "I will need visa sponsorship
 * to start this role" for a Canadian with no UK entry.
 */
function needsSponsorshipDecision(
  f: FieldDescriptor,
  country: string | undefined,
  entries: Profile["workAuthorization"]["entries"],
): Decision | null {
  if (!country || !f.options || isMulti(f)) return null;
  const e = entryFor(country, entries);
  if (e && e.requiresSponsorshipNow !== "yes") return null;
  const hits = f.options.flatMap((o, i) =>
    /\b(need|require)\w*\b[^.]*\bsponsor/i.test(o) && !/\bfuture\b|\bnot\b|n['’]t\b|^no\b/i.test(o) ? [i] : [],
  );
  if (hits.length !== 1 || f.options.some((o) => /^yes\b/i.test(o))) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: hits,
    intendedAnswer: f.options[hits[0]],
    confidence: "high",
    sources: ["workAuthorization"],
  };
}

/**
 * A work authorization status list for a country the profile is a citizen of: its one option saying so by
 * citizenship or nationality. Vercel's "Your authorization to work in the country where you live" got "I am not
 * authorized to work in the country and need visa support" for a Canadian in Canada.
 */
function nationalityDecision(
  f: FieldDescriptor,
  country: string | undefined,
  entries: Profile["workAuthorization"]["entries"],
): Decision | null {
  if (!country || !f.options || isMulti(f)) return null;
  const e = entryFor(country, entries);
  if (e?.authorized !== "yes" || !/\bcitizen/i.test(e.status)) return null;
  const hits = f.options.flatMap((o, i) =>
    /\b(citizen\w*|nationality)\b/i.test(o) && !/\bnot\b|n['’]t\b|^no\b|\bsponsor|\bpermit\b/i.test(o) ? [i] : [],
  );
  if (hits.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: hits,
    intendedAnswer: f.options[hits[0]],
    confidence: "high",
    sources: ["workAuthorization"],
  };
}

/**
 * "Are you a U.S. citizen?" Yes/No from the status the profile gives that country: the audit flagged MongoDB's
 * "meet the special requirements …, specifically being a U.S. Citizen?" → "No" for a Canadian citizen. A list
 * ("citizen of Cuba, Iran, North Korea, or Syria?") is "Yes" when it names a country the profile is a citizen of, else
 * "No" only if the profile holds no other citizenship: such lists were left blank. "Permanent resident status in a
 * country outside the US?" asks about every other country, and citizenship there counts: it was flagged.
 */
function citizenDecision(f: FieldDescriptor, wa: Profile["workAuthorization"]): Decision | null {
  const pr = /\bpermanent resident|\bgreen card\b/i.test(f.label);
  if (
    !f.options ||
    isMulti(f) ||
    !(pr || /\bcitizen(s|ship)?\b|\bnationals? of\b/i.test(f.label)) ||
    /\bnot\b|n['’]t\b/i.test(f.label)
  )
    return null;
  const yes = f.options.findIndex((o) => /^yes\b/i.test(o));
  const no = f.options.findIndex((o) => /^no\b/i.test(o));
  if (yes < 0 || no < 0) return null;
  const inLabel = countriesIn(f.label);
  const named = inLabel.length ? inLabel : countriesIn(f.hint ?? "");
  // "U.S. citizen or permanent resident?" also takes a green card.
  const holds = (status: string) => /citizen/i.test(status) || (pr && /permanent|resident|green card/i.test(status));
  let i: number;
  if (/\b(outside( of)?|other than|besides|except)\b/i.test(f.label)) {
    if (!named.length) return null;
    const others = wa.entries.filter((e) => !named.includes(canonicalCountry(e.country) ?? normalize(e.country)));
    if (others.some((e) => holds(e.status))) i = yes;
    else if (!pr && wa.noOtherCitizenship === "yes") i = no;
    else return null;
  } else if (inLabel.length === 1 && !/[;:]|,[^,]*,/.test(f.label)) {
    const status = entryFor(inLabel[0], wa.entries)?.status ?? "none";
    if (!status) return null;
    i = holds(status) ? yes : no;
  } else if (named.some((c) => holds(entryFor(c, wa.entries)?.status ?? ""))) i = yes;
  else if (named.length && wa.noOtherCitizenship === "yes") i = no;
  else return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["workAuthorization"],
  };
}

/**
 * "Current company?" or "current job title?" from the role the profile marks current. With none, the model named a
 * past one (an internship ended two months before, on Spotify, Zscaler and Rubrik) or skipped a required box
 * (Abnormal): "N/A" if required, else blank. "Current or most recent employer" stays with the model.
 */
function currentCompanyDecision(f: FieldDescriptor, experience: Profile["experience"]): Decision | null {
  const label = normalize(f.label).replace(/^(what is |please (provide|enter) )?(the name of )?(your )?/, "");
  const company = /^current (company|employer)( name)?$/.test(label);
  const title = /^current (job )?(title|position)$/.test(label);
  if ((f.kind !== "text" && f.kind !== "textarea") || !(company || title)) return null;
  const today = todayIso().slice(0, 7);
  const now = experience.find((e) => e.company && (e.current || (e.startDate && (!e.endDate || e.endDate >= today))));
  const base = { fieldId: f.id, confidence: "high" as const, sources: ["experience"] };
  if (now && (company || now.title)) return { ...base, action: "fill", text: company ? now.company : now.title };
  return f.required ? { ...base, action: "fill", text: NOT_APPLICABLE } : { ...base, action: "skip" };
}

/**
 * "Other School (if not in school picklist)": the profile's school. iCIMS's picklist lacks most schools outside the
 * US, so it takes "Other" (fill/engine.ts) and this box names the school; the model skipped it as optional.
 */
function otherSchoolDecision(f: FieldDescriptor, education: Profile["education"]): Decision | null {
  if (f.kind !== "text" || !/^other (school|college|university|institution)\b/i.test(f.label.trim())) return null;
  const school = education.find((e) => e.school)?.school;
  return school ? { fieldId: f.id, action: "fill", text: school, confidence: "high", sources: ["education"] } : null;
}

/**
 * "Do you currently work at/for …?" with no current role in the profile: "No". Huntress's "currently work at a company
 * or partner that uses or sells Huntress products?" was left blank.
 */
function notWorkingDecision(f: FieldDescriptor, experience: Profile["experience"]): Decision | null {
  if (!f.options || isMulti(f) || !/^(do|are) you currently (work|employed)\w*\b[^?]*\b(at|for|by)\b/i.test(f.label))
    return null;
  const today = todayIso().slice(0, 7);
  if (experience.some((e) => e.current || (e.startDate && (!e.endDate || e.endDate >= today)))) return null;
  const no = f.options.flatMap((o, i) => (/^no\b/i.test(o) ? [i] : []));
  if (no.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: no,
    intendedAnswer: f.options[no[0]],
    confidence: "high",
    sources: ["experience"],
  };
}

/**
 * "May we contact your current employer?" with no current role: "Not applicable" when offered, else "Yes", since
 * there is no one to contact. Lyft's required one was left blank.
 */
function contactEmployerDecision(f: FieldDescriptor, experience: Profile["experience"]): Decision | null {
  if (!f.options || isMulti(f) || !/\b(may|can) we contact your (current|present) employer\b/i.test(f.label))
    return null;
  const today = todayIso().slice(0, 7);
  if (experience.some((e) => e.current || (e.startDate && (!e.endDate || e.endDate >= today)))) return null;
  const na = f.options.findIndex((o) => /\bnot (applicable|currently employed)\b|^n\/?a\b/i.test(o));
  const i = na >= 0 ? na : f.options.findIndex((o) => /^yes\W*$/i.test(o.trim()));
  if (i < 0) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["experience"],
  };
}

/**
 * "Do you hold / are you eligible for a (U.S.) security clearance?" for a U.S. job or one the label names, when the
 * profile gives no clearance and no U.S. citizenship, which U.S. clearances require: "No". Palantir's were flagged.
 */
function clearanceDecision(f: FieldDescriptor, job: string | undefined, profile: Profile): Decision | null {
  const l = f.label;
  if (!f.options || isMulti(f) || !/\bsecurity clearance\b/i.test(l) || /\bnot\b|n['’]t\b|\bunable\b/i.test(l))
    return null;
  if (profile.workAuthorization.securityClearance.trim() || (countryIn(l) ?? job) !== US) return null;
  if (/citizen/i.test(entryFor(US, profile.workAuthorization.entries)?.status ?? "")) return null;
  const no = f.options.flatMap((o, i) => (/^no\b/i.test(o.trim()) ? [i] : []));
  if (no.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: no,
    intendedAnswer: f.options[no[0]],
    confidence: "high",
    sources: ["workAuthorization"],
  };
}

/**
 * A country's status picked from a list naming its citizen, permanent resident and a catch-all (Shield AI's
 * export-control "Are you any of the following?": "Other" for a Canadian, which the model flagged instead; Airwallex's
 * "Working Rights in Singapore" was left blank, Qualtrics' "Individual born or naturalized in Mexico" list flagged).
 */
function statusDecision(f: FieldDescriptor, entries: Profile["workAuthorization"]["entries"]): Decision | null {
  if (!f.options || isMulti(f)) return null;
  const only = (re: RegExp) => {
    const hits = f.options!.flatMap((o, i) => (re.test(o) ? [i] : []));
    return hits.length === 1 ? hits[0] : -1;
  };
  const citizen = only(/\bcitizen\b|\bborn or naturali[sz]ed\b/i);
  const resident = only(/\bpermanent resident\b|\bgreen ?card\b/i);
  const other = only(/^(other|none( of the above)?|neither|not applicable|n\/a)\b/i);
  const country = citizen < 0 ? undefined : countryIn(f.options[citizen]);
  if (!country || resident < 0 || other < 0) return null;
  const status = entryFor(country, entries)?.status ?? "none";
  if (!status || /refugee|asyl/i.test(status)) return null;
  const i = /citizen/i.test(status) ? citizen : /permanent|green ?card/i.test(status) ? resident : other;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["workAuthorization"],
  };
}

/** Months of work experience in the profile, end dates included ("2026-01" to "2026-08" is 8). */
function experienceMonths(experience: Profile["experience"]): number {
  const month = (d: string) => {
    const [y, m] = d.split("-").map(Number);
    return y * 12 + (m || 1) - 1;
  };
  return experience.reduce((sum, e) => {
    const end = e.current || !e.endDate ? todayIso() : e.endDate;
    return e.startDate ? sum + Math.max(0, month(end) - month(e.startDate) + 1) : sum;
  }, 0);
}

/**
 * "How many years of experience?" when even the candidate's total experience is under the lowest bracket's top
 * ("Less than 2", "0-1 years"): relevant experience can only be less. The model picked "2,4" for 11 months. Some
 * experience below a lowest "1-2 years" with nothing under it is nearest that: Replit's got "3-5 years".
 */
function experienceDecision(f: FieldDescriptor, months: number, jobMinimum: boolean): Decision | null {
  if (!f.options || isMulti(f) || !/\bhow many years\b|\byears of\b.*\bexperience\b/i.test(f.label)) return null;
  if (jobMinimum || hasExperienceMinimum(`${f.label} ${f.hint ?? ""}`)) return null;
  const tops = f.options.map((o) => {
    const n = (o.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    if (/^(less than|under|fewer than|<)/i.test(o.trim()) && n.length === 1) return { low: 0, top: n[0] };
    if (n.length === 2 && n[0] < n[1]) return { low: n[0], top: n[1] };
    return null;
  });
  const lows = tops.flatMap((t) => (t ? [t.low] : []));
  const i = tops.findIndex((t) => t && t.low === Math.min(...lows));
  // Below the lowest bracket's floor too ("1-2" when there is also "None"): the model decides.
  const lower = f.options.some((o, k) => !tops[k] && /\b(none|no experience|0)\b|^(less than|under|<)/i.test(o));
  if (i < 0 || months / 12 >= tops[i]!.top || (months / 12 < tops[i]!.low && (lower || !months))) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["experience"],
  };
}

/**
 * "Are you able to work from our office 3 days a week?" (plain Yes/No) for a candidate open to on-site or hybrid work
 * and to relocating: "Yes". Benchling's got "No"; the audit blanked Plaid's. Where they live stays with the model.
 */
function officeDecision(f: FieldDescriptor, prefs: Profile["preferences"]): Decision | null {
  const l = f.label;
  if (!f.options || isMulti(f) || !/\b(office|on-?site|in[- ]person)\b/i.test(l)) return null;
  if (!/\b(able|willing|can you|comfortable|commit|open|excited)\b/i.test(l)) return null;
  // Where the candidate is, not where the office is ("office (located at 441 9th Avenue)", Peloton).
  const where = /\b(are you|you are|you're|currently) (located|based|living)\b|\b(you|currently) (live|reside)\b/i;
  if (where.test(l) || /\breside\b|\bnot\b|n['’]t\b/i.test(l) || prefs.willingToRelocate !== "yes") return null;
  const daily = /\b(5|five) days\b|\bevery ?day\b|\bfully on-?site\b/i.test(l);
  if (!prefs.workArrangement.some((w) => w === "onsite" || (!daily && w === "hybrid"))) return null;
  // A lone plain "Yes": not "Yes, I live in Campinas", nor beside "Yes but I would need to relocate" (Zip).
  const yes = f.options.flatMap((o, i) => (/^yes\b/i.test(o) ? [i] : []));
  if (yes.length !== 1 || !/^yes\W*$/i.test(f.options[yes[0]]) || !f.options.some((o) => /^no\b/i.test(o))) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: yes,
    intendedAnswer: f.options[yes[0]],
    confidence: "high",
    sources: ["preferences"],
  };
}

/**
 * "Are you located in or willing to relocate to the United Kingdom?" for a candidate living in another country, from
 * the relocation preference: Tailscale's got "No, and I am not willing to relocate." for one willing to go anywhere.
 * The same country stays with the model unless the named hub is in another province or state: Lyft's "office in
 * Toronto … are you open to relocating?" got "I already reside within commutable distance to Toronto" for BC.
 */
function relocationDecision(
  f: FieldDescriptor,
  prefs: Profile["preferences"],
  address: Profile["personal"]["address"],
): Decision | null {
  const willing = prefs.willingToRelocate;
  // Negation in the question itself, not in a lead-in clause ("if you do not reside …, are you open to relocating?").
  const ask = f.label.replace(/\bif you (do not|don['’]t)\b[^,?]*,/i, "");
  if (!f.options || isMulti(f) || !/\brelocat/i.test(ask) || /\bnot\b|n['’]t\b/i.test(ask) || /^if\b/i.test(f.label))
    return null;
  if ((willing !== "yes" && willing !== "no") || !/^(any(where)?)?$/i.test(prefs.relocationNotes.trim())) return null;
  const words = ` ${normalize(f.label)} `;
  const hub = Object.keys(HUBS).find((c) => words.includes(` ${c} `));
  const there = countryIn(f.label) ?? (hub ? (canonicalCountry(HUBS[hub]) ?? HUBS[hub]) : undefined);
  const mine = canonicalCountry(address.country);
  const region = regionCode(address.regionCode || address.region);
  const elsewhere = there !== mine || (hub && HUB_REGIONS[hub] && region && HUB_REGIONS[hub] !== region);
  if (!there || !mine || !elsewhere) return null;
  const neg = /\bnot\b|n['’]t\b|\bunwilling\b|\bunable\b/i;
  const only = (ok: (o: string) => boolean) => {
    const hits = f.options!.flatMap((o, i) => (ok(o) ? [i] : []));
    return hits.length === 1 ? hits[0] : -1;
  };
  const yes = willing === "yes";
  const named = only((o) => /\brelocat/i.test(o) && neg.test(o) !== yes);
  const i = named >= 0 ? named : only((o) => (yes ? /^yes\W*$/i : /^no\W*$/i).test(o.trim()));
  if (i < 0) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["preferences.willingToRelocate"],
  };
}

// Where a split state's time zones differ, its most populous one.
const ZONES: [string, RegExp, string[]][] = (
  [
    // Abbreviations in capitals only: not "at", "et".
    ["Pacific", /\b[Pp]acific\b|\bP[SD]?T\b/, "BC WA OR CA NV"],
    ["Mountain", /\b[Mm]ountain\b|\bM[SD]?T\b/, "AB CO UT NM WY MT ID AZ"],
    ["Central", /\b[Cc]entral\b(?! [Ee]urop)|\bC[SD]?T\b/, "SK MB TX IL MN WI IA MO AR LA MS AL OK KS NE SD ND TN"],
    [
      "Eastern",
      /\b[Ee]astern\b(?! [Ee]urop)|\bE[SD]?T\b/,
      "ON QC NY NJ PA MA CT RI VT NH ME DE MD DC VA WV NC SC GA FL OH MI IN KY",
    ],
    ["Atlantic", /\b[Aa]tlantic\b|\bA[SD]?T\b/, "NB NS PE"],
  ] as const
).map(([name, re, codes]) => [name, re, codes.split(" ")]);

/**
 * "What time zone are you based in?" from a Canadian or US address: Collibra's "Pacific Time (PT)" for British
 * Columbia was rejected by the audit.
 */
function timezoneDecision(f: FieldDescriptor, address: Profile["personal"]["address"]): Decision | null {
  if (!/\btime ?zone\b/i.test(f.label) || isMulti(f) || !/^(text|textarea|select|dropdown|radio_group)$/.test(f.kind))
    return null;
  const code = regionCode(address.regionCode || address.region);
  const zone = code && ZONES.find(([, , codes]) => codes.includes(code));
  if (!zone) return null;
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["personal.address"] };
  // Grafana's "What country and time zone are you based in?" wants both.
  const text = /\bcountry\b/i.test(f.label) ? `${address.country}, ${zone[0]} Time` : `${zone[0]} Time`;
  if (!f.options) return f.kind === "text" || f.kind === "textarea" ? { ...base, text } : null;
  const hits = f.options.flatMap((o, i) => (zone[1].test(o) ? [i] : []));
  return hits.length === 1 ? { ...base, optionIndexes: hits, intendedAnswer: f.options[hits[0]] } : null;
}

/**
 * "Highest level of education you have obtained/completed?" while no degree is finished yet: high school. Appian's
 * got "Bachelor's Degree" for a student graduating in 2028. With a finished degree, the model decides, as it does
 * for "completed or are pursuing" (iCIMS's got high school).
 */
function obtainedEducationDecision(f: FieldDescriptor, profile: Profile): Decision | null {
  const done = /\b(obtained|completed|attained|earned|achieved|received|finished)\b/i;
  // A list not read yet (SuccessFactors' typeahead got "Bachelor's Degree" from the model): its search finds it.
  const unread = !f.options && (f.kind === "typeahead" || f.kind === "dropdown");
  if (
    (!f.options && !unread) ||
    isMulti(f) ||
    !/\bhighest\b/i.test(f.label) ||
    !/\b(education|degree)\b/i.test(f.label)
  )
    return null;
  if (!done.test(f.label) || /\b(pursu\w*|enrolled|in progress|working (toward|on))\b/i.test(f.label)) return null;
  // An education entry's "Highest Degree Achieved" (Westinghouse's, beside its school) is that entry's degree.
  if (RE_ENTRY_SECTION.test(f.section ?? "")) return null;
  if (!profile.highSchool.graduationYear) return null;
  const today = todayIso().slice(0, 7);
  const finished = profile.education.some(
    (e) =>
      e.currentlyEnrolled !== "yes" &&
      !!(e.endDate || e.expectedGraduation) &&
      (e.endDate || e.expectedGraduation) <= today,
  );
  if (finished || !profile.education.length) return null;
  if (!f.options)
    return {
      fieldId: f.id,
      action: "fill",
      intendedAnswer: "High School",
      searchQuery: "High School",
      confidence: "high",
      sources: ["highSchool", "education"],
    };
  const hits = f.options.flatMap((o, i) => (/\bhigh school\b|\bsecondary\b|\bGED\b/i.test(o) ? [i] : []));
  if (hits.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: hits,
    intendedAnswer: f.options[hits[0]],
    confidence: "high",
    sources: ["highSchool", "education"],
  };
}

/**
 * "Yes" to remote-work basics (consistent internet, power, a phone, a place to work) and to English fluency when the
 * profile lists English as fluent or better, or its résumé is in English. JumpCloud's were all rejected by the audit.
 */
function basicsDecision(f: FieldDescriptor, profile: Profile): Decision | null {
  if (!f.options || isMulti(f) || /\bnot\b|n['’]t\b/i.test(f.label)) return null;
  const setup =
    /^(do|will) you have\b[^?]*\b(internet|power|electricity|phone|cellular|remote work environment|workspace)\b/i.test(
      f.label,
    );
  const english = /\b(fluent|proficient|fluency|proficiency)\b[^?]*\bEnglish\b/i.test(f.label);
  if (!setup && !english) return null;
  if (english) {
    const listed = profile.skills.languages.find((l) => /^english$/i.test(l.language.trim()));
    const words = (profile.resumeText.match(/\b(the|and|with|for|of)\b/gi) ?? []).length;
    if (listed ? !/native|fluent|bilingual|professional|advanced/i.test(listed.proficiency) : words < 20) return null;
  }
  const yes = f.options.flatMap((o, i) => (/^yes\b/i.test(o) ? [i] : []));
  if (yes.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: yes,
    intendedAnswer: f.options[yes[0]],
    confidence: "high",
    sources: [english ? "skills.languages" : "preferences"],
  };
}

/**
 * "Language skills (check all that apply)": the profile's languages, and English for an English résumé. Palantir's
 * got only "English (ENG)", leaving out the profile's native Mandarin.
 */
function languagesDecision(f: FieldDescriptor, profile: Profile): Decision | null {
  if (!f.options || !isMulti(f) || !/\blanguages?\b/i.test(f.label)) return null;
  const names = profile.skills.languages.map((l) => normalize(l.language)).filter(Boolean);
  const english = (profile.resumeText.match(/\b(the|and|with|for|of)\b/gi) ?? []).length >= 20;
  if (english && !names.includes("english")) names.push("english");
  const opts = f.options.map((o) => normalize(o).split(" "));
  const picks = names.map((n) => {
    const hits = opts.flatMap((words, i) => (words.join(" ").startsWith(n) || words.includes(n) ? [i] : []));
    return hits.length === 1 ? hits[0] : -1;
  });
  if (!picks.length || picks.includes(-1)) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [...new Set(picks)],
    intendedAnswer: picks.map((i) => f.options![i]).join(", "),
    confidence: "high",
    sources: ["skills.languages"],
  };
}

/** A technology's name for comparing: "React.js", "ReactJS" and "React" read alike. */
const techName = (t: string) => {
  const n = t.toLowerCase().replace(/\s+/g, "");
  return n.replace(/\.?js$/, "") || n;
};
const techNames = (t: string) =>
  t
    .split(/[/,()]| or /)
    .map(techName)
    .filter(Boolean);

/**
 * "Which languages are you proficient in?" (checklist of technologies): each one the profile's skills or projects
 * name. Nimbus's got Python and Java, leaving out the profile's TypeScript and C++.
 */
function skillsDecision(f: FieldDescriptor, profile: Profile): Decision | null {
  if (!f.options || !isMulti(f) || /\bnot\b|n['’]t\b/i.test(f.label)) return null;
  if (!/\b(languages?|technolog\w*|frameworks?|tools?|skills?|tech stack)\b/i.test(f.label)) return null;
  // In the profile's order: "select up to 3" keeps the ones it lists first.
  const known = [
    ...profile.skills.technical,
    ...profile.skills.soft,
    ...profile.projects.flatMap((p) => p.tech),
  ].flatMap(techNames);
  const rank = (o: string) =>
    Math.min(
      ...techNames(o)
        .map((n) => known.indexOf(n))
        .filter((r) => r >= 0),
    );
  const max = Number(f.label.match(/\b(?:up to|at most|max(?:imum)?(?: of)?|top)\s+(\d)\b/i)?.[1]) || undefined;
  const picks = f.options
    .flatMap((o, i) => (Number.isFinite(rank(o)) ? [i] : []))
    .sort((a, b) => rank(f.options![a]) - rank(f.options![b]))
    .slice(0, max)
    .sort((a, b) => a - b);
  if (!picks.length) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: picks,
    intendedAnswer: picks.map((i) => f.options![i]).join(", "),
    confidence: "high",
    sources: ["skills.technical", "projects"],
  };
}

/**
 * "How many prior internships have you had?" counted from the profile's internship and co-op roles: Harvey and Notion
 * got "1" for two, and Manulife's "How many previous work-term experiences have you had?" a guessed "1".
 */
function internshipsDecision(f: FieldDescriptor, experience: Profile["experience"]): Decision | null {
  if (!/\bhow many\b[^?]*\b(internships?|co-?ops?|work[- ]terms?)\b/i.test(f.label) || isMulti(f)) return null;
  const roles = experience.filter((e) => /\b(intern(ship)?|co-?op)\b/i.test(`${e.employmentType} ${e.title}`));
  // A work term is four months: Manulife's ("Four (4) months … equals one work-term") got "1" for an 8-month co-op.
  const n = /\bwork[- ]terms?\b/i.test(f.label)
    ? roles.reduce((sum, e) => sum + Math.max(1, Math.round(experienceMonths([e]) / 4)), 0)
    : roles.length;
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["experience"] };
  if (!f.options) return f.kind === "text" || f.kind === "number" ? { ...base, text: String(n) } : null;
  const hits = f.options.flatMap((o, i) => {
    const m = (o.match(/\d+/g) ?? []).map(Number);
    const ok =
      m.length === 2 ? n >= m[0] && n <= m[1] : m.length === 1 && /\+|or more/.test(o) ? n >= m[0] : m[0] === n;
    return ok || (n === 0 && /^(none|no|zero)\b/i.test(o)) ? [i] : [];
  });
  return hits.length === 1 ? { ...base, optionIndexes: hits, intendedAnswer: f.options[hits[0]] } : null;
}

const RE_ATTACH_DOC = /\b(transcript|cover letter|portfolio|writing sample)s?\b/i;
const RE_ANY_DOC_BOX = /\b(additional|other|supporting)\b[^?]*\b(documents?|files?|attachments?)\b|^attachments?$/i;

/**
 * "Have you attached your unofficial transcript?" on a page whose only upload box is the résumé: nothing else went in.
 * John Deere's got "Yes, my unofficial transcript has been attached". Pages with a box that could hold it are left to
 * the AI; so are pages with no upload box at all (the file may have gone in on an earlier page).
 */
function attachedDecision(f: FieldDescriptor, uploads: string[] | undefined): Decision | null {
  const doc = RE_ATTACH_DOC.exec(f.label)?.[1].toLowerCase();
  if (!doc || !uploads?.length || !/\b(attach|upload|includ|submitt?)\w*\b/i.test(f.label)) return null;
  if (!/^(have|did|are|is|has)\b/i.test(f.label.trim()) && !/\b(have|did) you\b/i.test(f.label)) return null;
  if (uploads.some((u) => new RegExp(`\\b${doc}`, "i").test(u) || RE_ANY_DOC_BOX.test(u.trim()))) return null;
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["documents"] };
  if (f.kind === "text" || f.kind === "textarea")
    return { ...base, text: `No: this application has no place to upload my ${doc}. I can send it on request.` };
  const no = f.options?.flatMap((o, i) => (/^no\b/i.test(o.trim()) ? [i] : [])) ?? [];
  return no.length === 1 && !isMulti(f) ? { ...base, optionIndexes: no, intendedAnswer: f.options![no[0]] } : null;
}

/**
 * "How do you pronounce your name?": the profile doesn't say. Sierra's "Name pronounciation" got the pronouns, and
 * Akuna's "how your name is pronounced phonetically" a made-up "An-dee Woo". Solink's "Preferred name and
 * pronunciation" also asks the preferred name: that part is filled.
 */
function pronunciationDecision(f: FieldDescriptor, p: Profile["personal"]): Decision | null {
  if (!/\bpronoun(ce|ced|ci?ation)\b|\bpronunciation\b/i.test(f.label)) return null;
  const name = p.preferredName || p.firstName;
  if (name && /\bpreferred (first )?name\b/i.test(f.label) && (f.kind === "text" || f.kind === "textarea"))
    return { fieldId: f.id, action: "fill", text: name, confidence: "high", sources: ["personal.preferredName"] };
  return f.required
    ? flag(f.id, "Add how your name is pronounced")
    : { fieldId: f.id, action: "skip", confidence: "high" };
}

const RE_DATE_RANGE = /\b([a-z]{3,9})\.? (\d{1,2}),? ?(\d{4})?\s*[-–—]\s*([a-z]{3,9})\.?,? (\d{1,2}),? ?(\d{4})\b/i;

/**
 * "Indicate all cohort dates you would be able to work": each dated option inside the profile's availability window.
 * Harvey's got two of its five, all of which fell between the earliest start and the available-until date.
 */
function cohortDecision(f: FieldDescriptor, prefs: Profile["preferences"]): Decision | null {
  if (!f.options || !isMulti(f) || !prefs.earliestStartDate || !prefs.availableUntil) return null;
  const iso = (mon: string, day: string, year: string) => {
    const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1;
    return m ? `${year}-${String(m).padStart(2, "0")}-${day.padStart(2, "0")}` : "";
  };
  const fits = f.options.map((o) => {
    const r = RE_DATE_RANGE.exec(o);
    if (!r) return null;
    const [start, end] = [iso(r[1], r[2], r[3] ?? r[6]), iso(r[4], r[5], r[6])];
    return start && end ? start >= prefs.earliestStartDate && end <= prefs.availableUntil : null;
  });
  if (fits.includes(null) || !fits.includes(true)) return null;
  const picks = fits.flatMap((ok, i) => (ok ? [i] : []));
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: picks,
    intendedAnswer: picks.map((i) => f.options![i]).join(", "),
    confidence: "high",
    sources: ["preferences.earliestStartDate", "preferences.availableUntil"],
  };
}

// A term's middle month, to place it in the availability window.
const TERM_MID: [RegExp, number][] = [
  [/\bwinter\b/i, 2],
  [/\bspring\b/i, 4],
  [/\bsummer\b/i, 7],
  [/\b(fall|autumn)\b/i, 10],
];

/** Whether a term option ("Summer 2027", "Winter (January - May)") suits the profile; null when it names no season. */
function termFits(o: string, profile: Profile): boolean | null {
  const { earliestStartDate: from, availableUntil: to } = profile.preferences;
  const terms = profile.coop.availableTerms;
  const any = !terms.length || terms.some((t) => /^all$/i.test(t.trim()));
  const season = TERM_MID.find(([re]) => re.test(o));
  if (!season || (!any && !terms.some((t) => season[0].test(t)))) return season ? false : null;
  const year = o.match(/\b20\d\d\b/)?.[0];
  if (!year) return true;
  const mid = `${year}-${String(season[1]).padStart(2, "0")}`;
  return !!from && mid >= from.slice(0, 7) && (!to || mid <= to.slice(0, 7));
}

/**
 * "Which term(s) would you like to be considered for?" (checklist of seasons): each term inside the availability
 * window and among the co-op terms the profile lists ("All" for any). Etched's "Winter (January - May)" and "Summer
 * (May - August)" were left blank. Asked for one ("which term works for you?", "winter or summer internship?"),
 * the first that fits: Vercel's and Verkada's were left blank.
 */
function termsDecision(f: FieldDescriptor, profile: Profile): Decision | null {
  const asks = isMulti(f) ? /\b(terms?|semesters?|seasons?)\b/i : /\b(terms?|semesters?|seasons?|internship)\b/i;
  if (!f.options || !asks.test(f.label) || !profile.preferences.earliestStartDate) return null;
  const fits = f.options.map((o) => termFits(o, profile));
  if (fits.includes(null) || !fits.includes(true)) return null;
  const picks = fits.flatMap((ok, i) => (ok ? [i] : [])).slice(0, isMulti(f) ? undefined : 1);
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: picks,
    intendedAnswer: picks.map((i) => f.options![i]).join(", "),
    confidence: "high",
    sources: ["preferences.earliestStartDate", "preferences.availableUntil", "coop.availableTerms"],
  };
}

/** An option's length in months: "4 months", "8-month term", "12 months (3 terms)". */
const monthsIn = (o: string) => Number(o.match(/\b(\d{1,2})[- ]?months?\b/i)?.[1]) || null;

/**
 * "Which work term lengths are you available for? (select all that apply)": each length among the profile's
 * acceptable ones ("All" for any). The AI ticked only the posting's own 8 months for a candidate open to all. Asked
 * for one, with two or more that suit, the list's "Either": JazzHR's got "Jan–Aug 2027 (8 months)".
 */
function termLengthsDecision(f: FieldDescriptor, coop: Profile["coop"]): Decision | null {
  const lengths = coop.acceptableTermLengths.map((t) => t.trim()).filter(Boolean);
  if (!f.options || !lengths.length) return null;
  // Bare lengths ("4 months", "8 months") answer any wording: Kepler's "indicate your availability for the internship".
  const bare = f.options.every((o) => /^\d{1,2}[- ]?months?$/i.test(o.trim()));
  if (
    !bare &&
    !/\b(lengths?|durations?|how long|months?)\b/i.test(f.label) &&
    (isMulti(f) || !/\bterms?\b/i.test(f.label))
  )
    return null;
  const months = f.options.map(monthsIn);
  const any = lengths.some((t) => /^(all|any)$/i.test(t));
  const ok = new Set(lengths.map(monthsIn));
  const fit = months.flatMap((m, i) => (m !== null && (any || ok.has(m)) ? [i] : []));
  const either = f.options.flatMap((o, i) =>
    /^(either|both|any|no preference|flexible|open to (either|any|both))\b/i.test(o.trim()) ? [i] : [],
  );
  const picks = isMulti(f)
    ? months.includes(null)
      ? []
      : fit
    : fit.length >= 2 && either.length === 1 && months.every((m, i) => m !== null || i === either[0])
      ? either
      : [];
  if (!picks.length) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: picks,
    intendedAnswer: picks.map((i) => f.options![i]).join(", "),
    confidence: "high",
    sources: ["coop.acceptableTermLengths"],
  };
}

/**
 * "Indicate all locations you would be interested in relocating to" for a candidate willing to relocate anywhere:
 * every one. Notion's got only "San Francisco, CA" of New York and San Francisco. "Preferred office location(s) …
 * Select 1-3" takes the first that many (Palantir's was left blank).
 */
function relocateAllDecision(f: FieldDescriptor, prefs: Profile["preferences"]): Decision | null {
  // MongoDB: "Which of the following locations are you open to living and working in Summer 2027?" (a multi-select).
  const all = /\ball\b[^?]*\blocations?\b|\blocations?\b[^?]*\b(all that apply|open to|willing to)\b/i.test(f.label);
  const preferred = /\bpreferred (office )?locations?\b/i.test(f.label);
  const anywhere = /^(any(where)?)?$/i.test(prefs.relocationNotes.trim()) && prefs.preferredLocations.includes("Any");
  if (prefs.willingToRelocate !== "yes" || !anywhere || !(all || preferred)) return null;
  // Its text box ("Insert other preferred location(s) and/or further context on preference").
  if (!f.options && preferred && (f.kind === "text" || f.kind === "textarea"))
    return {
      fieldId: f.id,
      action: "fill",
      text: "Open to any location; willing to relocate.",
      confidence: "high",
      sources: ["preferences.willingToRelocate", "preferences.preferredLocations"],
    };
  if (!f.options || !isMulti(f)) return null;
  const cap = Number(/\bselect (?:up to |\d+ ?[-–] ?|between \d+ and )?(\d+)\b/i.exec(f.label)?.[1] ?? Infinity);
  const picks = f.options
    .flatMap((o, i) => (/^(none|other|n\/a|not applicable|remote)\b/i.test(o) ? [] : [i]))
    .slice(0, cap);
  if (!picks.length) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: picks,
    intendedAnswer: picks.map((i) => f.options![i]).join(", "),
    confidence: "high",
    sources: ["preferences.willingToRelocate"],
  };
}

/**
 * An undergraduate GPA among 4.0-scale options ("3.9 out of 4.0", "3.5 - 3.99"), converted from the profile's scale
 * (a 4.33 scale tops out at 4.0). SpaceX's got "Not applicable" for 4.33 out of 4.33: the model would not convert.
 * A bare value ("3.9", "4.0") is the floor of its step: Akuna's list got ">4.0", which the audit rejected.
 */
function gpaDecision(f: FieldDescriptor, education: Profile["education"]): Decision | null {
  const e = education.find((x) => x.gpa);
  const [gpa, scale] = [Number(e?.gpa), Number(e?.gpaScale || 4)];
  if (isMulti(f) || !/\bGPA\b|grade point/i.test(f.label) || !gpa || !scale) return null;
  if (/\b(graduate|doctorate|master'?s?|ph\.?d|high school)\b/i.test(f.label)) return null;
  if (!f.options) {
    // Asked on a stated scale in a box: Airwallex's "on a 5.0 scale … please convert" got 4.33 (of 4.33). xAI states
    // it in the hint ("Please convert your GPA to a 4.0 scale"): the audit rejected the model's 4.00, the guess wrote 3.98.
    const m = /\b(\d+(?:\.\d+)?)[- ]?(?:point )?scale\b|\bout of (\d+(?:\.\d+)?)\b/i.exec(`${f.label} ${f.hint ?? ""}`);
    const to = Number(m?.[1] ?? m?.[2]);
    if (!to || (f.kind !== "text" && f.kind !== "number")) return null;
    const text = String(to === scale ? gpa : Math.round((gpa / scale) * to * 100) / 100);
    return { fieldId: f.id, action: "fill", text, confidence: "high", sources: ["education"] };
  }
  const v = scale >= 4 && scale <= 4.34 ? Math.min(gpa, 4) : (gpa / scale) * 4;
  let best = -1;
  let bestLow = -Infinity;
  f.options.forEach((o, i) => {
    const m = o.match(/^\s*(\d(?:\.\d+)?)\s*(?:[-–]\s*(\d(?:\.\d+)?)|(?:out of|\/)\s*4(?:\.0+)?\b|$)/i);
    if (!m) return;
    const low = Number(m[1]);
    const top = m[2] ? Number(m[2]) + 0.01 : Infinity;
    if (low <= v + 1e-9 && v < top && low > bestLow) [best, bestLow] = [i, low];
  });
  if (best < 0) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [best],
    intendedAnswer: f.options[best],
    confidence: "high",
    sources: ["education"],
  };
}

/** Current-student attestations, including a lone checkbox such as "I currently attend". */
const RE_CURRENT_STUDENT =
  /\b(?:currently|presently|now)\b[^?.]{0,40}\b(?:attend(?:ing)?|enrol(?:led|ment)?|stud(?:y|ying)|student)\b|\b(?:attend(?:ing)?|enrol(?:led|ment)?|stud(?:y|ying)|student)\b[^?.]{0,40}\b(?:currently|presently|now)\b|\bcurrent(?:ly)?\s+(?:enrol(?:led|ment)|student)\b|\b(?:currently|presently|now)\b[^?.]{0,40}\bpursu(?:e|ing)\b[^?.]{0,20}\b(?:degree|program|course|education)\b/i;
const RE_NEGATED_CURRENT_STUDENT =
  /\b(?:not|no longer|never|do not|don't|does not|doesn't|is not|isn't|are not|aren't)\b[^?.]{0,35}\b(?:attend|enrol|stud|student|pursu)/i;

function currentStudentDecision(f: FieldDescriptor, education: Profile["education"]): Decision | null {
  if (!RE_CURRENT_STUDENT.test(f.label) || RE_NEGATED_CURRENT_STUDENT.test(f.label)) return null;
  const section = RE_ENTRY_SECTION.exec(f.section ?? "");
  const scoped = section && /education/i.test(section[1]) ? education[(Number(section[2]) || 1) - 1] : undefined;
  // Asked only about graduate programs (Profluent: "enrolled in a PhD or master's program, or have you graduated from
  // one …?"), a bachelor's student is not: they got "Yes, I have graduated with an MS or PhD".
  const graduate =
    /\b(ph\.?d|doctora\w*|master'?s|mba|graduate (school|program|degree|studies))\b/i.test(f.label) &&
    !/\b(bachelor'?s?|undergrad\w*|college)\b/i.test(f.label);
  const inGraduate = (e: Profile["education"][number]) =>
    /\b(master|ph\.?d|doctor\w*|m\.?sc|mba|m\.?eng|m\.?a\.?s?c?)\b/i.test(e.degree);
  if (graduate && education.some(inGraduate)) return null;
  const enrolled = graduate
    ? "no"
    : (scoped?.currentlyEnrolled ?? (education.some((e) => e.currentlyEnrolled === "yes") ? "yes" : ""));
  const answer = enrolled || (education.length && education.every((e) => e.currentlyEnrolled === "no") ? "no" : "");
  if (!answer) return null;
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["education"] };
  if (f.kind === "checkbox") return { ...base, checked: answer === "yes" };
  if (!f.options || isMulti(f)) return null;
  const i = f.options.findIndex((o) => new RegExp(`^${answer}\\b`, "i").test(o));
  return i < 0 ? null : { ...base, optionIndexes: [i], intendedAnswer: f.options[i] };
}

/**
 * "How soon could you start?" among ranges ("2 weeks or less", "8 - 12 weeks", "more than 12 weeks"), counted from
 * today to the profile's earliest start date. Enable's got "more than 12 weeks" for a start 10 weeks away. Asked in
 * a text box, that date: Netomi's "How soon are you able to join if selected?" and Hugging Face's "Notice period /
 * availability" got "Immediately" for January.
 */
function startDecision(f: FieldDescriptor, earliest: string): Decision | null {
  const label =
    /\bhow soon\b|\bwhen (can|could|would) you (start|begin|join)\b|\b(availability|able) to (start|begin)\b|\bnotice period\b[^?]*\bavailab/i;
  // A return offer starts after graduating (returnOfferDecision), not at the internship's start.
  if (isMulti(f) || !earliest || !label.test(f.label) || RE_RETURN_OFFER.test(f.label)) return null;
  const weeks = Math.max(0, (Date.parse(earliest) - Date.parse(todayIso())) / 6048e5);
  if (!f.options) {
    if (f.kind !== "text" && f.kind !== "textarea") return null;
    const on = new Date(earliest).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });
    const text = weeks > 0 ? `From ${on}` : "Immediately";
    return { fieldId: f.id, action: "fill", text, confidence: "high", sources: ["preferences.earliestStartDate"] };
  }
  // Bare amounts ("1 week", "2 months"): Hugging Face's notice periods. The longest not past the start date.
  const points: [number, number][] = [];
  const hits = f.options.flatMap((o, i) => {
    const unit = /\bmonths?\b/i.test(o) ? 4.345 : /\bweeks?\b/i.test(o) ? 1 : 0;
    const n = (o.match(/\d+(\.\d+)?/g) ?? []).map((x) => Number(x) * unit);
    let range: [number, number] | null = null;
    if (/\bimmediate/i.test(o) && !n.length) range = [0, 0];
    else if (!unit) range = null;
    else if (n.length === 2) range = [n[0], n[1]];
    else if (n.length === 1 && /\bor less\b|\bwithin\b|\bless than\b|\bunder\b/i.test(o)) range = [0, n[0]];
    else if (n.length === 1 && /\bmore than\b|\bover\b|\bor more\b|\+/i.test(o)) range = [n[0], Infinity];
    else if (n.length === 1) points.push([n[0], i]);
    return range && weeks >= range[0] && weeks <= range[1] ? [{ i, width: range[1] - range[0] }] : [];
  });
  const point = points.filter(([w]) => w <= weeks).sort((a, b) => b[0] - a[0])[0];
  if (!hits.length && point) hits.push({ i: point[1], width: 0 });
  // The narrowest wins: "immediately" over "2 weeks or less" for a start date already passed.
  hits.sort((a, b) => a.width - b.width);
  if (!hits.length || hits[1]?.width === hits[0].width) return null;
  const i = hits[0].i;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["preferences"],
  };
}

const RE_RETURN_OFFER = /\breturn offer\b|\bfull[- ]time\b/i;

/**
 * "If given a return offer, what year would you be able to start?": the graduation year. Semgrep's got "From
 * January 1, 2027", the internship's earliest start. Among months, the one after graduating: Datadog's "If you were
 * offered full-time employment, when would you be able to start?" got "June", which the audit rejected.
 */
function returnOfferDecision(f: FieldDescriptor, profile: Profile): Decision | null {
  const offer = /\breturn offer\b|\boffered full[- ]time\b|\bfull[- ]time (employment|role|position|offer)\b/i;
  if (!offer.test(f.label) || !/\b(what year|when)\b[^?]*\b(start|begin)\b/i.test(f.label) || isMulti(f)) return null;
  const when = profile.education.find((e) => e.expectedGraduation || e.endDate);
  const grad = when?.expectedGraduation || when?.endDate;
  if (!grad) return null;
  const year = grad.slice(0, 4);
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["education"] };
  if (!f.options)
    return (f.kind === "text" || f.kind === "textarea") && /\bwhat year\b/i.test(f.label)
      ? { ...base, text: year }
      : null;
  let i = f.options.findIndex((o) => o.trim() === year);
  const month = Number(grad.slice(5, 7));
  if (i < 0 && month) {
    const next = MONTHS[month % 12];
    i = f.options.findIndex((o) => new RegExp(`^${next}[a-z]*\\.?$`, "i").test(o.trim()));
  }
  return i < 0 ? null : { ...base, optionIndexes: [i], intendedAnswer: f.options[i] };
}

const RE_FULL_DATE = /\b([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/gi;

/**
 * "Are you available to start on either Tuesday, May 25th, 2026 or Tuesday, June 8th, 2027?" (plain Yes/No): Yes
 * when one of the dates falls inside the profile's availability. Semgrep's got "No" for a January 2027 start.
 */
function startOnDecision(f: FieldDescriptor, prefs: Profile["preferences"]): Decision | null {
  const { earliestStartDate: from, availableUntil: to } = prefs;
  if (!f.options || isMulti(f) || !from || !/\bavailable to (start|begin)\b/i.test(f.label)) return null;
  const dates = [...f.label.matchAll(RE_FULL_DATE)].map(([, mon, day, year]) => {
    const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1;
    return m ? `${year}-${String(m).padStart(2, "0")}-${day.padStart(2, "0")}` : "";
  });
  // shortcut: one date or "either … or" only; a "from … to" range stays with the model.
  if (!dates.length || dates.includes("") || (dates.length > 1 && !/\bor\b/i.test(f.label))) return null;
  const ok = dates.some((d) => d >= from && (!to || d <= to));
  const i = f.options.findIndex((o) => (ok ? /^yes\W*$/i : /^no\W*$/i).test(o.trim()));
  if (i < 0) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: ["preferences.earliestStartDate", "preferences.availableUntil"],
  };
}

/**
 * "How many months are you available?" in a text box, from the earliest start to the available-until date. Binance's
 * got "12 months - January to December 2027" for January 2027 to May 2028.
 */
function durationDecision(f: FieldDescriptor, prefs: Profile["preferences"]): Decision | null {
  const { earliestStartDate: from, availableUntil: to } = prefs;
  if ((f.kind !== "text" && f.kind !== "textarea") || !from || !to) return null;
  if (!/\bhow (many months|long)\b[^?]*\bavailab/i.test(f.label)) return null;
  const [y1, m1] = from.split("-").map(Number);
  const [y2, m2] = to.split("-").map(Number);
  const months = y2 * 12 + m2 - (y1 * 12 + m1);
  if (months <= 0) return null;
  const name = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return {
    fieldId: f.id,
    action: "fill",
    text: `${months} months – ${name(from)} to ${name(to)}`,
    confidence: "high",
    sources: ["preferences.earliestStartDate", "preferences.availableUntil"],
  };
}

const RE_PAY_Q = /\b(compensation|salary|pay|wages?|(hourly|pay) rate)\b/i;
// "Current salary" isn't the pay asked for, and "Are you comfortable with the range?" is a yes/no question.
const RE_NOT_DESIRED = /\b(current|previous|last|prior|currency)\b|^(are|do|does|is|would|will|can|have)\b/i;
const YEAR_HOURS = 2080;
const POINTS = { min: 0, q1: 0.25, mid: 0.5, q3: 0.75, max: 1 };
const DOLLARS: Record<string, string> = { [US]: "USD", canada: "CAD" };
const SYMBOLS: Record<string, string> = { USD: "$", CAD: "$", AUD: "$", GBP: "£", EUR: "€" };

export interface PayTarget {
  amount: number;
  period: Pay["period"];
  currency: string;
}

const per = (amount: number, from: Pay["period"], to: Pay["period"]) =>
  from === to ? amount : from === "hour" ? amount * YEAR_HOURS : amount / YEAR_HOURS;
const rounded = (amount: number, period: Pay["period"]) =>
  period === "hour" ? Math.round(amount * 100) / 100 : Math.round(amount);

/**
 * The pay to answer: the profile's chosen point in the posting's lowest range in the profile's currency (else the
 * job country's, else any), never below the profile's lowest pay, which is the answer when no range is known.
 * shortcut: no exchange rates, so the lowest pay compares to another currency's range by number (fine for CAD vs
 * USD); a bare "$" is the job country's dollar, else the profile's currency.
 */
export function payTarget(
  c: Profile["preferences"]["desiredCompensation"],
  pays: Pay[],
  country?: string,
): PayTarget | null {
  const n = Number(c.amount.replace(/[^\d.]/g, "")) * (/\dk\b/i.test(c.amount) ? 1000 : 1);
  const currency = c.currency.trim().toUpperCase();
  const floor: PayTarget | null =
    n > 0 ? { amount: n, period: c.period || (n < 500 ? "hour" : "year"), currency } : null;
  if (!c.strategy || !pays.length) return floor;
  const local = (country && DOLLARS[country]) || "";
  const ranges = pays.map((p) => ({ ...p, currency: p.currency || local || currency }));
  const mine = [currency, local].map((cur) => ranges.filter((p) => cur && p.currency === cur)).find((r) => r.length);
  const [r] = (mine ?? ranges).sort((a, b) => per(a.min, a.period, "year") - per(b.min, b.period, "year"));
  const at = r.min + (r.max - r.min) * POINTS[c.strategy];
  if (floor && per(floor.amount, floor.period, r.period) > at) return floor;
  return { amount: at, period: r.period, currency: r.currency };
}

/**
 * Desired pay in a text or number box, in the period the question names, else the target's: "$85,000 CAD per year",
 * or digits for a number box or a bare-number example.
 */
function compensationDecision(f: FieldDescriptor, pay: PayTarget | null): Decision | null {
  if (!pay || !["text", "textarea", "number"].includes(f.kind)) return null;
  if (!RE_PAY_Q.test(f.label) || RE_NOT_DESIRED.test(f.label)) return null;
  const asked = `${f.label} ${f.hint ?? ""} ${f.placeholder ?? ""}`;
  const period = /\bhour(ly)?\b|\/\s?hr\b/i.test(asked)
    ? "hour"
    : /\b(annual(ly)?|yearly|per year|annum)\b/i.test(asked)
      ? "year"
      : pay.period;
  const amount = rounded(per(pay.amount, pay.period, period), period);
  const shown = amount.toLocaleString("en-US", { minimumFractionDigits: amount % 1 ? 2 : 0 });
  const text = [`${SYMBOLS[pay.currency] ?? ""}${shown}`, pay.currency, `per ${period}`].filter(Boolean).join(" ");
  const digits =
    f.kind === "number" ||
    /^\D{0,6}\d[\d,.]*$/.test(f.placeholder?.trim() ?? "") ||
    (f.maxLength ?? 1e9) < text.length ||
    // As the form says once it refuses the text (Avature: "Salary Requirements: Input should be numeric").
    /\b(numeric|numbers? only|digits only)\b/i.test(f.hint ?? "");
  return {
    fieldId: f.id,
    action: "fill",
    text: digits ? String(amount) : text,
    confidence: "high",
    sources: ["preferences.desiredCompensation"],
  };
}

/**
 * An age bracket ("18-20", "21-29", "60 or older") from the date of birth. Lever's "What is your age range?" got
 * "21-29" for a 20-year-old on Tala and Paytm.
 */
function ageDecision(f: FieldDescriptor, dob: string): Decision | null {
  if (!f.options || isMulti(f) || !dob || !/\bage (range|group|bracket)\b|\bhow old\b/i.test(f.label)) return null;
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = todayIso().split("-").map(Number);
  if (!y) return null;
  const age = ty - y - (tm < (m || 1) || (tm === (m || 1) && td < (d || 1)) ? 1 : 0);
  const hits = f.options.flatMap((o, i) => {
    const n = (o.match(/\d+/g) ?? []).map(Number);
    const [lo, hi] =
      n.length === 2
        ? n
        : n.length === 1 && /\b(or (younger|under|less)|under|below)\b/i.test(o)
          ? [0, /\bunder|below\b/i.test(o) ? n[0] - 1 : n[0]]
          : n.length === 1 && /\b(or (older|over|more)|over|above|\+)/i.test(o)
            ? [/\bover|above\b/i.test(o) ? n[0] + 1 : n[0], Infinity]
            : [NaN, NaN];
    return age >= lo && age <= hi ? [i] : [];
  });
  if (hits.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: hits,
    intendedAnswer: f.options[hits[0]],
    confidence: "high",
    sources: ["personal.dateOfBirth"],
  };
}

/**
 * A bare "Country" list (Greenhouse's phone country, "Canada +1") gets the candidate's country: the audit rejected
 * Robinhood's "Canada +1" as unsupported.
 */
function countryDecision(f: FieldDescriptor, home: string): Decision | null {
  const want = canonicalCountry(home);
  if (!f.options || isMulti(f) || !want || !/^country$/i.test(f.label.trim()) || RE_ENTRY_SECTION.test(f.section ?? ""))
    return null;
  const hits = f.options.flatMap((o, i) =>
    canonicalCountry(o.replace(/\s*\(?\+[\d\s-]+\)?$/, "")) === want ? [i] : [],
  );
  if (hits.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: hits,
    intendedAnswer: f.options[hits[0]],
    confidence: "high",
    sources: ["personal.address.country"],
  };
}

/**
 * A list of another country's states for a candidate living elsewhere takes its "Not Applicable" option: the audit
 * rejected it for NinjaOne's US "State" with a British Columbia address.
 */
function regionDecision(f: FieldDescriptor, address: Profile["personal"]["address"]): Decision | null {
  const bare = /^(state|province|state\s*(\/|or)\s*province)$/i.test(f.label.trim());
  // The home address's region in a list that loads as you type: Kinaxis's iCIMS one (address-level1) and John Deere's
  // bare "State / Province" got the job's.
  if (
    (f.kind === "dropdown" || f.kind === "typeahead") &&
    !f.optionsKnown &&
    (bare || /\baddress-level1$/i.test(f.autocomplete ?? "")) &&
    address.region &&
    !RE_ENTRY_SECTION.test(f.section ?? "")
  )
    return {
      fieldId: f.id,
      action: "fill",
      intendedAnswer: address.region,
      searchQuery: address.region,
      confidence: "high",
      sources: ["personal.address.region"],
    };
  const home = canonicalCountry(address.country);
  if (!f.options || isMulti(f) || !home || !bare || RE_ENTRY_SECTION.test(f.section ?? "")) return null;
  const regions = f.options.map(regionCountry).filter(Boolean);
  if (regions.length < 5 || regions.includes(home)) return null;
  const none = f.options.flatMap((o, i) =>
    /^(not applicable|n\/?a|none|other|outside\b|non-u\.?s\.?|international)/i.test(o.trim()) ? [i] : [],
  );
  if (none.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: none,
    intendedAnswer: f.options[none[0]],
    confidence: "high",
    sources: ["personal.address"],
  };
}

/**
 * Race/ethnicity options for the profile's: the same name, else the one option naming its last word ("East Asian" →
 * "Asian or Asian American"). The audit rejected that pick on Ashby's own survey.
 */
function raceDecision(f: FieldDescriptor, races: string[]): Decision | null {
  if (!f.options || !races.length || !/\b(race|racial|ethnicit)/i.test(f.label)) return null;
  const opts = f.options.map(normalize);
  const picks = races.map((r) => {
    const exact = opts.indexOf(normalize(r));
    if (exact >= 0) return exact;
    const word = normalize(r).split(" ").pop()!;
    const hits = opts.flatMap((o, i) => (o.split(" ").includes(word) && !/two or more|multi/.test(o) ? [i] : []));
    return hits.length === 1 ? hits[0] : -1;
  });
  if (picks.includes(-1) || (!isMulti(f) && picks.length !== 1)) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [...new Set(picks)],
    intendedAnswer: picks.map((i) => f.options![i]).join(", "),
    confidence: "high",
    sources: ["demographics.raceEthnicity"],
  };
}

/**
 * The man/woman option for the profile's male/female gender. The model flagged MongoDB's "Gender Identity" (Woman /
 * Man / Non Binary …) as unknown, and the guess then declined it. Not transgender or "same as at birth" questions.
 */
function genderDecision(f: FieldDescriptor, gender: string): Decision | null {
  const want = /^(male|man)$/i.test(gender)
    ? /^(male|man)\b/i
    : /^(female|woman)$/i.test(gender)
      ? /^(female|woman)\b/i
      : null;
  if (!want || !f.options || !/\bgender\b/i.test(f.label) || /\b(trans|cis)|\bsame as\b|\bassigned\b/i.test(f.label))
    return null;
  const hits = f.options.flatMap((o, i) => (want.test(o.trim()) ? [i] : []));
  if (hits.length !== 1) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: hits,
    intendedAnswer: f.options[hits[0]],
    confidence: "high",
    sources: ["demographics.gender"],
  };
}

const RE_AI = String.raw`\b(AI|artificial intelligence|ChatGPT|LLMs?|generative)\b`;
const RE_AI_USE = new RegExp(
  String.raw`\bI (have |will |did |do )?(not|never)\b[^?.]*\buse\b[^?.]*${RE_AI}|\b(did|have) you (use|used)\b[^?]*${RE_AI}` +
    // Clever: "we do not permit candidates to use generative AI ... to draft responses"; Attentive: "If you are an AI
    // Agent" (not LangChain's "Have you built AI agents?").
    String.raw`|\bnot (permit|allow)\w*\b[^?.]*\b(use|using)\b[^?.]*${RE_AI}|\b(are|you're) an? AI agent\b` +
    // Medium: "You confirm that ... no portion of the following responses were generated using the assistance of AI".
    String.raw`|\bgenerated\b[^?.]*\b(using|with|by)\b[^?.]*${RE_AI}` +
    // Calendly: "Was this application prepared or submitted in whole or in part by an AI system …?".
    String.raw`|\b(prepared|submitted|completed|written)\b[^?.]*\bby\b[^?.]*${RE_AI}`,
  "i",
);

/**
 * Questions about AI use or automation in the application itself are the user's to answer, never ours: Peloton's
 * "I have not, and I will not, use AI tools during the application" got "Yes"; Grafana asks "I am an AI or automated
 * program" / "I am a human being".
 */
function aiUseDecision(f: FieldDescriptor): Decision | null {
  // "I am an AI or automated program" / "I am a human being"; not StackAdapt's "I am an advanced AI user".
  const bot =
    f.options?.some((o) => /^(I am|I'm) (an? )?(AI|bot|automated)\b/i.test(o)) &&
    f.options.some((o) => /^(I am|I'm) (a )?human\b/i.test(o));
  return bot || RE_AI_USE.test(f.label)
    ? flag(f.id, "Asks about AI use in this application: answer it yourself")
    : null;
}

/**
 * A school email, or "I don't have a school email": the profile holds neither. Jane Street's "Your primary
 * college/university/school email" got the personal address, with "I don't have a school email" ticked too.
 */
const schoolEmailDecision = (f: FieldDescriptor): Decision | null =>
  /\b(school|university|college|student|\.?edu)\b[^?]*\be-?mail\b/i.test(f.label)
    ? flag(f.id, "Your school email isn't in your profile")
    : null;

/**
 * A take-home exercise's submission: only the candidate has it. Perplexity's required "Exercise Submission (Shared
 * URL)" got a résumé project's link, and the audit passed it.
 */
const exerciseDecision = (f: FieldDescriptor): Decision | null =>
  !f.options &&
  /\b(exercise|take[- ]home|assignment|coding challenge)\b/i.test(f.label) &&
  /\b(submission|submit|url|link)\b/i.test(f.label)
    ? flag(f.id, "Complete the exercise and add your submission")
    : null;

/** An interview-recording opt-in (AI notetakers, recorded interviews) answered from the profile's preference. */
const recordingDecision = (f: FieldDescriptor, consent: "yes" | "no" | ""): Decision | null =>
  consent && RE_INTERVIEW_RECORDING.test(`${f.label} ${f.hint ?? ""}`) ? optInDecision(f, consent) : null;

/** Consent to AI tools assessing the application (ADI's Yes/No), answered from the profile's preference. */
const aiReviewDecision = (f: FieldDescriptor, consent: "yes" | "no" | ""): Decision | null =>
  consent && isAiReview(`${f.label} ${f.hint ?? ""}`) ? optInDecision(f, consent) : null;

/**
 * An optional opt-in to hear about new job opportunities or marketing, answered from the profile's preference. Required
 * ones follow the consent settings. Not long answers stating facts (CI&T's "Yes, I live in Campinas …").
 */
function optInConsentDecision(f: FieldDescriptor, bg: Profile["background"]): Decision | null {
  if (f.required || f.options?.some((o) => o.split(/\s+/).length > 3)) return null;
  const consent = optInAnswer(`${f.label} ${f.hint ?? ""}`, bg);
  return consent ? optInDecision(f, consent) : null;
}

/** An opt-in box ticked per the preference, or the one choice that agrees (or declines) with it. */
function optInDecision(f: FieldDescriptor, consent: "yes" | "no"): Decision | null {
  const base = { fieldId: f.id, action: "fill" as const, confidence: "high" as const, sources: ["background"] };
  if (f.kind === "checkbox") return { ...base, checked: consent === "yes" };
  const re =
    consent === "yes" ? /^(yes\b|i (consent|agree|accept)|opt.?in)/i : /^(no\b|i (do not|don['’]t)|opt.?out|decline)/i;
  const hits = !f.options || isMulti(f) ? [] : f.options.flatMap((o, i) => (re.test(o) ? [i] : []));
  return hits.length === 1 ? { ...base, optionIndexes: hits, intendedAnswer: f.options![hits[0]] } : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SEASONS: [RegExp, number[]][] = [
  [/\bspring\b/i, [3, 4, 5]],
  [/\bsummer\b/i, [6, 7, 8]],
  [/\b(fall|autumn)\b/i, [9, 10, 11]],
  [/\bwinter\b/i, [12, 1, 2]],
];

/**
 * A year or month option picked for the profile date the model cites ("education.0.endDate" → "2028-05"), checked
 * against it: the model miscounts numeric lists, and Plaid's end year got "2025". Corrected to the right option, or
 * flagged when the list lacks it (Plaid's years stop at 2027).
 */
export function citedDateCheck(f: FieldDescriptor, d: Decision, profile: Profile): Decision {
  const i = d.optionIndexes?.[0];
  if (d.action !== "fill" || !f.options || i === undefined || d.optionIndexes!.length !== 1) return d;
  const dates = (d.sources ?? []).flatMap((s) => {
    let v: unknown = profile;
    for (const k of s
      .replace(/^profile\./, "")
      .split(/[.[\]]+/)
      .filter(Boolean))
      v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    return typeof v === "string" && /^\d{4}-\d\d/.test(v) ? [v] : [];
  });
  if (new Set(dates).size !== 1) return d;
  const [year, month] = dates[0].split("-").map(Number);
  const picked = f.options[i].trim();
  const isYear = /^(19|20)\d\d$/.test(picked);
  const monthOf = (o: string) => MONTHS.findIndex((m) => new RegExp(`^${m}[a-z]*\\.?$`, "i").test(o.trim())) + 1;
  if (isYear ? Number(picked) === year : !monthOf(picked) || monthOf(picked) === month) return d;
  const want = isYear ? String(year) : MONTHS[month - 1].replace(/^./, (c) => c.toUpperCase());
  let right = f.options.findIndex((o) => (isYear ? o.trim() === want : monthOf(o) === month));
  // Available from a start date on: the first month offered after it (xAI's April–June for a January start).
  if (right < 0 && !isYear && d.sources?.some((s) => /earliestStartDate$/.test(s)))
    right = f.options.reduce((best, o, j) => {
      const m = monthOf(o);
      return m > month && (best < 0 || m < monthOf(f.options![best])) ? j : best;
    }, -1);
  if (right < 0) return flag(f.id, `No option for ${want}`, want);
  return { ...d, optionIndexes: [right], intendedAnswer: f.options[right] };
}

/**
 * A date, month or year in a résumé section ("Employment": "Start date month"), from that entry: asked about the
 * month lists read apart from the section's company and title, the model skipped Lyft's required ones. A full date
 * ("Work Experience 1": "End Date") was left blank for want of a day the profile doesn't hold.
 */
function entryDateDecision(f: FieldDescriptor, profile: Profile): Decision | null {
  const sec = RE_ENTRY_SECTION.exec(f.section ?? "");
  const part = /^(start|end|from|to)(?: date)?(?: (month|year))?$/i.exec(f.label.trim());
  if (!sec || !part || isMulti(f)) return null;
  const edu = /education/i.test(sec[1]);
  const i = (Number(sec[2]) || 1) - 1;
  const job = edu ? undefined : profile.experience[i];
  const school = edu ? profile.education[i] : undefined;
  const end = /^(end|to)$/i.test(part[1]);
  const date = end
    ? job?.current
      ? ""
      : (job?.endDate ?? school?.endDate) || school?.expectedGraduation
    : (job ?? school)?.startDate;
  if (!date || !/^\d{4}-\d\d/.test(date)) return null;
  const [year, month] = date.split("-").map(Number);
  const isMonth = /month/i.test(part[2] ?? "");
  const base = {
    fieldId: f.id,
    action: "fill" as const,
    confidence: "high" as const,
    sources: [edu ? "education" : "experience"],
  };
  if (!part[2]) {
    if (f.options || !["date", "month", "text"].includes(f.kind)) return null;
    return { ...base, text: /^\d{4}-\d\d-\d\d$/.test(date) ? date : monthYear(year, month) };
  }
  // Text month formats vary ("01", "Jan", "1"): only a typed year is safe.
  if (!f.options) return isMonth ? null : { ...base, text: String(year) };
  const monthOf = (o: string) => MONTHS.findIndex((m) => new RegExp(`^${m}[a-z]*\\.?$`, "i").test(o.trim())) + 1;
  const hits = f.options.flatMap((o, k) =>
    (isMonth ? monthOf(o) === month || Number(o.trim()) === month : o.trim() === String(year)) ? [k] : [],
  );
  return hits.length === 1 ? { ...base, optionIndexes: hits, intendedAnswer: f.options[hits[0]] } : null;
}

/** A job's "Location" in its résumé section ("Work Experience 2"), from that entry: not the candidate's home. */
function entryLocationDecision(f: FieldDescriptor, experience: Profile["experience"]): Decision | null {
  const sec = RE_ENTRY_SECTION.exec(f.section ?? "");
  if (!sec || /education/i.test(sec[1]) || !/^location$/i.test(f.label.trim())) return null;
  const where = experience[(Number(sec[2]) || 1) - 1]?.location;
  if (!where || (f.kind !== "text" && f.kind !== "textarea")) return null;
  return { fieldId: f.id, action: "fill", text: where, confidence: "high", sources: ["experience"] };
}

// "When do you expect to complete your degree program?" asks for the graduation date too.
const RE_GRADUATION = /graduat|\b(complet|finish)\w*\b[^?]{0,25}\bdegree\b|\bdegree (completion|end)\b/i;

/**
 * A graduation date among options, matched by year and month or season ("2028-05" → "Spring/Summer 2028"). The
 * model picked "Other" for Lyft's "anticipated graduation month and year?" with the note "Graduation is May 2028".
 * High school by its year alone (Akuna's 2024 got "Earlier than the above options" beside "Spring/Summer 2024"); a
 * master's or PhD the profile doesn't plan stays with the model (Akuna's got the bachelor's date).
 */
function graduationDecision(f: FieldDescriptor, profile: Profile): Decision | null {
  const school = /high school|secondary/i.test(f.label);
  const when = profile.education.find((e) => e.expectedGraduation || e.endDate);
  const date = school ? profile.highSchool.graduationYear : when?.expectedGraduation || when?.endDate;
  if (isMulti(f) || !RE_GRADUATION.test(f.label) || !date) return null;
  if (!school && /\b(master|ph\.?\s?d|doctora|mba)/i.test(f.label)) return null;
  const [year, month] = date.split("-").map(Number);
  if (!f.options) {
    const d = school || !month ? null : graduationText(f, year, month);
    // Asked with the major (John Deere: "please indicate your major AND your anticipated graduation date"), which
    // was left out ("May 2028").
    if (d?.text && when?.major && /\bmajor\b|\bfield of study\b/i.test(f.label)) d.text = `${when.major}, ${d.text}`;
    return d;
  }
  // "Did You Graduate?" in an education entry (iCIMS), from that entry: flash-lite answered Yes, then No, for a May
  // 2028 graduate.
  const entry = /^education(?: \(?(\d+)\)?)?$/i.exec(f.section ?? "");
  if (entry && /^did you graduate\??$/i.test(f.label.trim())) {
    const e = profile.education[(Number(entry[1]) || 1) - 1];
    const end = (e?.endDate || e?.expectedGraduation || "").split("-").map(Number);
    const [ty, tm] = todayIso().split("-").map(Number);
    return end[0] ? yesNoAnswer(f, end[0] * 12 + (end[1] || 12) <= ty * 12 + tm) : null;
  }
  if (f.options.some((o) => /^yes\W*$/i.test(o.trim()))) return school ? null : graduatingSoonDecision(f, year, month);
  const hits = f.options.flatMap((o, i) => {
    if (!new RegExp(`\\b${year}\\b`).test(o)) return [];
    const names = MONTHS.filter((m) => new RegExp(`\\b${m}`, "i").test(o));
    const seasons = SEASONS.filter(([re]) => re.test(o));
    if (!month || (!names.length && !seasons.length)) return [i];
    return names.includes(MONTHS[month - 1]) || seasons.some(([, ms]) => ms.includes(month)) ? [i] : [];
  });
  if (hits.length !== 1) return null;
  const i = hits[0];
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options[i],
    confidence: "high",
    sources: [school ? "highSchool" : "education"],
  };
}

/**
 * "Are you graduating in the next 6-12 months or recently graduated?" (Yes/No), against the graduation month: HeyGen's
 * got "Yes" for a May 2028 graduate in October 2026. Also "graduating in 2027?" and "graduated by June 2027?".
 */
function graduatingSoonDecision(f: FieldDescriptor, year: number, month = 12): Decision | null {
  const [ty, tm] = todayIso().split("-").map(Number);
  const away = (year - ty) * 12 + month - tm;
  const win = /\b(?:next|within(?: the next)?)\s+(\d+)(?:\s*(?:-|–|to)\s*(\d+))?\s*(month|year)s?\b/i.exec(f.label);
  const by = /\bby (?:([a-z]{3,9})\.? )?(\d{4})\b/i.exec(f.label);
  const inYear = /\bin (\d{4})\b/.exec(f.label);
  let yes: boolean;
  if (win) yes = away >= 0 && away <= Number(win[2] ?? win[1]) * (/year/i.test(win[3]) ? 12 : 1);
  else if (/\b(next|this) year\b/i.test(f.label)) yes = away >= 0 && year <= ty + (/next/i.test(f.label) ? 1 : 0);
  else if (by) {
    const m = by[1] ? MONTHS.indexOf(by[1].slice(0, 3).toLowerCase()) + 1 : 12;
    if (!m) return null;
    yes = year * 12 + month <= Number(by[2]) * 12 + m;
  } else if (inYear) yes = Number(inYear[1]) === year;
  else return null;
  return yesNoAnswer(f, yes);
}

function yesNoAnswer(f: FieldDescriptor, yes: boolean): Decision | null {
  const i = f.options!.findIndex((o) => (yes ? /^yes\W*$/i : /^no\W*$/i).test(o.trim()));
  if (i < 0) return null;
  return {
    fieldId: f.id,
    action: "fill",
    optionIndexes: [i],
    intendedAnswer: f.options![i],
    confidence: "high",
    sources: ["education"],
  };
}

/**
 * A profile month as text ("May 2028"): asked for a full date, the fill writes it in the input's format on the 1st
 * ("05/01/2028", "2028-05-01").
 */
const monthYear = (year: number, month: number) =>
  new Date(Date.UTC(year, month - 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** A typed graduation date. Asked for a full date, the model left it blank: the profile holds only the month. */
function graduationText(f: FieldDescriptor, year: number, month: number): Decision | null {
  const typed = f.kind === "date" || f.kind === "month";
  if (!typed && (f.kind !== "text" || !/\b(date|when|month|year|term)\b/i.test(f.label))) return null;
  // Also a date's own year box (iCIMS's "Graduation Date Year"): "May 2028" cut to its 4 characters was "May".
  const yearOnly =
    !typed &&
    /\byear\b/i.test(f.label) &&
    (!/\b(date|month|term)\b/i.test(f.label) || (/\byear$/i.test(f.label.trim()) && !/\bmonth\b/i.test(f.label)));
  const text = yearOnly ? String(year) : monthYear(year, month);
  return { fieldId: f.id, action: "fill", text, confidence: "high", sources: ["education"] };
}

/**
 * The label, with the hint when the label points at it: Waymo's "export license under the circumstances described
 * below?" was rejected without them. Other hints stay out, since any change to the payload reshuffles verdicts.
 */
function auditQuestion(f: FieldDescriptor): string {
  return f.hint && /\b(described|listed|stated|outlined) (below|above)\b/i.test(f.label)
    ? `${f.label} ${f.hint}`
    : f.label;
}

/**
 * One office or term picked from a list the profile accepts every place or every fitting term of: the audit rejected
 * MongoDB's "San Francisco, CA" and Verkada's "Summer 2027" as unstated preferences for a candidate open to anywhere
 * and to any term.
 */
function openChoice(f: FieldDescriptor, answer: string, profile: Profile): boolean {
  if (!f.options || isMulti(f) || !f.options.includes(answer)) return false;
  const p = profile.preferences;
  const anywhere = /^(any(where)?)?$/i.test(p.relocationNotes.trim()) && p.preferredLocations.includes("Any");
  if (p.willingToRelocate === "yes" && anywhere && f.options.every((o) => jobCountry(o))) return true;
  return termFits(answer, profile) === true && f.options.every((o) => termFits(o, profile) !== null);
}

/**
 * A second look at the AI's fills, judged against the candidate's data alone: it also catches guesses citing an
 * unrelated profile section ("active funding?" → "No", cited to education). Fails open: the fills stand.
 */
async function auditFills(
  ctx: ServiceCtx,
  fields: FieldDescriptor[],
  base: ReturnType<typeof mappingPayloadBase>,
  decisions: Decision[],
  profile: Profile,
): Promise<Decision[]> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const items = decisions.flatMap((d) => {
    const f = byId.get(d.fieldId);
    const answer = f && suggestionOf(d, f);
    return d.action === "fill" &&
      f &&
      !needsNoSource(f) &&
      !workAuthAnswer(f, answer ?? "") &&
      !heardOther(f, answer ?? "") &&
      !openChoice(f, answer ?? "", profile) &&
      d.text !== NOT_APPLICABLE &&
      // An unticked box claims nothing (Airbnb's "I decline to answer the following questions.").
      !(f.kind === "checkbox" && d.checked === false)
      ? [{ fieldId: f.id, question: auditQuestion(f), answer: answer ?? "" }]
      : [];
  });
  if (!items.length) return decisions;
  try {
    const { profile, resume, learnedAnswers, job, today } = base;
    const r = await ctx.ai.call(
      {
        system: AUDIT_PROMPT,
        context: { profile, resume },
        payload: { learnedAnswers, job, today, items },
        schema: AUDIT_SCHEMA,
        validate: (d) => AuditZ.parse(d),
        timeoutMs: ctx.settings.requestTimeoutMs,
        signal: ctx.signal,
      },
      { model: ctx.model, fallback: ctx.fallback },
    );
    const unsupported = new Set(r.data.verdicts.filter((v) => !v.supported).map((v) => v.fieldId));
    return decisions.map((d) =>
      d.action === "fill" && unsupported.has(d.fieldId) ? flag(d.fieldId, NOT_IN_PROFILE) : d,
    );
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return decisions;
  }
}

/** Validates AI decisions against what was sent (§10.8.1, §18.3). */
export function validateDecisions(fields: FieldDescriptor[], raw: RawDecision[]): Decision[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const out = new Map<string, Decision>();
  for (const r of raw) {
    const f = byId.get(r.fieldId);
    if (!f || out.has(r.fieldId)) continue;
    let d: Decision = { ...r };
    // A search alone names the answer (Squarespace's school list: searchQuery "University of British Columbia").
    if (d.action === "fill" && !d.text && !d.intendedAnswer && !d.optionIndexes?.length && d.searchQuery)
      d.intendedAnswer = d.searchQuery;
    if (d.action === "fill" && CHOICE_KINDS.has(f.kind) && f.optionsKnown && f.options?.length) {
      // The option the model names beats its index, which it gets wrong in numeric lists (meant 2028, sent "2: 2024").
      const said = d.intendedAnswer && !isMulti(f) ? normalize(d.intendedAnswer) : "";
      const named = said ? f.options.findIndex((o) => normalize(o) === said) : -1;
      if (named >= 0) d.optionIndexes = [named];
      const idx = d.optionIndexes;
      // A year no option offers: Plaid's graduation years stop at 2027; the model meant 2028, sent "0: 2027".
      const year = named < 0 && /^(19|20)\d\d$/.test(said) && idx?.length === 1;
      if (year && !(f.options[idx[0]] ?? "").includes(said)) {
        d = flag(f.id, `No option for ${said}`, said);
      } else if (!idx?.length) {
        if (!(f.kind === "dropdown" && d.intendedAnswer)) d = flag(f.id, "No option chosen", suggestionOf(r, f));
      } else if (idx.some((i) => !Number.isInteger(i) || i < 0 || i >= f.options!.length)) {
        d = flag(f.id, "AI chose an invalid option", d.intendedAnswer);
      } else if (!isMulti(f) && idx.length > 1) {
        d.optionIndexes = [idx[0]];
      }
    }
    // A required follow-up that doesn't apply takes "N/A" (Binance: "If less than 40 hours/week, please state how
    // many…" for a full-time candidate). Any other required field left blank blocks the application: the user must see it.
    if (
      d.action === "skip" &&
      f.required &&
      (f.kind === "text" || f.kind === "textarea") &&
      /^if\b/i.test(f.label.trim())
    )
      d = { ...d, action: "fill", text: NOT_APPLICABLE };
    else if (d.action === "skip" && f.required) d = flag(f.id, r.note || "Required field", suggestionOf(r, f));
    if (d.action === "fill" && d.confidence === "low") d = flag(f.id, r.note || "Low confidence", suggestionOf(r, f));
    if (d.action === "flag" && !d.suggestion && r.action !== "flag") d.suggestion = suggestionOf(r, f);
    // No suggestion either: it would only be the guess.
    if (guessed(d, f)) d = flag(f.id, NOT_IN_PROFILE);
    out.set(f.id, d);
  }
  return fields.map((f) => out.get(f.id) ?? flag(f.id, "No AI decision"));
}

/**
 * YOLO: every field still flagged gets the answer most likely to win an interview, in one call that sees why each
 * was flagged and any earlier guess. Profile-derived guards still run on the result (mapFields). Uploads stay as
 * they are: the content script resolves those. Fails open: the flags stand.
 */
async function guessFlagged(
  ctx: ServiceCtx,
  fields: FieldDescriptor[],
  decisions: Decision[],
  base: ReturnType<typeof mappingPayloadBase>,
  sent: (f: FieldDescriptor) => object,
): Promise<Decision[]> {
  // What blocks submitting, and optional single-choice questions a recruiter may screen on ("Where did you first hear
  // about this position?"). Optional boxes and text stay empty rather than guessed (an opt-in ticked "to be safe").
  // A choice whose options read blank can't be guessed, only gambled: "1" for "a citizen of Iran or Cuba?".
  const flagged = fields.filter(
    (f, i) =>
      decisions[i].action === "flag" &&
      !aiUseDecision(f) &&
      !trapLabel(f.label) &&
      !decisions[i].sources?.includes(SCREENING_SOURCE) &&
      (f.required || (SINGLE_CHOICE.has(f.kind) && !needsNoSource(f))) &&
      f.kind !== "file" &&
      !(f.options?.length && f.options.every((o) => !o.trim())),
  );
  if (!flagged.length) return decisions;
  const why = new Map(decisions.map((d) => [d.fieldId, d]));
  const { profile, resume, ...rest } = base;
  try {
    const r = await ctx.ai.call(
      {
        system: BEST_GUESS_PROMPT,
        context: { profile, resume },
        payload: {
          ...rest,
          fields: flagged.map((f) => ({
            ...sent(f),
            whyUnanswered: why.get(f.id)?.note,
            earlierGuess: why.get(f.id)?.suggestion,
          })),
        },
        schema: MAPPING_SCHEMA,
        validate: (d) => MappingZ.parse(d),
        timeoutMs: ctx.settings.requestTimeoutMs,
        signal: ctx.signal,
      },
      { model: ctx.model, fallback: ctx.fallback },
    );
    // A made-up answer that reads as an AI's ("As an AI, I…") stays unanswered; its em dashes are typed as a person does.
    const raw = r.data.decisions
      .filter((d) => !(d.text && RE_AI_TELL.test(d.text)))
      .map((d) => ({
        ...d,
        ...(d.text ? { text: plainDashes(d.text) } : {}),
        confidence: "medium" as const,
        sources: [GUESS],
      }));
    const guesses = new Map(validateDecisions(flagged, raw).map((d) => [d.fieldId, d]));
    return decisions.map((d) => {
      const g = guesses.get(d.fieldId);
      return g && g.action !== "flag" ? g : d;
    });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return decisions;
  }
}

export interface MapInput {
  fields: FieldDescriptor[];
  profile: Profile;
  documents: DocumentMeta[];
  job: JobContext | null;
  /** Pay ranges of the posting the application is for, which may be on an earlier page. */
  pays?: Pay[];
  /** YOLO mode: nothing is left for the user, so unanswered fields get a best guess (guessFlagged). */
  yolo?: boolean;
  /** Labels of the page's upload boxes, so no answer claims a document went in that had nowhere to go. */
  uploads?: string[];
}

// The model miscounts positions in long lists (picked "Cape Verde +238", the option after "Canada +1"),
// so each option carries its index for the model to read back.
export const numbered = (options: string[]) => options.map((o, i) => `${i}: ${o}`);

/** The profile without what only essays use: tone, emphasis, things to avoid and the (often long) cover letter template. */
export const withoutEssayStyle = <P extends Pick<Profile, "essayGuidance">>(p: P) => ({
  ...p,
  essayGuidance: { aboutMe: p.essayGuidance.aboutMe, careerGoals: p.essayGuidance.careerGoals },
});

export function mappingPayloadBase(input: Omit<MapInput, "fields">, pay: PayTarget | null = null) {
  const { resumeText, learnedAnswers, ...rest } = input.profile;
  // The model gets the pay to answer for this job, not the rule for choosing it.
  const { strategy: _, ...comp } = rest.preferences.desiredCompensation;
  const desiredCompensation = pay
    ? { ...comp, amount: String(rounded(pay.amount, pay.period)), period: pay.period, currency: pay.currency }
    : comp;
  return {
    profile:
      compactProfile(withoutEssayStyle({ ...rest, preferences: { ...rest.preferences, desiredCompensation } })) ?? {},
    resume: resumeText.slice(0, 12000),
    learnedAnswers: [...learnedAnswers]
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, 100)
      // Recency picks which 100; createdAt orders them so the prompt doesn't reshuffle after every fill.
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((l) => ({ q: l.question, a: l.answer })),
    documents: input.documents.map(({ id, label, kind }) => ({ id, label, kind })),
    job: compactProfile({
      company: input.job?.company,
      title: input.job?.jobTitle,
      url: input.job?.url,
      location: input.job?.location,
      descriptionExcerpt: input.job?.text.slice(0, 3000) || input.job?.header,
    }),
    today: todayIso(),
  };
}

/** The first pass's local policies, shared with review corrections without making another AI request. */
export function localDecisions(input: MapInput): Map<string, Decision> {
  const home = input.profile.personal.address.country;
  const job = input.job?.location ? jobCountry(input.job.location) : undefined;
  const pay = payTarget(input.profile.preferences.desiredCompensation, input.pays ?? [], job);
  const countries = new Map(input.fields.map((f) => [f.id, workCountry(f.label, home, job)]));
  const months = experienceMonths(input.profile.experience);
  const jobExperienceMinimum = hasExperienceMinimum(input.job?.text || input.job?.header || "");
  // "Years of experience (excluding internships)": EA's got "Between 1 and 2 Years" for internships alone.
  const fullTime = experienceMonths(
    input.profile.experience.filter((e) => !/\b(intern(ship)?|co-?op)\b/i.test(`${e.employmentType} ${e.title}`)),
  );
  const local = new Map<string, Decision>();
  for (const f of input.fields) {
    const excluding = /\b(excluding|not including|other than|besides)\b[^?]*\b(internships?|co-?ops?)\b/i.test(f.label);
    const d =
      aiUseDecision(f) ??
      aiReviewDecision(f, input.profile.background.consentToAiReview) ??
      optInConsentDecision(f, input.profile.background) ??
      schoolEmailDecision(f) ??
      exerciseDecision(f) ??
      clearanceDecision(f, job, input.profile) ??
      currentStatusDecision(f, countries.get(f.id), input.profile.workAuthorization.entries) ??
      workAuthDecision(f, countries.get(f.id), input.profile.workAuthorization.entries) ??
      needsSponsorshipDecision(f, countries.get(f.id), input.profile.workAuthorization.entries) ??
      nationalityDecision(f, countries.get(f.id), input.profile.workAuthorization.entries) ??
      screeningDecision(f, input.profile, input.job) ??
      experienceDecision(f, excluding ? fullTime : months, jobExperienceMinimum) ??
      graduationDecision(f, input.profile) ??
      currentStudentDecision(f, input.profile.education) ??
      entryDateDecision(f, input.profile) ??
      entryLocationDecision(f, input.profile.experience) ??
      recordingDecision(f, input.profile.background.consentToInterviewRecording) ??
      heardDecision(f, input.profile.referral.howDidYouHearDefault, input.job?.company) ??
      officeDecision(f, input.profile.preferences) ??
      relocationDecision(f, input.profile.preferences, input.profile.personal.address) ??
      timezoneDecision(f, input.profile.personal.address) ??
      obtainedEducationDecision(f, input.profile) ??
      basicsDecision(f, input.profile) ??
      languagesDecision(f, input.profile) ??
      skillsDecision(f, input.profile) ??
      internshipsDecision(f, input.profile.experience) ??
      pronunciationDecision(f, input.profile.personal) ??
      attachedDecision(f, input.uploads) ??
      cohortDecision(f, input.profile.preferences) ??
      termsDecision(f, input.profile) ??
      termLengthsDecision(f, input.profile.coop) ??
      relocateAllDecision(f, input.profile.preferences) ??
      gpaDecision(f, input.profile.education) ??
      returnOfferDecision(f, input.profile) ??
      startOnDecision(f, input.profile.preferences) ??
      startDecision(f, input.profile.preferences.earliestStartDate) ??
      durationDecision(f, input.profile.preferences) ??
      compensationDecision(f, pay) ??
      ageDecision(f, input.profile.personal.dateOfBirth) ??
      citizenDecision(f, input.profile.workAuthorization) ??
      roleCountryDecision(f, job) ??
      appliedOfficeDecision(f, input.job?.location, input.profile.preferences) ??
      countryDecision(f, home) ??
      regionDecision(f, input.profile.personal.address) ??
      raceDecision(f, input.profile.demographics.raceEthnicity) ??
      genderDecision(f, input.profile.demographics.gender) ??
      currentCompanyDecision(f, input.profile.experience) ??
      otherSchoolDecision(f, input.profile.education) ??
      notWorkingDecision(f, input.profile.experience) ??
      contactEmployerDecision(f, input.profile.experience) ??
      statusDecision(f, input.profile.workAuthorization.entries) ??
      otherStatusDecision(f, input.fields, local, countries, input.profile.workAuthorization.entries);
    if (d) local.set(f.id, d);
  }
  return local;
}

export async function mapFields(
  ctx: ServiceCtx,
  input: MapInput,
): Promise<{ decisions: Decision[]; usedModel: string }> {
  const home = input.profile.personal.address.country;
  const job = input.job?.location ? jobCountry(input.job.location) : undefined;
  const pay = payTarget(input.profile.preferences.desiredCompensation, input.pays ?? [], job);
  const base = mappingPayloadBase(input, pay);
  const countries = new Map(input.fields.map((f) => [f.id, workCountry(f.label, home, job)]));
  const local = localDecisions(input);
  // A follow-up to a question answered here: the model can't see that answer (Etched's "If you answered other:" was
  // skipped after work authorization got "Other (please explain below)").
  const answeredBefore = new Map<string, string>();
  input.fields.forEach((f, i) => {
    const prev = input.fields[i - 1];
    const d = prev && local.get(prev.id);
    const answer = d?.action === "fill" ? suggestionOf(d, prev) : undefined;
    if (answer && f.hint?.startsWith("Follow-up to the previous question"))
      answeredBefore.set(f.id, `${f.hint}. The candidate answered it: "${answer}".`);
  });
  const sent = (f: FieldDescriptor) => {
    const country = countries.get(f.id);
    const hint = answeredBefore.get(f.id);
    return {
      ...f,
      ...(hint ? { hint } : {}),
      ...(f.options ? { options: numbered(f.options) } : {}),
      ...(country ? { workCountry: country } : {}),
    };
  };
  let usedModel = ctx.model;
  // Fields last: everything before them is the same in each of a fill's calls, which prompt caches reuse.
  const { profile, resume, ...rest } = base;

  async function runChunk(chunk: FieldDescriptor[], retried = false): Promise<Decision[]> {
    try {
      const r = await ctx.ai.call(
        {
          system: MAP_FIELDS_PROMPT,
          context: { profile, resume },
          payload: { ...rest, fields: chunk.map(sent) },
          schema: MAPPING_SCHEMA,
          validate: (d) => MappingZ.parse(d),
          timeoutMs: ctx.settings.requestTimeoutMs,
          signal: ctx.signal,
        },
        { model: ctx.model, fallback: ctx.fallback },
      );
      if (r.usedModel !== ctx.model) usedModel = r.usedModel;
      const decisions = validateDecisions(chunk, r.data.decisions);
      // The model sometimes drops fields from long batches; ask once more for just those.
      const answered = new Set(r.data.decisions.map((d) => d.fieldId));
      const missing = chunk.filter((f) => !answered.has(f.id));
      if (!missing.length || retried) return decisions;
      const again = new Map((await runChunk(missing, true)).map((d) => [d.fieldId, d]));
      return decisions.map((d) => again.get(d.fieldId) ?? d);
    } catch (e) {
      if (!(e instanceof BadOutputError || e instanceof BlockedError)) throw e;
      if (chunk.length > 1) {
        const mid = Math.ceil(chunk.length / 2);
        return (
          await Promise.all([runChunk(chunk.slice(0, mid), retried), runChunk(chunk.slice(mid), retried)])
        ).flat();
      }
      if (e instanceof BadOutputError && !retried) return runChunk(chunk, true);
      return [flag(chunk[0].id, e instanceof BlockedError ? "AI declined this field" : "AI response was invalid")];
    }
  }

  const asked = input.fields.filter((f) => !local.has(f.id));
  // Even chunks: the slowest one sets the wait, so no 6/6/6/2.
  const size = Math.ceil(asked.length / Math.ceil(asked.length / ctx.settings.maxFieldsPerRequest));
  const chunks: FieldDescriptor[][] = [];
  for (const f of asked) {
    const last = chunks.at(-1);
    // A follow-up stays with the question it follows: "If yes, what country?" needs that answer.
    if (last && (last.length < size || f.hint?.startsWith("Follow-up to the previous question"))) last.push(f);
    else chunks.push([f]);
  }
  // Each chunk is audited as soon as it is mapped, not after the slowest chunk.
  const audited = await Promise.all(
    chunks.map(async (c) => {
      const withCountry = c.map((f) => ({ ...f, workCountry: countries.get(f.id) }));
      return auditFills(ctx, withCountry, base, await runChunk(c), input.profile);
    }),
  );
  const answered = new Map(audited.flat().map((d) => [d.fieldId, d]));
  const entries = input.profile.workAuthorization.entries;
  let all = input.fields.map((f) => local.get(f.id) ?? answered.get(f.id)!);
  if (input.yolo) all = await guessFlagged(ctx, input.fields, all, base, sent);
  return {
    decisions: input.fields.map((f, i) => {
      const d = all[i];
      const answer = d.action === "fill" ? (suggestionOf(d, f) ?? "") : "";
      if (deniesNeededSponsorship(f, answer, countries.get(f.id), entries))
        return flag(f.id, "Sponsorship needed in this country", answer);
      if (wrongSiteLink(f.label, answer, d.sources)) return flag(f.id, NOT_IN_PROFILE, answer);
      return citedDateCheck(f, d, input.profile);
    }),
    usedModel,
  };
}
