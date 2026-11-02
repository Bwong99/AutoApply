import { beforeAll, describe, expect, it } from "vitest";
import { localMatch, localMatchAll } from "../../src/content/match/localMatch";
import { deterministicValue, formatPhone, matchLearned, shoutedName } from "../../src/content/match/deterministic";
import { fitLength, formatDateFor } from "../../src/content/fill/native";
import { sameValue } from "../../src/content/fill/verify";
import { emptyProfile } from "../../src/shared/profileSchema";
import type { FieldDescriptor } from "../../src/shared/types";
import { stubLayout } from "./dom";

beforeAll(stubLayout);

describe("localMatch (§13.3)", () => {
  it("returns null for the relocation trap — that goes to the AI", () => {
    expect(localMatch("yes", ["I am willing to relocate", "I am not willing to relocate"])).toBeNull();
    expect(localMatch("Yes", ["I will not require sponsorship", "I will require sponsorship"])).toBeNull();
  });
  it("matches exact normalized text, only when unique", () => {
    expect(localMatch("yes", ["Yes", "No"])).toBe(0);
    expect(localMatch("  NO!", ["Yes", "No"])).toBe(1);
    expect(localMatch("Yes", ["Yes", "yes"])).toBeNull();
  });
  it("matches country and region aliases", () => {
    expect(localMatch("USA", ["Canada", "United States", "Mexico"])).toBe(1);
    expect(localMatch("BC", ["Alberta", "British Columbia", "Ontario"])).toBe(1);
    expect(localMatch("Canada", ["CA", "US"])).toBe(0);
  });
  it("never resolves yes/no to a country code", () => {
    expect(localMatch("No", ["Norway", "Sweden"])).toBeNull();
  });
  it("matches numeric and date equivalents", () => {
    expect(localMatch("2027", ["2026", "2027", "2028"])).toBe(1);
    expect(localMatch("May 2027", ["2027-04", "2027-05"])).toBe(1);
    expect(localMatch("2027-05", ["April 2027", "May 2027"])).toBe(1);
  });
  it("matches a number to the one range holding it (Oracle's salary expectations)", () => {
    const pay = ["$30,000 - $40,000", "$40,001 - $50,000", "$50,001 - $60,000", ">$200,000"];
    expect(localMatch("41600", pay)).toBe(1);
    expect(localMatch("$50,000", pay)).toBe(1);
    expect(localMatch("250000", pay)).toBeNull();
    expect(localMatch("5", ["0-5 years", "5-10 years"])).toBeNull();
    expect(localMatch("Python 3", ["1 - 5"])).toBeNull();
  });
  it("never does substring or fuzzy matching", () => {
    expect(localMatch("relocate", ["I am willing to relocate"])).toBeNull();
    expect(localMatch("Python", ["Python 3", "Java"])).toBeNull();
  });
  it("multi-value answers need every part to match", () => {
    expect(localMatchAll("Python | Go", ["Go", "Python", "Rust"])).toEqual([1, 0]);
    expect(localMatchAll("Python | Zig", ["Go", "Python"])).toBeNull();
  });
});

const f = (label: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: "f1",
  kind: "text",
  label,
  required: false,
  optionsKnown: true,
  ...extra,
});

describe("phone verification", () => {
  it("accepts a phone shown without the country code a picker took over (Workable)", () => {
    expect(sameValue("+1 2365180162", "236-518-0162", "digits")).toBe(true);
    expect(sameValue("+1 2365180162", "(236) 518-0162", "digits")).toBe(true);
    expect(sameValue("+1 2365180162", "518-0162", "digits")).toBe(false);
    expect(sameValue("+1 2365180162", "+1 2365180163", "digits")).toBe(false);
  });
});

describe("deterministic matching (§13.2)", () => {
  const p = emptyProfile().personal;
  Object.assign(p, { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" });
  p.phone = { countryCode: "+1", number: "6045551234", type: "mobile" };
  p.address.region = "British Columbia";
  p.address.regionCode = "BC";
  p.links.linkedin = "https://linkedin.com/in/ada";

  it("recognizes the profile's name in the capitals a résumé parser wrote (Workday)", () => {
    const shout = (label: string, currentValue: string) => shoutedName(f(label, { currentValue }), p);
    expect(shout("Given Name(s)", "ADA")).toBe(true);
    expect(shout("Family Name", " LOVELACE ")).toBe(true);
    expect(shout("Full name", "ADA LOVELACE")).toBe(true);
    // Already fine, someone else's name, or not a name.
    expect(shout("Given Name(s)", "Ada")).toBe(false);
    expect(shout("Given Name(s)", "AUGUSTA")).toBe(false);
    expect(shout("City", "ADA")).toBe(false);
    // A profile in capitals is what the person chose.
    const caps = { ...p, firstName: "ADA" };
    expect(shoutedName(f("First name", { currentValue: "ADA" }), caps)).toBe(false);
  });

  it("maps autocomplete tokens", () => {
    expect(deterministicValue(f("Given", { autocomplete: "given-name" }), p)?.value).toBe("Ada");
    expect(deterministicValue(f("x", { autocomplete: "section-a shipping family-name" }), p)?.value).toBe("Lovelace");
    expect(deterministicValue(f("x", { autocomplete: "address-level1", maxLength: 2 }), p)?.value).toBe("BC");
    expect(deterministicValue(f("x", { autocomplete: "tel", kind: "tel" }), p)?.value).toBe("6045551234");
  });
  it("reads a bare Address as the street when the form asks the city apart", () => {
    const q = structuredClone(p);
    q.address.line1 = "7396 202 Street";
    expect(deterministicValue(f("Address"), q, true)?.value).toBe("7396 202 Street");
    expect(deterministicValue(f("Address"), q)).toBeNull();
  });
  it("leaves a work or education entry's own place to its entry", () => {
    const q = structuredClone(p);
    q.address.city = "Langley";
    expect(deterministicValue(f("City"), q)?.value).toBe("Langley");
    expect(deterministicValue(f("Location", { section: "Work Experience 1" }), q)).toBeNull();
    expect(deterministicValue(f("City", { section: "Education 1" }), q)).toBeNull();
    expect(deterministicValue(f("First Name", { section: "Work Experience 1" }), q)?.value).toBe("Ada");
  });
  it("adds the country code only when the phone box shows one", () => {
    const tel = (extra: Partial<FieldDescriptor>) =>
      deterministicValue(f("Phone", { kind: "tel", ...extra }), p)?.value;
    expect(tel({})).toBe("6045551234");
    expect(tel({ placeholder: "+47 40 61 23 45" })).toBe("+1 6045551234"); // Teamtailor
    expect(tel({ currentValue: "+31" })).toBe("+1 6045551234"); // Recruitee seeds the dial code
  });
  it("signs a signature box with the full name, not the surname it mentions (Westinghouse)", () => {
    const sig = "Electronic Signature : Please sign with your full name (first name and last name or surname)";
    expect(deterministicValue(f(sig), p)?.value).toBe("Ada Lovelace");
    expect(deterministicValue(f("Surname"), p)?.value).toBe("Lovelace");
    expect(deterministicValue(f("Signature Date"), p)).toBeNull();
  });
  it("leaves a phone extension empty, not the phone number", () => {
    for (const label of ["Phone Extension", "Phone ext.", "Extension"])
      expect(deterministicValue(f(label), p)?.value).toBe("");
    expect(deterministicValue(f("x", { autocomplete: "tel-extension", kind: "tel" }), p)?.value).toBe("");
    expect(deterministicValue(f("Mobile phone"), p)?.value).toBe("6045551234");
  });
  it("maps unambiguous label regexes", () => {
    expect(deterministicValue(f("First name"), p)).toEqual({ value: "Ada", path: "personal.firstName" });
    expect(deterministicValue(f("Full name"), p)?.value).toBe("Ada Lovelace");
    expect(deterministicValue(f("First and Last Name"), { ...p, middleName: "King" })?.value).toBe("Ada Lovelace");
    // Cloudflare: a required "Legal Name (if different than above)" got skipped by the AI.
    expect(deterministicValue(f("Legal Name (if different than above)"), { ...p, middleName: "King" })?.value).toBe(
      "Ada King Lovelace",
    );
    expect(deterministicValue(f("Email address", { kind: "email" }), p)?.value).toBe("ada@example.com");
    expect(deterministicValue(f("university email", { kind: "email" }), p)).toBeNull();
    expect(deterministicValue(f("LinkedIn profile"), p)?.value).toBe("https://linkedin.com/in/ada");
    expect(deterministicValue(f("Province / State"), p)?.value).toBe("British Columbia");
    // Lever: "Name Pronunciation | How do you pronounce your name?" is not a pronouns question.
    expect(deterministicValue(f("Name Pronunciation | How do you pronounce your name?"), p)).toBeNull();
    expect(deterministicValue(f("Please write out how your name is pronounced phonetically."), p)).toBeNull();
    // Stripe: a Canadian resident must not answer a US-only question with their province.
    expect(deterministicValue(f("If located in the US, in what city and state do you reside?"), p)).toBeNull();
  });
  it("answers city and location typeaheads with the full place, searched by city", () => {
    const q = { ...p, address: { ...p.address, city: "Langley", region: "British Columbia", country: "Canada" } };
    const loc = { value: "Langley, British Columbia, Canada", path: "personal.address.city + region + country" };
    expect(deterministicValue(f("Current Location", { kind: "typeahead" }), q)).toEqual({ ...loc, query: "Langley" });
    expect(deterministicValue(f("City", { kind: "typeahead" }), q)).toEqual({ ...loc, query: "Langley" });
    expect(deterministicValue(f("Location (City)"), q)?.value).toBe(loc.value);
    const confirm =
      "Can you please confirm your current location? Note: the successful individual must be based in Poland.";
    expect(deterministicValue(f(confirm), q)?.value).toBe(loc.value);
    expect(deterministicValue(f("Is your current location in the US?"), q)).toBeNull();
    const search = { kind: "dropdown" as const, optionsKnown: false };
    expect(deterministicValue(f("Location (City)", search), q)).toEqual({ ...loc, query: "Langley" });
    expect(deterministicValue(f("Location", { kind: "dropdown", options: ["Vancouver"] }), q)).toBeNull();
    expect(deterministicValue(f("Office location", { kind: "typeahead" }), q)).toBeNull();
    expect(deterministicValue(f("School", { kind: "typeahead" }), q)).toBeNull();
    // A job's own location (Analog Devices' Workday "Work Experience 1") is not the home address.
    expect(deterministicValue(f("Location", { section: "Work Experience 1" }), q)).toBeNull();
    expect(deterministicValue(f("City", { section: "Education", autocomplete: "address-level2" }), q)).toBeNull();
  });
  it("returns empty values for recognized fields unset in the profile", () => {
    expect(deterministicValue(f("GitHub"), p)).toEqual({ value: "", path: "personal.links.github" });
    expect(deterministicValue(f("Address 1"), p)).toEqual({ value: "", path: "personal.address.line1" });
    expect(deterministicValue(f("Phone", { kind: "tel" }), { ...p, phone: { ...p.phone, number: "" } })?.value).toBe(
      "",
    );
  });
  it("skips ambiguous labels and non-text kinds", () => {
    expect(deterministicValue(f("City, State"), p)).toBeNull();
    const home = { ...p, address: { ...p.address, city: "Langley", country: "Canada" } };
    expect(deterministicValue(f("Where is your permanent (City, Country) work location?"), home)?.value).toBe(
      "Langley, Canada",
    );
    expect(deterministicValue(f("Please indicate your current city, state, and country."), p)).toBeNull();
    expect(deterministicValue(f("Personal statement", { kind: "textarea" }), p)).toBeNull();
    expect(deterministicValue(f("First name", { kind: "select" }), p)).toBeNull();
  });
  it("formats phones per the placeholder", () => {
    expect(deterministicValue(f("Phone", { kind: "tel", placeholder: "(555) 555-5555" }), p)?.value).toBe(
      "(604) 555-1234",
    );
    expect(formatPhone("+1 604 555 1234", "###-###-####")).toBe("604-555-1234");
    expect(formatPhone("6045551234", "Phone")).toBe("6045551234");
    expect(formatPhone("2365180162", "+47 40 61 23 45")).toBe("2365180162");
  });
  it("matches learned answers by normalized question and compatible kind", () => {
    const learned = [
      {
        id: "1",
        question: "Are you 18+?",
        normalizedQuestion: "are you 18+",
        kind: "radio_group" as const,
        answer: "Yes",
      },
    ];
    expect(matchLearned(f("Are you 18+ ?", { kind: "select" }), learned)?.id).toBe("1");
    expect(matchLearned(f("Are you 18+?", { kind: "text" }), learned)).toBeNull();
  });
});

describe("fill formatting (§14.2, §14.3)", () => {
  const input = (type: string, placeholder = "") =>
    Object.assign(document.createElement("input"), { type, placeholder });
  it("converts ISO dates to input types and placeholder formats", () => {
    expect(formatDateFor(input("date"), "2027-05")).toBe("2027-05-01");
    expect(formatDateFor(input("month"), "05/2027")).toBe("2027-05");
    expect(formatDateFor(input("text", "MM/DD/YYYY"), "2027-05-03")).toBe("05/03/2027");
    expect(formatDateFor(input("text", "DD-MM-YYYY"), "2027-05-03")).toBe("03-05-2027");
    expect(formatDateFor(input("text", "MM/YYYY"), "2027-05")).toBe("05/2027");
    expect(formatDateFor(input("text"), "2027-05-03")).toBe("2027-05-03");
    // react-datepicker (Ashby) reads ISO as UTC (a day early in the Americas): use its MM/DD/YYYY default.
    const wrap = document.createElement("div");
    wrap.className = "react-datepicker__input-container";
    const picker = wrap.appendChild(input("text", "Pick date..."));
    expect(formatDateFor(picker, "2028-05")).toBe("05/01/2028");
  });
  it("truncates to maxLength at a word boundary", () => {
    expect(fitLength("hello wonderful world", 15)).toBe("hello wonderful");
    expect(fitLength("one two three four", 10)).toBe("one two");
    expect(fitLength("short", 15)).toBe("short");
  });
});
