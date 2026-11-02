// §13.2 deterministic matching: autocomplete tokens, unambiguous label regexes, learned answers.
import { AUTOCOMPLETE_MAP, LABEL_RULES, RE_ENTRY_SECTION, type DetKey } from "../../shared/constants";
import { digitsOnly, normalize } from "../../shared/normalize";
import type { DeterministicProfile, FieldDescriptor, FieldKind } from "../../shared/types";

const TEXT_KINDS = new Set<FieldKind>(["text", "email", "tel", "url", "number", "date", "month"]);
const FREE_TEXT = new Set<FieldKind>([...TEXT_KINDS, "textarea", "contenteditable", "typeahead"]);
const CHOICE = new Set<FieldKind>(["select", "multiselect", "radio_group", "checkbox_group", "dropdown", "checkbox"]);

const PATHS: Record<DetKey, string> = {
  fullName: "personal.firstName + lastName",
  legalName: "personal.firstName + middleName + lastName",
  firstName: "personal.firstName",
  middleName: "personal.middleName",
  lastName: "personal.lastName",
  preferredName: "personal.preferredName",
  pronouns: "personal.pronouns",
  email: "personal.email",
  phone: "personal.phone",
  phoneNational: "personal.phone.number",
  phoneCountryCode: "personal.phone.countryCode",
  phoneExtension: "personal.phone.extension",
  streetAddress: "personal.address.line1 + line2",
  line1: "personal.address.line1",
  line2: "personal.address.line2",
  city: "personal.address.city",
  region: "personal.address.region",
  postalCode: "personal.address.postalCode",
  country: "personal.address.country",
  countryCode: "personal.address.countryCode",
  location: "personal.address.city + region + country",
  url: "personal.links",
  linkedin: "personal.links.linkedin",
  github: "personal.links.github",
  portfolio: "personal.links.portfolio",
  dateOfBirth: "personal.dateOfBirth",
};

/** Format digits into a placeholder such as "(555) 555-5555" or "###-###-####". */
export function formatPhone(number: string, placeholder?: string): string {
  const d = digitsOnly(number);
  // An international example ("+47 40 61 23 45", Teamtailor) holds another country's code, not a template.
  if (placeholder?.trim().startsWith("+")) return number;
  const slots = placeholder ? (placeholder.match(/[#\dXx_]/g) ?? []).length : 0;
  if (!placeholder || slots < 7 || !/[\s()\-.]/.test(placeholder)) return number;
  const digits = d.length > slots && d.startsWith("1") ? d.slice(1) : d;
  if (digits.length !== slots) return number;
  let i = 0;
  return placeholder.replace(/[#\dXx_]/g, () => digits[i++]);
}

const RE_BARE_ADDRESS = /^((home|mailing|street|residential|current|permanent) )?address$/i;
/** A form's own city box, for telling what its bare "Address" asks. */
export const RE_CITY_FIELD = /^((current|home) )?(city|town)(\/town)?$/i;
const PLACES = new Set<DetKey>(["location", "city", "region", "postalCode", "streetAddress", "line1", "line2"]);

function keyFor(d: FieldDescriptor): DetKey | null {
  const tokens = (d.autocomplete ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const ac = AUTOCOMPLETE_MAP[tokens[tokens.length - 1] ?? ""];
  if (ac) return ac === "dateOfBirth" && !/birth/i.test(d.label) ? null : ac;
  // A conditional question ("If located in the US, in what city and state…") may not apply: the AI decides.
  if (/^if\b/i.test(d.label)) return null;
  const keys = new Set(LABEL_RULES.filter(([re]) => re.test(d.label)).map(([, k]) => k));
  return keys.size === 1 ? [...keys][0] : null;
}

const NAMES = new Set<DetKey>(["fullName", "legalName", "firstName", "middleName", "lastName", "preferredName"]);

/**
 * The profile's name in capitals, as a site's résumé parser wrote it: Workday's "Autofill with Resume" reads a small-caps
 * heading as "BRADLEY". Not someone's answer, so it is filled; a different name stays.
 */
export function shoutedName(d: FieldDescriptor, p: DeterministicProfile["personal"]): boolean {
  const shown = d.currentValue?.trim();
  if (!shown || shown !== shown.toUpperCase() || shown === shown.toLowerCase()) return false;
  const key = keyFor(d);
  if (!key || !NAMES.has(key)) return false;
  const value = deterministicValue(d, p)?.value.trim();
  return !!value && value !== shown && normalize(value) === normalize(shown);
}

export interface DetResult {
  value: string;
  path: string;
  /** Typeaheads: what to type to find `value` among the suggestions. */
  query?: string;
}

/**
 * `cityField`: the form asks the city in a field of its own, so a bare "Address" is the street: JazzHR's got the whole
 * address beside its City, Province and Postal code boxes. Elsewhere the AI decides.
 */
export function deterministicValue(
  d: FieldDescriptor,
  p: DeterministicProfile["personal"],
  cityField = false,
): DetResult | null {
  // Typeaheads, and remote-search dropdowns (Greenhouse's "Location (City)"), list places to search.
  const typeahead = d.kind === "typeahead" || (d.kind === "dropdown" && !d.optionsKnown);
  if (!TEXT_KINDS.has(d.kind) && !typeahead) return null;
  const key = keyFor(d) ?? (cityField && RE_BARE_ADDRESS.test(d.label) ? "streetAddress" : null);
  if (!key) return null;
  // An entry's own place is the job's or school's, not home: Workday's "Work Experience 1" Location got the home city
  // for a Vancouver job. The AI fills it from the entry.
  if (PLACES.has(key) && RE_ENTRY_SECTION.test(d.section ?? "")) return null;
  // A city/location typeahead lists places ("Langley, BC, Canada"): the AI mixed up the résumé's city for it.
  if (typeahead && key !== "city" && key !== "location") return null;
  if (d.kind === "email" && key !== "email") return null;
  if (d.kind === "tel" && !key.startsWith("phone")) return null;
  const a = p.address;
  const l = p.links;
  const join = (...xs: string[]) => xs.filter(Boolean).join(" ");
  const values: Record<DetKey, () => string> = {
    fullName: () => join(p.firstName, p.lastName),
    legalName: () => join(p.firstName, p.middleName, p.lastName),
    firstName: () => p.firstName,
    middleName: () => p.middleName,
    lastName: () => p.lastName,
    preferredName: () => p.preferredName || p.firstName,
    pronouns: () => p.pronouns,
    email: () => p.email,
    phone: () => {
      const n = p.phone.number;
      if (!n) return "";
      const formatted = formatPhone(n, d.placeholder);
      if (formatted !== n) return formatted;
      // Most forms reject or misread "+1 …"; add the code only when the box shows one ("+47 …" example, seeded "+31").
      const intl = /^\s*\+/.test(d.placeholder ?? "") || /^\s*\+/.test(d.currentValue ?? "");
      return intl ? join(p.phone.countryCode, n) : n;
    },
    phoneNational: () => p.phone.number,
    phoneCountryCode: () => p.phone.countryCode,
    // The profile has no extension: an optional box is skipped, a required one asks the user.
    phoneExtension: () => "",
    streetAddress: () => [a.line1, a.line2].filter(Boolean).join(", "),
    line1: () => a.line1,
    line2: () => a.line2,
    // LaunchDarkly: "Where is your permanent (City, Country) work location?" got "Langley".
    city: () => (/\bcountry\b/i.test(d.label) ? [a.city, a.country].filter(Boolean).join(", ") : a.city),
    region: () => (d.maxLength && d.maxLength <= 3 ? a.regionCode : a.region) || a.region,
    postalCode: () => a.postalCode,
    country: () => a.country,
    countryCode: () => a.countryCode,
    location: () => [a.city, a.region, a.country].filter(Boolean).join(", "),
    url: () => l.portfolio || l.website || l.linkedin,
    linkedin: () => l.linkedin,
    github: () => l.github,
    portfolio: () => l.portfolio || l.website,
    dateOfBirth: () => p.dateOfBirth,
  };
  // An empty value still returns: the field is recognized but unset in the profile, so it needs the user, not the AI.
  if (typeahead) return a.city ? { value: values.location(), path: PATHS.location, query: a.city } : null;
  return { value: values[key]().trim(), path: PATHS[key] };
}

const compatible = (a: FieldKind, b: FieldKind) =>
  a === b || (FREE_TEXT.has(a) && FREE_TEXT.has(b)) || (CHOICE.has(a) && CHOICE.has(b));

export function matchLearned(d: FieldDescriptor, learned: DeterministicProfile["learnedAnswers"]) {
  const q = normalize(d.label);
  if (!q) return null;
  return learned.find((l) => l.normalizedQuestion === q && compatible(l.kind, d.kind)) ?? null;
}

export const isFreeText = (k: FieldKind) => FREE_TEXT.has(k);
