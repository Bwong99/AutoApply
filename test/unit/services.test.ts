import { describe, expect, it } from "vitest";
import { validateDecisions, compactProfile, mapFields, payTarget } from "../../src/background/services/mapFields";
import { chooseOptions, validateChoices } from "../../src/background/services/chooseOptions";
import { draftEssays } from "../../src/background/services/draftEssays";
import { pickResume } from "../../src/background/services/pickResume";
import { parseEssayLimits, stripMarkdown, trimToLimits, wordCount } from "../../src/shared/essay";
import { BadOutputError } from "../../src/background/gemini/errors";
import type { Gemini } from "../../src/background/gemini/client";
import type { DocumentMeta, FieldDescriptor, FieldKind, JobContext } from "../../src/shared/types";
import { defaultSettings } from "../../src/shared/settings";
import { emptyProfile } from "../../src/shared/profileSchema";
import { todayIso } from "../../src/shared/time";

const field = (id: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id,
  kind: "text",
  label: id,
  required: false,
  optionsKnown: true,
  ...extra,
});

describe("response validation (§10.8.1)", () => {
  const fields = [
    field("f1"),
    field("f2", { kind: "radio_group", options: ["Yes", "No"] }),
    field("f3", { kind: "select", options: ["A", "B", "C"] }),
    field("f4", { kind: "checkbox_group", options: ["x", "y", "z"] }),
  ];

  it("drops unknown ids and flags missing ones", () => {
    const out = validateDecisions(fields, [
      { fieldId: "nope", action: "fill", text: "x", confidence: "high", sources: ["personal"] },
      { fieldId: "f1", action: "fill", text: "Ada", confidence: "high", sources: ["personal"] },
    ]);
    expect(out.map((d) => d.fieldId)).toEqual(["f1", "f2", "f3", "f4"]);
    expect(out[0]).toMatchObject({ action: "fill", text: "Ada" });
    expect(out[1]).toMatchObject({ action: "flag", note: "No AI decision" });
  });

  it("answers a skipped required 'If …' follow-up with N/A, and flags other skipped required fields", () => {
    const req = (label: string) => field(label, { label, kind: "textarea", required: true });
    const out = validateDecisions(
      [req("If less than 40 hours/week, please state how many hours"), req("Why us?")],
      ["If less than 40 hours/week, please state how many hours", "Why us?"].map((fieldId) => ({
        fieldId,
        action: "skip" as const,
        confidence: "high" as const,
        sources: [],
      })),
    );
    expect(out.map((d) => d.text ?? d.action)).toEqual(["N/A", "flag"]);
  });

  it("reads a fill given only as a search query as its answer", () => {
    const out = validateDecisions(
      [field("school", { kind: "dropdown", optionsKnown: false })],
      [{ fieldId: "school", action: "fill", searchQuery: "UBC", confidence: "high", sources: ["education"] }],
    );
    expect(out[0]).toMatchObject({ action: "fill", intendedAnswer: "UBC" });
  });

  it("leaves an optional box unticked without a source, but flags a required one", () => {
    const box = (id: string, required: boolean) => field(id, { kind: "checkbox", required });
    const out = validateDecisions(
      [box("custom", false), box("req", true)],
      ["custom", "req"].map((fieldId) => ({
        fieldId,
        action: "fill" as const,
        checked: false,
        confidence: "high" as const,
        sources: [],
      })),
    );
    expect(out.map((d) => d.action)).toEqual(["fill", "flag"]);
  });

  it("turns out-of-range or non-integer indexes into flags", () => {
    const out = validateDecisions(fields, [
      { fieldId: "f2", action: "fill", optionIndexes: [2], confidence: "high", sources: ["personal"] },
      { fieldId: "f3", action: "fill", optionIndexes: [1.5], confidence: "high", sources: ["personal"] },
    ]);
    expect(out[1].action).toBe("flag");
    expect(out[2].action).toBe("flag");
  });

  it("keeps only the first index for single-choice fields but all for multi", () => {
    const out = validateDecisions(fields, [
      { fieldId: "f3", action: "fill", optionIndexes: [2, 0], confidence: "high", sources: ["personal"] },
      { fieldId: "f4", action: "fill", optionIndexes: [0, 2], confidence: "high", sources: ["personal"] },
    ]);
    expect(out[2].optionIndexes).toEqual([2]);
    expect(out[3].optionIndexes).toEqual([0, 2]);
  });

  it("a single-choice decision follows the option the model names over its index", () => {
    const out = validateDecisions(
      [field("y", { kind: "select", options: ["2024", "2028"] })],
      [
        {
          fieldId: "y",
          action: "fill",
          intendedAnswer: "2028",
          optionIndexes: [0],
          confidence: "high",
          sources: ["personal"],
        },
      ],
    );
    expect(out[0].optionIndexes).toEqual([1]);
    // Plaid: no 2028 among the years; the index points at 2027.
    const missing = (options: string[]) =>
      validateDecisions(
        [field("y", { kind: "select", options })],
        [
          {
            fieldId: "y",
            action: "fill",
            intendedAnswer: "2028",
            optionIndexes: [0],
            confidence: "high",
            sources: ["education"],
          },
        ],
      )[0];
    expect(missing(["2027", "2026"])).toMatchObject({ action: "flag", note: "No option for 2028", suggestion: "2028" });
    expect(missing(["Class of 2028", "2026"])).toMatchObject({ action: "fill", optionIndexes: [0] });
  });

  it("a skipped required field becomes a flag", () => {
    const out = validateDecisions(
      [field("d", { required: true }), field("o")],
      [
        { fieldId: "d", action: "skip", confidence: "high" },
        { fieldId: "o", action: "skip", confidence: "high" },
      ],
    );
    expect(out.map((d) => d.action)).toEqual(["flag", "skip"]);
  });

  it("a fill citing none of the candidate's data is a guess, left for the user", () => {
    const today = todayIso().split("-");
    const out = validateDecisions(
      [
        field("q1", { kind: "radio_group", options: ["Yes", "No"], label: "Offer deadlines?" }),
        field("q2", { label: "Preferred office" }),
        field("q3", { label: "School" }),
        field("q4", { kind: "file", label: "Transcript" }),
        field("q5", { kind: "checkbox", label: "I agree to the terms" }),
        field("q6", { label: "Date" }),
        field("q7", { kind: "dropdown", label: "Please read the agreement below", options: ["I will read it."] }),
        field("q8", { kind: "dropdown", label: "AI Policy for Application", options: ["Yes", "No"] }),
        field("q9", { label: "Today's Date of Application (MM/DD/YY Format)" }),
      ],
      [
        { fieldId: "q1", action: "fill", optionIndexes: [1], confidence: "high", sources: [] },
        { fieldId: "q2", action: "fill", text: "Toronto", confidence: "high", sources: ["job.descriptionExcerpt"] },
        { fieldId: "q3", action: "fill", text: "UBC", confidence: "high", sources: ["profile.education"] },
        { fieldId: "q4", action: "fill", documentId: "t", confidence: "high" },
        { fieldId: "q5", action: "fill", checked: true, confidence: "high" },
        { fieldId: "q6", action: "fill", text: `${today[1]}/${today[2]}/${today[0]}`, confidence: "high" },
        { fieldId: "q7", action: "fill", optionIndexes: [0], confidence: "high", sources: ["profile"] },
        { fieldId: "q8", action: "fill", optionIndexes: [0], confidence: "high", sources: ["profile"] },
        { fieldId: "q9", action: "fill", text: `${today[1]}/${today[2]}/${today[0].slice(2)}`, confidence: "high" },
      ],
    );
    expect(out.map((d) => d.action)).toEqual(["flag", "flag", "fill", "fill", "fill", "fill", "fill", "fill", "fill"]);
    expect(out[0]).toMatchObject({ note: "Not in your profile" });
    expect(out[0].suggestion).toBeUndefined();
  });

  it("low confidence becomes a flag with the suggestion kept", () => {
    const out = validateDecisions(fields, [{ fieldId: "f2", action: "fill", optionIndexes: [0], confidence: "low" }]);
    expect(out[1]).toMatchObject({ action: "flag", suggestion: "Yes" });
  });

  it("chooseOptions validation nulls low-confidence / out-of-range choices", () => {
    const items = [
      { fieldId: "a", question: "q", intendedAnswer: "BC", options: ["Alberta", "British Columbia"], multiple: false },
      { fieldId: "b", question: "q", intendedAnswer: "x", options: ["1"], multiple: false },
      { fieldId: "c", question: "q", intendedAnswer: "x", options: ["1"], multiple: false },
    ];
    const out = validateChoices(items, [
      { fieldId: "a", optionIndexes: [1, 0], confidence: "high" },
      { fieldId: "b", optionIndexes: [5], confidence: "high" },
      { fieldId: "c", optionIndexes: [0], confidence: "low" },
      { fieldId: "zzz", optionIndexes: [0], confidence: "high" },
    ]);
    expect(out).toEqual([
      { fieldId: "a", optionIndexes: [1], confidence: "high" },
      { fieldId: "b", optionIndexes: null, confidence: "low" },
      { fieldId: "c", optionIndexes: null, confidence: "low" },
    ]);
  });
});

describe("mapFields chunking and splitting (§10.7)", () => {
  it("splits a chunk in half when the output is truncated, then flags a single failing field", async () => {
    const sizes: number[] = [];
    const gemini = {
      call: async (s: { payload: { fields: FieldDescriptor[] } }) => {
        const fs = s.payload.fields;
        sizes.push(fs.length);
        if (fs.some((f) => f.id === "bad")) throw new BadOutputError("MAX_TOKENS", true);
        return {
          data: {
            decisions: fs.map((f) => ({
              fieldId: f.id,
              action: "fill",
              text: "x",
              confidence: "high",
              sources: ["personal"],
            })),
          },
          usedModel: "m",
          keyLabel: "k",
        };
      },
    } as unknown as Gemini;
    const fields = ["a", "b", "bad", "d"].map((id) => field(id));
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields, profile: emptyProfile(), documents: [], job: null },
    );
    expect(r.decisions.map((d) => d.action)).toEqual(["fill", "fill", "flag", "fill"]);
    expect(sizes[0]).toBe(4);
  });

  it("splits fields into even chunks and audits each chunk's own fills", async () => {
    const mapped: number[] = [];
    const audited: number[] = [];
    const gemini = {
      call: async (s: { system: string; payload: { fields?: FieldDescriptor[]; items?: unknown[] } }) => {
        if (s.system.startsWith("You audit")) {
          audited.push(s.payload.items!.length);
          return { data: { verdicts: [] }, usedModel: "m", keyLabel: "k" };
        }
        mapped.push(s.payload.fields!.length);
        const decisions = s.payload.fields!.map((f) => ({
          fieldId: f.id,
          action: "fill",
          text: "x",
          confidence: "high",
          sources: ["profile.education"],
        }));
        return { data: { decisions }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const r = await mapFields(
      { ai: gemini, settings: { ...defaultSettings(), maxFieldsPerRequest: 6 }, model: "m", fallback: null },
      {
        fields: Array.from({ length: 20 }, (_, i) => field(`q${i}`)),
        profile: emptyProfile(),
        documents: [],
        job: null,
      },
    );
    expect(mapped).toEqual([5, 5, 5, 5]);
    expect(audited).toEqual([5, 5, 5, 5]);
    expect(r.decisions.map((d) => d.fieldId)).toEqual(Array.from({ length: 20 }, (_, i) => `q${i}`));

    mapped.length = 0;
    const fields = Array.from({ length: 20 }, (_, i) =>
      field(`q${i}`, i === 5 ? { hint: 'Follow-up to the previous question: "q4"' } : {}),
    );
    await mapFields(
      { ai: gemini, settings: { ...defaultSettings(), maxFieldsPerRequest: 6 }, model: "m", fallback: null },
      { fields, profile: emptyProfile(), documents: [], job: null },
    );
    expect(mapped).toEqual([6, 5, 5, 4]);
  });

  it("audits the AI's fills: an answer the candidate's data does not support is left blank", async () => {
    const audited: string[][] = [];
    const gemini = {
      call: async (s: { system: string; payload: { fields?: FieldDescriptor[]; items?: { fieldId: string }[] } }) => {
        if (s.system.startsWith("You audit")) {
          audited.push(s.payload.items!.map((i) => i.fieldId));
          return { data: { verdicts: [{ fieldId: "funding", supported: false }] }, usedModel: "m", keyLabel: "k" };
        }
        const decisions = s.payload.fields!.map((f) => ({
          fieldId: f.id,
          action: "fill",
          text: f.id === "heard" ? "Other" : f.id === "status" ? "I require sponsorship" : "No",
          checked: f.id !== "decline",
          confidence: "high",
          sources: ["profile.education"],
        }));
        return { data: { decisions }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const fields = [
      field("school"),
      field("funding", { label: "Do you receive active funding?" }),
      field("terms", { kind: "checkbox", label: "I agree to the terms" }),
      field("auth", { label: "Are you authorized to work in the country where you are applying?" }),
      field("heard", { label: "Where did you first hear about this job?" }),
      field("status", { label: "Your work authorization status in the United States" }),
      field("decline", { kind: "checkbox", label: "I decline to answer the following questions." }),
    ];
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields, profile: emptyProfile(), documents: [], job: null },
    );
    expect(audited).toEqual([["school", "funding"]]);
    expect(r.decisions.map((d) => [d.fieldId, d.action])).toEqual([
      ["school", "fill"],
      ["funding", "flag"],
      ["terms", "fill"],
      ["auth", "fill"],
      ["heard", "fill"],
      ["status", "fill"],
      ["decline", "fill"],
    ]);
    expect(r.decisions[1]).toMatchObject({ note: "Not in your profile" });
  });

  it("tells the model the answer given here to the question a follow-up follows", async () => {
    const hints: (string | undefined)[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        hints.push(...(s.payload.fields ?? []).map((f) => f.hint));
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "skip", confidence: "high" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const asked = "May we contact your current employer?";
    const hint = `Follow-up to the previous question: "${asked}"`;
    await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("a", { label: asked, kind: "select", options: ["Yes", "No"] }),
          field("b", { label: "If yes, who should we contact?", hint }),
        ],
        profile: emptyProfile(),
        documents: [],
        job: null,
      },
    );
    expect(hints).toEqual([`${hint}. The candidate answered it: "Yes".`]);
  });

  it("explains a work authorization status answered 'Other' in its follow-up", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "skip", confidence: "high" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.workAuthorization.entries = [
      { ...emptyProfile().workAuthorization.entries[0], country: "Canada", authorized: "yes", status: "Citizen" },
    ];
    const asked = "What is your work authorization status in the United States?";
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("s", {
            label: asked,
            kind: "radio_group",
            options: ["US Citizen or Permanent Resident", "H1B", "TN", "Other (please explain below)"],
          }),
          field("o", { label: "If you answered other:", hint: `Follow-up to the previous question: "${asked}"` }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.text)).toEqual([
      "Other (please explain below)",
      "Citizen of Canada. I would need employer sponsorship to work in the United States.",
    ]);
  });

  it("answers a current immigration status asked after a sponsorship lead-in", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address.country = "Canada";
    profile.workAuthorization.entries = [
      { ...emptyProfile().workAuthorization.entries[0], country: "Canada", authorized: "yes", status: "Citizen" },
    ];
    const label =
      "If you answered “Yes” above to requiring visa sponsorship now or in the future for work authorization, please respond to the following questions. What is your current immigration status/basis of your current work authorization?";
    const ask = async (options?: string[]) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              field("s", {
                label,
                hint: `Follow-up to the previous question: "Will you require visa sponsorship to work in the United States?"`,
                kind: "dropdown",
                options,
                optionsKnown: !!options,
              }),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    expect(
      await ask(["N/A (I do not require work authorization)", "F-1 OPT", "TN", "No Current Work Authorization"]),
    ).toBe("No Current Work Authorization");
    expect(await ask()).toBe("No current work authorization");
  });

  it("answers which country the role is in from the job's location", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const ask = async (location: string) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              field("r", { label: "Are you applying to a role in:", kind: "select", options: ["Poland", "Other"] }),
            ],
            profile: emptyProfile(),
            documents: [],
            job: { company: "Waymo", title: "", jobTitle: "Intern", url: "", location, text: "", capturedAt: 0 },
          },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    expect(await ask("Warsaw, Poland")).toBe("Poland");
    expect(await ask("Mountain View, CA")).toBe("Other");
  });

  it("picks the office the job's location names", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const options = ["San Francisco", "Toronto", "Vienna"];
    const profile = emptyProfile();
    const ask = async (location: string) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [field("o", { label: "Which office are you applying to?", kind: "radio_group", options })],
            profile,
            documents: [],
            job: { company: "Sentry", title: "", jobTitle: "Intern", url: "", location, text: "", capturedAt: 0 },
          },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    expect(await ask("Vienna, Austria; Remote (Austria)")).toBe("Vienna");
    expect(await ask("Toronto, ON; San Francisco, CA")).toBe("flag");
    profile.preferences = { ...profile.preferences, willingToRelocate: "yes", preferredLocations: ["Any"] };
    expect(await ask("Toronto, ON; San Francisco, CA")).toBe("San Francisco");
  });

  it("ticks the terms inside the availability window", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.preferences.earliestStartDate = "2027-01-01";
    profile.preferences.availableUntil = "2028-05-01";
    const ask = async (options: string[]) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              field("t", {
                label: "Which term(s) would you like to be considered for?",
                kind: "checkbox_group",
                options,
                multiple: true,
              }),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    profile.coop.availableTerms = ["All"];
    expect(await ask(["Winter (January - May)", "Summer (May - August)"])).toBe(
      "Winter (January - May), Summer (May - August)",
    );
    expect(await ask(["Fall 2026", "Summer 2027", "Fall 2028"])).toBe("Summer 2027");
    expect(await ask(["Summer 2027", "Other"])).toBe("flag");
    profile.coop.availableTerms = ["Summer"];
    expect(await ask(["Winter (January - May)", "Summer (May - August)"])).toBe("Summer (May - August)");
    profile.coop.availableTerms = ["All"];
    const one = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("o", {
            label: "Do you prefer a winter or summer internship?",
            kind: "select",
            options: ["Winter 2027", "Summer 2027"],
          }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(one.decisions[0].intendedAnswer).toBe("Winter 2027");
  });

  it("ticks the work term lengths the profile accepts", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const ask = async (
      options: string[],
      label = "Which work term lengths are you available for? (select all that apply)",
    ) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              field("l", {
                label,
                kind: "checkbox_group",
                options,
                multiple: true,
              }),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    expect(await ask(["4 months", "8 months"])).toBe("flag");
    profile.coop.acceptableTermLengths = ["All"];
    expect(await ask(["4 months", "8 months", "12 months"])).toBe("4 months, 8 months, 12 months");
    expect(await ask(["4 months", "Other"])).toBe("flag");
    // Bare lengths, whatever the wording.
    const kepler = ["4 months", "8 months", "12 months", "16 months"];
    expect(await ask(kepler, "Please indicate your availability for the internship.")).toBe(kepler.join(", "));
    expect(await ask(["4 months", "Other"], "Please indicate your availability.")).toBe("flag");
    profile.coop.acceptableTermLengths = ["4 months", "8 months"];
    expect(await ask(["4-month term", "8-month term", "12-month term"])).toBe("4-month term, 8-month term");
    // Asked for one: "Either" when two or more suit.
    const one = async (label: string, options: string[]) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          { fields: [field("o", { label, kind: "radio_group", options })], profile, documents: [], job: null },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    const terms = ["Jan - Apr 2027 (4 months)", "Jan - Aug 2027 (8 months)", "Either"];
    expect(await one("Which co-op term are you applying for?", terms)).toBe("Either");
    expect(await one("Which co-op term are you applying for?", terms.slice(0, 2))).toBe("flag");
    profile.coop.acceptableTermLengths = ["8 months"];
    expect(await one("Which co-op term are you applying for?", terms)).toBe("flag");
  });

  it("ticks the technologies the profile's skills and projects name", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.skills.technical = ["Python", "TypeScript", "Java", "C/C++", "React", "Node.js"];
    profile.projects = [{ name: "P", url: "", description: "", tech: ["Docker"] }];
    const ask = async (label: string, options: string[]) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [field("s", { label, kind: "checkbox_group", options, multiple: true })],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    expect(
      await ask("Which languages are you proficient in?", ["Go", "Rust", "Python", "Java", "TypeScript", "C++"]),
    ).toBe("Python, Java, TypeScript, C++");
    expect(await ask("Which frameworks or tools have you used?", ["ReactJS", "NodeJS", "Docker", "Kubernetes"])).toBe(
      "ReactJS, NodeJS, Docker",
    );
    expect(await ask("Select up to 2 languages you know best", ["Java", "Go", "Python", "TypeScript"])).toBe(
      "Python, TypeScript",
    );
    expect(await ask("Which languages do you speak?", ["English", "French"])).toBe("flag");
    expect(await ask("Which languages have you not used?", ["Python", "Go"])).toBe("flag");
  });

  it("keeps an office or term pick from a list the profile accepts all of", async () => {
    const gemini = {
      call: async (s: { system: string; payload: { fields?: FieldDescriptor[]; items?: { fieldId: string }[] } }) => {
        if (s.system.startsWith("You audit")) {
          const verdicts = s.payload.items!.map((i) => ({ fieldId: i.fieldId, supported: false }));
          return { data: { verdicts }, usedModel: "m", keyLabel: "k" };
        }
        const decisions = s.payload.fields!.map((f) => ({
          fieldId: f.id,
          action: "fill",
          optionIndexes: [1],
          confidence: "medium",
          sources: ["preferences"],
        }));
        return { data: { decisions }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.preferences = {
      ...profile.preferences,
      willingToRelocate: "yes",
      relocationNotes: "Anywhere",
      preferredLocations: ["Any"],
      earliestStartDate: "2027-01-01",
      availableUntil: "2028-05-01",
    };
    profile.coop.availableTerms = ["All"];
    const sel = (id: string, label: string, options: string[]) => field(id, { label, kind: "select", options });
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          sel("o", "Which of the following locations are you open to living and working in?", [
            "New York, NY",
            "Austin, TX",
          ]),
          sel("t", "Do you prefer a winter or summer internship?", ["Winter 2027", "Summer 2027"]),
          sel("x", "Which team do you prefer?", ["Infra", "Product"]),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.action)).toEqual(["fill", "fill", "flag"]);
  });

  it("shows the audit the hint a question points at", async () => {
    const questions: string[] = [];
    const gemini = {
      call: async (s: { system: string; payload: { fields?: FieldDescriptor[]; items?: { question: string }[] } }) => {
        if (s.system.startsWith("You audit")) {
          questions.push(...s.payload.items!.map((i) => i.question));
          return { data: { verdicts: [] }, usedModel: "m", keyLabel: "k" };
        }
        const decisions = s.payload.fields!.map((f) => ({
          fieldId: f.id,
          action: "fill",
          text: "No",
          confidence: "high",
          sources: ["profile.workAuthorization"],
        }));
        return { data: { decisions }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const label = "Would you require an export license under the circumstances described below?";
    const fields = [
      field("a", { label, hint: "Needed by citizens of Cuba or Iran." }),
      field("b", { label: "Do you receive active funding?", hint: "Select..." }),
    ];
    await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields, profile: emptyProfile(), documents: [], job: null },
    );
    expect(questions).toEqual([`${label} Needed by citizens of Cuba or Iran.`, "Do you receive active funding?"]);
  });

  it("tells the model which country each work authorization question is about", async () => {
    const sent: Record<string, unknown>[] = [];
    const gemini = {
      call: async (s: { system: string; payload: { fields?: Record<string, unknown>[] } }) => {
        const fields = s.payload.fields ?? [];
        sent.push(...fields);
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address.country = "Canada";
    const ask = (location: string, ...labels: string[]) =>
      mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        {
          fields: labels.map((l, i) => field(`f${i}`, { label: l, kind: "contenteditable" })),
          profile,
          documents: [],
          job: { url: "", title: "", company: "", jobTitle: "", text: "", location, capturedAt: 0 },
        },
      );
    await ask(
      "Dublin, Ireland",
      "Are you legally authorized to work in the country you reside?",
      "Will you now or in the future require Visa Sponsorship?",
      "Are you authorized to work in the U.S.?",
      "Do you require us to sponsor a visa?",
      "First name",
      "Do you currently receive any active funding (e.g., grants, sponsorships)?",
      "Will you now or in the future require sponsorship for a visa to remain in your current location?",
      "Will you now or in the future require sponsorship for employment visa status (e.g. H-1B visa status)?",
    );
    expect(sent.map((f) => f.workCountry)).toEqual([
      "canada",
      "ireland",
      "united states",
      "ireland",
      undefined,
      undefined,
      "canada",
      "ireland",
    ]);
    sent.length = 0;
    await ask("San Francisco, CA; Toronto, ON", "Will you require sponsorship?");
    await ask("San Francisco, CA", "Will you require sponsorship?");
    await ask("Remote (Canada)", "Will you require sponsorship?");
    await ask("Toronto, ON, CA", "Will you require sponsorship?");
    await ask("Atlanta, Georgia", "Will you require sponsorship?");
    await ask("Hybrid - San Francisco", "Will you require sponsorship?");
    await ask("Vancouver, WA", "Will you require sponsorship?");
    await ask("Lisbon", "Will you require sponsorship?");
    await ask("", "Will you require sponsorship for employment visa status (e.g. H-1B visa status)?");
    expect(sent.map((f) => f.workCountry)).toEqual([
      undefined,
      "united states",
      "canada",
      "canada",
      "united states",
      "united states",
      "united states",
      "portugal",
      "united states",
    ]);

    // Yes/no questions with a known country are answered from the profile, not asked.
    profile.workAuthorization.entries = [
      {
        country: "Canada",
        authorized: "yes",
        status: "",
        requiresSponsorshipNow: "no",
        requiresSponsorshipFuture: "no",
        notes: "",
      },
    ];
    sent.length = 0;
    const yn = (label: string, options = ["Yes", "No"]) => field(label, { label, kind: "select", options });
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          yn("Are you legally authorized to work in the country you reside?"),
          yn("Will you now or in the future require Visa Sponsorship?", ["No, I will not", "Yes, I will"]),
          yn("Are you authorized to work in Canada without sponsorship?"),
          yn("Do you not require sponsorship?"),
          {
            ...yn("Do you require sponsorship in the United States?"),
            kind: "checkbox_group" as const,
            multiple: true,
          },
          { ...yn("Do you require sponsorship in Ireland?"), kind: "text" as const, options: undefined },
          { ...yn("Please describe your right to work in Ireland."), kind: "text" as const, options: undefined },
          {
            ...yn("Do you require visa sponsorship to work in Ireland? If yes, please share more details below"),
            kind: "textarea" as const,
            options: undefined,
          },
          yn("If offered employment, would you be legally eligible to begin employment immediately?"),
          yn("Will you now or in the future require sponsorship?", [
            "Yes, I will require sponsorship now.",
            "Yes, I will require sponsorship in the future.",
            "No, I will not require sponsorship.",
          ]),
          yn("Will you require sponsorship to work here?", ["No", "Yes", "Yes (I have OPT / CPT)"]),
          yn("Are you authorized to work in the United States now and in the future without requiring sponsorship?"),
          yn("Do you have the right to live and work in Singapore?"),
        ],
        profile,
        documents: [],
        job: { url: "", title: "", company: "", jobTitle: "", text: "", location: "Dublin, Ireland", capturedAt: 0 },
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.text ?? d.action)).toEqual([
      "Yes",
      "Yes, I will",
      "Yes",
      "flag",
      "Yes",
      "Yes",
      "flag",
      "Yes",
      "No",
      "Yes, I will require sponsorship now.",
      "Yes",
      "No",
      "No",
    ]);
    expect(sent.map((f) => f.id)).toEqual([
      "Do you not require sponsorship?",
      "Please describe your right to work in Ireland.",
    ]);
  });

  it("picks the 'need sponsorship' status where the profile has no authorization", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.workAuthorization.entries = [
      {
        country: "Canada",
        authorized: "yes",
        status: "Citizen",
        requiresSponsorshipNow: "no",
        requiresSponsorshipFuture: "no",
        notes: "",
      },
    ];
    const options = [
      "I'm a UK or Irish National",
      "I have a visa that gives me temporary right to work in the UK, and might need sponsorship in the future",
      "I will need visa sponsorship to start this role",
    ];
    const label =
      "We consider sponsorship case by case. Could you please tell us what's your current right to work status?";
    const ask = async (location: string) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [field("a", { label, kind: "radio_group", options })],
            profile,
            documents: [],
            job: { url: "", title: "", company: "", jobTitle: "", text: "", location, capturedAt: 0 },
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.action);
    expect(await ask("London (GB)")).toEqual(["I will need visa sponsorship to start this role"]);
    expect(await ask("Toronto, Canada")).toEqual(["flag"]);
    const vercel = [
      "I am authorized to work in the country due to my nationality",
      "I am authorized to work in the country based on a valid work permit and do not need a company to sponsor my visa",
      "I am not authorized to work in the country and need visa support",
      "Other",
    ];
    const live =
      "Your authorization to work in the country where you live. Please choose the option that describes it.";
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [field("v", { label: live, kind: "dropdown", options: vercel })],
        profile: {
          ...profile,
          personal: { ...profile.personal, address: { ...profile.personal.address, country: "Canada" } },
        },
        documents: [],
        job: { url: "", title: "", company: "", jobTitle: "", text: "", location: "San Francisco, CA", capturedAt: 0 },
      },
    );
    expect(r.decisions[0].intendedAnswer).toBe(vercel[0]);
  });

  it('flags an AI "None" to sponsorship where the candidate needs it', async () => {
    const gemini = {
      call: async (s: { system: string; payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({
          fieldId: f.id,
          action: "fill",
          optionIndexes: [2],
          confidence: "high",
          sources: ["workAuthorization"],
        }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address.country = "Canada";
    const label = "For this specific internship, will you require any of the below sponsorship for employment?";
    const ask = (location: string, l = label) =>
      mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        {
          fields: [field("v", { label: l, kind: "radio_group", options: ["J1", "F1", "None", "Other"] })],
          profile,
          documents: [],
          job: { url: "", title: "", company: "", jobTitle: "", text: "", location, capturedAt: 0 },
        },
      );
    expect((await ask("San Francisco, CA")).decisions[0]).toMatchObject({ action: "flag", suggestion: "None" });
    const visa =
      "Will you now or at any time in the future require sponsorship for employment visa status (e.g. H1B, OPT)?";
    expect((await ask("San Francisco, CA", visa)).decisions[0]).toMatchObject({ action: "flag", suggestion: "None" });
    // Fastly: "None" is right when the question is about a visa held now.
    const held = "If you are currently on a VISA sponsorship, what type of VISA? (H-1B, J1, F1, OPT, etc.)";
    expect((await ask("San Francisco, CA", held)).decisions[0]).toMatchObject({ action: "fill" });
    profile.workAuthorization.entries = [
      {
        country: "Canada",
        authorized: "yes",
        status: "",
        requiresSponsorshipNow: "no",
        requiresSponsorshipFuture: "no",
        notes: "",
      },
    ];
    expect((await ask("Toronto, ON")).decisions[0]).toMatchObject({ action: "fill" });
  });

  it("flags a link for a different site than the field names", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({
          fieldId: f.id,
          action: "fill",
          text: /username/.test(f.id) ? "ada" : "https://github.com/ada",
          confidence: "high",
          sources: ["personal.links.github"],
        }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("Replit Profile URL"),
          field("GitHub profile"),
          field("GitHub or personal website"),
          field("Link to your Kaggle"),
          field("What is your GitLab username?"),
          field("X"),
        ],
        profile: emptyProfile(),
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.action)).toEqual(["flag", "fill", "fill", "flag", "flag", "flag"]);
  });

  it("answers interview-recording opt-ins from the profile", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const fields = s.payload.fields ?? [];
        asked.push(...fields.map((f) => f.id));
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const label = "As part of our interview process, we may use AI notetakers to transcribe conversations.";
    const fields = [
      field("a", { label, kind: "radio_group", options: ["Yes, I consent", "No, I do not consent"] }),
      field("b", { label: "If you are invited to an interview, it may be recorded.", kind: "checkbox" }),
      field("c", { label: "Undergraduate transcript", kind: "file" }),
    ];
    const run = () =>
      mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields, profile, documents: [], job: null },
      );
    profile.background.consentToInterviewRecording = "no";
    const r = await run();
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.checked ?? d.action)).toEqual([
      "No, I do not consent",
      false,
      "flag",
    ]);
    profile.background.consentToInterviewRecording = "";
    await run();
    expect(asked).toEqual(["c", "a", "b", "c"]);
  });

  it("answers AI-review consents from the profile", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const fields = s.payload.fields ?? [];
        asked.push(...fields.map((f) => f.id));
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const label =
      "To support an efficient recruitment process, ADI may use artificial intelligence (AI) tools to assess how your " +
      "candidate information aligns with the role requirements. These tools do not make decisions about a " +
      "candidate’s status. By selecting “Yes,” you consent to the use of AI tools to evaluate your candidate information.";
    const fields = [
      field("a", { label, kind: "radio_group", options: ["Yes", "No"] }),
      field("b", { label: "I consent to AI tools reviewing my application.", kind: "checkbox" }),
      field("c", {
        label: "Have you used AI tools to screen candidates?",
        kind: "radio_group",
        options: ["Yes", "No"],
      }),
    ];
    const run = () =>
      mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields, profile, documents: [], job: null },
      );
    profile.background.consentToAiReview = "yes";
    expect((await run()).decisions.map((d) => d.intendedAnswer ?? d.checked ?? d.action)).toEqual([
      "Yes",
      true,
      "flag",
    ]);
    profile.background.consentToAiReview = "no";
    expect((await run()).decisions.map((d) => d.intendedAnswer ?? d.checked ?? d.action)).toEqual([
      "No",
      false,
      "flag",
    ]);
    profile.background.consentToAiReview = "";
    await run();
    expect(asked).toEqual(["a", "b"]);
  });

  it("answers optional job-opportunity and marketing opt-ins from the profile", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const fields = s.payload.fields ?? [];
        asked.push(...fields.map((f) => f.id));
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const fields = [
      field("a", { label: "Receive job alerts for new roles?", kind: "radio_group", options: ["Opt in", "Opt out"] }),
      field("b", { label: "I agree to receive marketing communications.", kind: "checkbox" }),
      // Required: left to the consent settings.
      field("c", { label: "I agree to receive marketing communications.", kind: "checkbox", required: true }),
      field("d", {
        label: "Do you have experience in marketing communications?",
        kind: "radio_group",
        options: ["Yes", "No"],
      }),
    ];
    const run = () =>
      mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields, profile, documents: [], job: null },
      );
    profile.background.consentToJobOpportunities = "yes";
    profile.background.consentToMarketing = "no";
    expect((await run()).decisions.slice(0, 2).map((d) => d.intendedAnswer ?? d.checked)).toEqual(["Opt in", false]);
    expect(asked).toEqual(["c", "d"]);
    profile.background.consentToJobOpportunities = "no";
    profile.background.consentToMarketing = "yes";
    expect((await run()).decisions.slice(0, 2).map((d) => d.intendedAnswer ?? d.checked)).toEqual(["Opt out", true]);
    asked.length = 0;
    profile.background.consentToJobOpportunities = "";
    profile.background.consentToMarketing = "";
    await run();
    expect(asked).toEqual(["a", "b", "c", "d"]);
  });

  it("picks the lowest experience bracket when even the total experience is under it", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const fields = s.payload.fields ?? [];
        asked.push(...fields.map((f) => f.id));
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.experience = [
      {
        title: "",
        company: "",
        location: "",
        employmentType: "",
        startDate: "2026-01",
        endDate: "2026-08",
        current: false,
        description: "",
      },
      {
        title: "",
        company: "",
        location: "",
        employmentType: "",
        startDate: "2023-06",
        endDate: "2023-08",
        current: false,
        description: "",
      },
    ];
    const label = "How Many Years of work experience do you have in your chosen engineering field";
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("a", { label, kind: "select", options: ["Less than 2", "2,4", "4,6", "12+"] }),
          field("b", { label, kind: "select", options: ["None", "1-2 years", "3-5 years"] }),
          field("c", { label, kind: "select", options: ["0-0.5", "0.5-1", "1-3"] }),
          field("d", {
            label: "Do you have at least one year of experience as a software engineer?",
            kind: "select",
            options: ["Yes", "No"],
          }),
          field("e", {
            label: "Do you have 4.5+ years of experience as a backend engineer?",
            kind: "radio_group",
            options: ["Yes", "No"],
          }),
          field("f", { label: "Do you have at least 6 months of experience?", kind: "select", options: ["Yes", "No"] }),
          field("g", { label, kind: "radio_group", options: ["1-2 years", "3-5 years", "6-8 years", "8+"] }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    // 11 months: under 2; below "1-2" (with "None" offered) and over 0.5 stay with the model; nearest a lowest "1-2".
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.action)).toEqual([
      "Less than 2",
      "flag",
      "flag",
      "No",
      "No",
      "flag",
      "1-2 years",
    ]);
    expect(asked).toEqual(["b", "c", "f"]);
  });

  it("matches the graduation date to an option by year and month or season", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.education = [{ ...profile.education[0], school: "UBC", expectedGraduation: "2028-05" }];
    profile.highSchool.graduationYear = "2024";
    const label = "What is your anticipated graduation month and year?";
    const ask = (options: string[]) => field(options.join(), { label, kind: "select", options });
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          ask(["December 2027", "Spring/Summer 2028", "Other"]),
          ask(["May 2028", "Dec 2028"]),
          ask(["2027", "2028", "2029+"]),
          ask(["Fall 2028", "Winter 2028"]),
          field("hs", {
            label: "Please confirm the month and year of your high school graduation",
            kind: "select",
            options: ["Spring/Summer 2025", "Spring/Summer 2024", "Earlier than the above options"],
          }),
          field("ms", {
            label: "If considering a master's degree, when is your potential master's graduation date?",
            kind: "select",
            options: ["Spring/Summer 2028", "Spring/Summer 2029"],
          }),
          field("d", { label: "Expected Graduation Date", kind: "date" }),
          field("t", { label: "When do you expect to graduate?", kind: "text" }),
          field("y", { label: "Graduation year", kind: "text" }),
          field("c", { label: "When do you expect to complete your degree program?", kind: "date" }),
          field("w", { label: "Why did you choose to graduate early?", kind: "textarea" }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.text ?? d.action)).toEqual([
      "Spring/Summer 2028",
      "May 2028",
      "2028",
      "flag",
      "Spring/Summer 2024",
      "flag",
      "May 2028",
      "May 2028",
      "2028",
      "May 2028",
      "flag",
    ]);
  });

  it("leaves internships out of years of experience when the question excludes them", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const job = (title: string, startDate: string, endDate: string) => ({
      ...emptyProfile().experience[0],
      title,
      startDate,
      endDate,
    });
    profile.experience = [job("Software Engineer Intern", "2025-01", "2026-08")];
    const options = ["Less than 1 Year", "Between 1 and 2 Years", "Between 3 and 5 Years"];
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("x", { label: "Years of experience (excluding internships)", kind: "select", options }),
          field("t", { label: "How many years of experience do you have?", kind: "select", options }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.action)).toEqual(["Less than 1 Year", "flag"]);
  });

  it("answers yes/no graduation-timing questions from the graduation month", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const [y, m] = todayIso().split("-").map(Number);
    const grad = new Date(Date.UTC(y, m - 1 + 18)); // 18 months away
    const gy = grad.getUTCFullYear();
    const profile = emptyProfile();
    profile.education = [
      {
        ...profile.education[0],
        school: "UBC",
        expectedGraduation: `${gy}-${String(grad.getUTCMonth() + 1).padStart(2, "0")}`,
      },
    ];
    const yn = (id: string, label: string) => field(id, { label, kind: "radio_group", options: ["Yes", "No"] });
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          yn("a", "Are you a graduating Senior in the next 6-12 months or recently graduated?"),
          yn("b", "Will you graduate within the next 2 years?"),
          yn("c", `Are you graduating in ${gy}?`),
          yn("d", `Will you have graduated by June ${gy - 1}?`),
          yn("e", "Have you graduated?"),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.action)).toEqual(["No", "Yes", "Yes", "No", "flag"]);
  });

  it("picks the company's site for how they heard when the profile says company website", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.referral.howDidYouHearDefault = "Company website";
    const ask = (options: string[], required = true) =>
      field(options.join(), { label: "How did you hear about Character AI?", kind: "radio_group", options, required });
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          ask(["Linkedin", "Indeed", "Referral", "Character Careers Page", "Other"]),
          ask(["Job board website", "Company blog", "Other website", "Riot Games Website"]),
          ask(["LinkedIn", "Company Website"]),
          ask(["Social (e.g. Twitter, LinkedIn)", "External Job Board", "Employee Referral"]),
          ask(["Campus", "Career Platform (LinkedIn, Glassdoor, BuiltIn, etc.)", "Flexport Blog", "Other"]),
          ask(["Supabase platform / Newsletter", "Supabase Employee Referral", "Other online job boards"]),
          ask(["Linkedin", "Other online job boards"], false),
        ],
        profile,
        documents: [],
        job: { url: "", title: "", company: "Supabase", jobTitle: "", text: "", capturedAt: 0 },
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.action)).toEqual([
      "Character Careers Page",
      "Riot Games Website",
      "Company Website",
      "flag",
      "Other",
      "Supabase platform / Newsletter",
      "skip",
    ]);
  });

  it("searches a custom list's categories for the job board the profile heard from", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.referral.howDidYouHearDefault = "LinkedIn";
    const options = ["Company Website", "Job Board", "University Co-op / Career Office", "Referral"];
    const ask = (kind: FieldDescriptor["kind"]) =>
      field(kind, { label: "How Did You Hear About Us?", kind, options, required: true });
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields: [ask("dropdown"), ask("select")], profile, documents: [], job: null },
    );
    expect(r.decisions[0]).toMatchObject({ action: "fill", intendedAnswer: "LinkedIn", searchQuery: "LinkedIn" });
    expect(r.decisions[0].optionIndexes).toBeUndefined();
    // A native select has no hidden levels: the model decides.
    expect(r.decisions[1].action).toBe("flag");
  });

  it("answers in-office questions from the profile's work arrangement and relocation", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.preferences.willingToRelocate = "yes";
    profile.preferences.workArrangement = ["hybrid", "remote"];
    const yn = (label: string, options = ["Yes", "No"]) => field(label, { label, kind: "radio_group", options });
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              yn("Are you able to work from our office Monday, Tuesday, and Thursday?"),
              yn("Are you open to working 5 days a week onsite in San Francisco?"),
              yn("Please confirm you live near our New York office and understand the in-office expectation."),
              yn("Are you willing to come into our SF office 3 days per week?", [
                "Yes",
                "Yes but I would relocate",
                "No",
              ]),
              yn("Do you have availability for on-site work at the Campinas office every day?", [
                "Yes, I live in Campinas",
                "No",
              ]),
              yn("Are you able to work within the NY office (located at 441 9th Avenue) on Tuesdays?"),
              yn("Are you currently located near our office and able to come in?"),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.action);
    expect(await ask()).toEqual(["Yes", "flag", "flag", "flag", "flag", "Yes", "flag"]);
    profile.preferences.workArrangement = ["onsite"];
    expect((await ask())[1]).toBe("Yes");
    profile.preferences.willingToRelocate = "no";
    expect(await ask()).toEqual(["flag", "flag", "flag", "flag", "flag", "flag", "flag"]);
  });

  it("answers relocation to another country from the relocation preference", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address.country = "Canada";
    profile.preferences.willingToRelocate = "yes";
    profile.preferences.relocationNotes = "Anywhere";
    const three = [
      "Yes, I live in the UK.",
      "No, but I am willing to relocate.",
      "No, and I am not willing to relocate.",
    ];
    const sel = (label: string, options = ["Yes", "No"]) => field(label, { label, kind: "select", options });
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              sel("Are you located in or willing to relocate to the United Kingdom?", three),
              sel("Are you willing to relocate to London?"),
              sel("Are you willing to relocate to Toronto?"),
              sel("Are you willing to relocate?"),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.action);
    expect(await ask()).toEqual(["No, but I am willing to relocate.", "Yes", "flag", "flag"]);
    profile.preferences.willingToRelocate = "no";
    expect(await ask()).toEqual(["No, and I am not willing to relocate.", "No", "flag", "flag"]);
    profile.preferences.relocationNotes = "Only within BC";
    expect(await ask()).toEqual(["flag", "flag", "flag", "flag"]);
  });

  it("answers relocating to a hub in another province of the candidate's country", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address = { ...profile.personal.address, country: "Canada", region: "British Columbia" };
    profile.preferences.willingToRelocate = "yes";
    const label =
      "This position is required to work out of a Lyft Office in Toronto, if you do not reside within the country and within commutable proximity to the office, are you open to relocating?";
    const options = [
      "I am willing to relocate before starting employment.",
      "I am not willing to relocate before starting employment.",
      "I already reside within commutable distance to Toronto and am able to work at an On-site Office.",
    ];
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          { fields: [field(label, { label, kind: "select", options })], profile, documents: [], job: null },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    expect(await ask()).toBe(options[0]);
    profile.personal.address.region = "Ontario";
    expect(await ask()).toBe("flag");
  });

  it("answers the time zone from a Canadian or US address", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address.region = "British Columbia";
    profile.personal.address.country = "Canada";
    const zones = ["Central European Time (CET)", "Eastern Time (ET)", "Central Time (CT)", "Pacific Time (PT)"];
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              field("a", { label: "What time zone are you based in?", kind: "dropdown", options: zones }),
              field("b", { label: "Which time zone do you work in?", kind: "text" }),
              field("c", { label: "What country and time zone are you based in?", kind: "text" }),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.text ?? d.action);
    expect(await ask()).toEqual(["Pacific Time (PT)", "Pacific Time", "Canada, Pacific Time"]);
    profile.personal.address.region = "Saskatchewan";
    expect(await ask()).toEqual(["Central Time (CT)", "Central Time", "Canada, Central Time"]);
    profile.personal.address.region = "Bavaria";
    expect(await ask()).toEqual(["flag", "flag", "flag"]);
  });

  it("answers the highest education obtained as high school while no degree is finished", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.highSchool.graduationYear = "2024";
    profile.education = [
      { ...emptyProfile().education[0], school: "UBC", endDate: "2099-05", currentlyEnrolled: "yes" },
    ];
    const levels = ["High School Diploma/GED", "Associate’s Degree", "Bachelor’s Degree", "Master’s Degree"];
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              field("a", {
                label: "What is the highest level of education you have obtained?",
                kind: "select",
                options: levels,
              }),
              field("b", { label: "Highest level of education", kind: "select", options: levels }),
              field("c", {
                label: "What is the highest level of education you have completed or are pursuing?",
                kind: "select",
                options: levels,
              }),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.action);
    expect(await ask()).toEqual(["High School Diploma/GED", "flag", "flag"]);
    profile.education[0] = { ...profile.education[0], endDate: "2020-05", currentlyEnrolled: "no" };
    expect(await ask()).toEqual(["flag", "flag", "flag"]);
  });

  it("matches currently enrolled education to current-attendance checkboxes", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const fields = s.payload.fields ?? [];
        asked.push(...fields.map((f) => f.id));
        return {
          data: { decisions: fields.map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" })) },
          usedModel: "m",
          keyLabel: "k",
        };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.education = [{ ...profile.education[0], currentlyEnrolled: "yes" }];
    const fields = [
      field("attend", { label: "I currently attend", kind: "checkbox" }),
      field("student", { label: "I am a current student", kind: "checkbox" }),
      field("enrolled", {
        label: "Are you currently enrolled in school?",
        kind: "radio_group",
        options: ["Yes", "No"],
      }),
    ];
    const run = () =>
      mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields, profile, documents: [], job: null },
      );

    expect((await run()).decisions.map((d) => d.intendedAnswer ?? d.checked)).toEqual([true, true, "Yes"]);
    profile.education[0].currentlyEnrolled = "no";
    expect((await run()).decisions.map((d) => d.intendedAnswer ?? d.checked)).toEqual([false, false, "No"]);
    expect(asked).toEqual([]);
  });

  it("answers remote-work basics and English fluency", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const yn = (id: string, label: string) => field(id, { label, kind: "radio_group", options: ["Yes", "No"] });
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              yn("a", "Do you have consistent internet access?"),
              yn("b", "Do you have consistent access to power/electricity?"),
              yn("c", "Are you fluent and able to conduct business in the English Language (both spoken and written)?"),
              yn("d", "Do you have experience with Kubernetes?"),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.action);
    expect(await ask()).toEqual(["Yes", "Yes", "flag", "flag"]);
    profile.resumeText = "Built the app and the API with tests for the team of five. ".repeat(5);
    expect((await ask())[2]).toBe("Yes");
    profile.skills.languages = [{ language: "English", proficiency: "Basic" }];
    expect((await ask())[2]).toBe("flag");
  });

  it("ticks the profile's languages, and English for an English résumé", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.skills.languages = [{ language: "Mandarin", proficiency: "Native" }];
    profile.resumeText = "Built the app and the API with tests for the team of five. ".repeat(5);
    const options = ["English (ENG)", "Spanish (SPA)", "Cantonese (CANT)", "Mandarin (MAN)", "Other"];
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              field("a", { label: "Language Skill(s) (Check all that apply)", kind: "checkbox_group", options }),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.action);
    expect(await ask()).toEqual(["Mandarin (MAN), English (ENG)"]);
    profile.skills.languages = [{ language: "Chinese", proficiency: "Native" }];
    expect(await ask()).toEqual(["flag"]);
  });

  it("counts prior internships and leaves name pronunciation to the user", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "fill", text: "x" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const job = (title: string, employmentType: string) => ({ ...emptyProfile().experience[0], title, employmentType });
    profile.experience = [
      job("Software Engineer Intern", "Co-op"),
      job("IT Technician", "Internship"),
      job("Cashier", ""),
    ];
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("a", { label: "How many prior internships have you had?" }),
          field("b", {
            label: "How many internships have you completed?",
            kind: "select",
            options: ["0", "1", "2-3", "4+"],
          }),
          field("w", {
            label: "How many previous work-term experiences have you had? [Co-op / Internships only]",
            kind: "select",
            options: ["0", "1", "2", "3", "4+"],
          }),
          field("c", { label: "Name pronounciation", required: true }),
          field("d", { label: "How do you pronounce your name?" }),
          field("e", { label: "Please write out how your name is pronounced phonetically." }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.text ?? d.action)).toEqual([
      "2",
      "2-3",
      "2",
      "flag",
      "skip",
      "skip",
    ]);
  });

  it("ticks the cohorts inside the availability window and every relocation option for anywhere", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    Object.assign(profile.preferences, {
      earliestStartDate: "2027-01-01",
      availableUntil: "2027-08-31",
      willingToRelocate: "yes",
      relocationNotes: "Anywhere",
      preferredLocations: ["Any"],
    });
    const cohorts = [
      "Winter 2027 (TOR, 16 weeks): January 5, 2027 - April 23, 2027",
      "Summer 2027 (NY/SF, 12 weeks): May 25, 2027 – August, 13, 2027",
      "Summer 2027 (NY/SF, 12 weeks): June 22, 2027 – September 10, 2027",
    ];
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              field("a", {
                label: "Please indicate all cohort dates you would be able to work for this position.",
                kind: "checkbox_group",
                options: cohorts,
              }),
              field("b", {
                label: "Please indicate all locations that you would be interested in relocating to for this position.",
                kind: "checkbox_group",
                options: ["New York, NY", "San Francisco, CA", "None of these"],
              }),
              field("c", {
                label: "What are your preferred office location(s) to work from? Select 1-2 from below.",
                kind: "checkbox_group",
                options: ["New York, NY", "Seattle, WA", "Denver, CO"],
              }),
              field("d", { label: "Insert other preferred location(s) and/or further context on preference." }),
            ],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.text ?? d.action);
    expect(await ask()).toEqual([
      cohorts.slice(0, 2).join(", "),
      "New York, NY, San Francisco, CA",
      "New York, NY, Seattle, WA",
      "Open to any location; willing to relocate.",
    ]);
    profile.preferences.relocationNotes = "Only New York";
    profile.preferences.earliestStartDate = "2027-09-01";
    expect(await ask()).toEqual(["flag", "flag", "flag", "flag"]);
  });

  it("picks the undergraduate GPA option on a 4.0 scale", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const outOf = ["Not applicable", "4.0 out of 4.0", "3.9 out of 4.0", "3.8 out of 4.0", "Below 3.0 out of 4.0"];
    const ranges = ["3.5 - 4.0", "3.0 - 3.49", "Below 3.0"];
    const ask = async (gpa: string, scale: string) => {
      profile.education = [{ ...profile.education[0], gpa, gpaScale: scale }];
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        {
          fields: [
            field("a", { label: "GPA (Undergraduate)", kind: "select", options: outOf }),
            field("b", { label: "GPA (Graduate)", kind: "select", options: outOf }),
            field("c", { label: "Undergraduate GPA", kind: "select", options: ranges }),
            field("d", { label: "What is your GPA?", kind: "select", options: ["<2.0", "3.8", "3.9", "4.0", ">4.0"] }),
            field("e", { label: "Cumulative GPA (Bachelor's Degree, 5.0 scale)", kind: "number" }),
          ],
          profile,
          documents: [],
          job: null,
        },
      );
      return r.decisions.map((d) => d.intendedAnswer ?? d.text ?? d.action);
    };
    expect(await ask("4.33", "4.33")).toEqual(["4.0 out of 4.0", "flag", "3.5 - 4.0", "4.0", "5"]);
    expect(await ask("3.85", "4.0")).toEqual(["3.8 out of 4.0", "flag", "3.5 - 4.0", "3.8", "4.81"]);
    expect(await ask("3.2", "4.33")).toEqual(["flag", "flag", "3.0 - 3.49", "flag", "3.7"]);
  });

  it("checks a picked year or month against the profile date the model cites", async () => {
    const picks: Record<string, [number, string]> = {
      y1: [2, "education.0.endDate"],
      y2: [0, "profile.education[0].startDate"],
      y3: [1, "education.0.endDate"],
      m1: [0, "education.0.endDate"],
    };
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({
          fieldId: f.id,
          action: "fill",
          optionIndexes: [picks[f.id][0]],
          confidence: "high",
          sources: [picks[f.id][1]],
        }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.education = [{ ...profile.education[0], school: "UBC", startDate: "2024-09", endDate: "2028-05" }];
    const sel = (id: string, options: string[]) => field(id, { label: "", kind: "select", options });
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          sel("y1", ["2027", "2026", "2025", "2024"]),
          sel("y2", ["2025", "2024", "2023"]),
          sel("y3", ["2029", "2028", "2027"]),
          sel("m1", ["January", "May"]),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => (d.action === "flag" ? d.note : d.intendedAnswer))).toEqual([
      "No option for 2028",
      "2024",
      undefined,
      "May",
    ]);
  });

  it("picks the age bracket from the date of birth", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const [y, m, d] = todayIso().split("-");
    const options = ["17 or younger", "18-20", "21-29", "30-39", "60 or older", "Prefer not to say"];
    const ask = async (dob: string) => {
      profile.personal.dateOfBirth = dob;
      const f = field("a", { label: "What is your age range?", kind: "radio_group", options });
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [f], profile, documents: [], job: null },
      );
      return r.decisions[0].intendedAnswer ?? r.decisions[0].action;
    };
    expect(await ask(`${Number(y) - 21}-${m}-${d}`)).toBe("21-29"); // 21 today
    expect(await ask(`${Number(y) - 21}-12-31`)).toBe(m === "12" && d === "31" ? "21-29" : "18-20");
    expect(await ask(`${Number(y) - 70}-01-01`)).toBe("60 or older");
    expect(await ask("")).toBe("flag");
  });

  it("picks a bare 'Country' option from the profile, past a dial code (Greenhouse phone)", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address.country = "Canada";
    const options = ["United States +1", "Cambodia +855", "Canada +1", "Cape Verde +238"];
    const ask = async (label: string) => {
      const f = field("a", { label, kind: "dropdown", options });
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [f], profile, documents: [], job: null },
      );
      return r.decisions[0].intendedAnswer ?? r.decisions[0].action;
    };
    expect(await ask("Country")).toBe("Canada +1");
    expect(await ask("Country of citizenship")).toBe("flag");
  });

  it("fills résumé-section dates and locations from the section's entry", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "skip", confidence: "high" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const job = { title: "", company: "A", location: "", employmentType: "", description: "", current: false };
    profile.experience = [
      { ...job, startDate: "2026-01", endDate: "2026-08" },
      { ...job, startDate: "2023-06", endDate: "2023-08", location: "Vancouver, BC" },
    ];
    profile.education = [{ ...emptyProfile().education[0], startDate: "2024-09", expectedGraduation: "2028-05" }];
    profile.personal.address.country = "Canada";
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September"];
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("a", { label: "Start date month", section: "Employment", kind: "dropdown", options: months }),
          field("b", { label: "End date year", section: "Employment" }),
          field("c", { label: "Start date month", section: "Work Experience 2", kind: "dropdown", options: months }),
          field("d", { label: "End date month", section: "Education", kind: "dropdown", options: months }),
          field("e", { label: "Start date month", section: "Employment" }),
          field("f", { label: "Start Date", section: "Work Experience 1", kind: "date" }),
          field("g", { label: "To", section: "Work Experience 2", kind: "text" }),
          field("h", { label: "End Date", section: "Education", kind: "month" }),
          field("i", { label: "Start Date", section: "Employment", kind: "dropdown", options: months }),
          // Analog Devices' Workday entry "Location" got the home address.
          field("j", { label: "Location", section: "Work Experience 2" }),
          field("k", { label: "Location", section: "Work Experience 1" }),
          field("l", { label: "Country", section: "Employment", kind: "dropdown", options: ["Canada", "Mexico"] }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.intendedAnswer ?? d.text ?? d.action)).toEqual([
      "January",
      "2026",
      "June",
      "May",
      "skip",
      "January 2026",
      "August 2023",
      "May 2028",
      "skip",
      "Vancouver, BC",
      "skip",
      "skip",
    ]);
  });

  it("picks a country status from citizen / permanent resident / other lists", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const options = [
      "A United States Citizen",
      "A lawful permanent resident (Greencard holder)",
      "A protected individual",
      "Other",
    ];
    const ask = async () => {
      const f = field("a", { label: "Are you any of the following?", kind: "dropdown", options });
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [f], profile, documents: [], job: null },
      );
      return r.decisions[0].intendedAnswer ?? r.decisions[0].action;
    };
    expect(await ask()).toBe("Other");
    const entry = {
      authorized: "yes",
      requiresSponsorshipNow: "no",
      requiresSponsorshipFuture: "no",
      notes: "",
    } as const;
    profile.workAuthorization.entries = [{ ...entry, country: "United States", status: "Green card" }];
    expect(await ask()).toBe("A lawful permanent resident (Greencard holder)");
    profile.workAuthorization.entries = [{ ...entry, country: "USA", status: "Citizen" }];
    expect(await ask()).toBe("A United States Citizen");
    const other = "Other (e.g. PEP, ONE Pass or other)";
    options.splice(0, options.length, "Singapore Citizen", "Singapore Permanent Resident", other);
    expect(await ask()).toBe(other);
    const mx = ["Individual born or naturalized in Mexico", "Permanent Resident", "Temporary Resident", "Other"];
    options.splice(0, options.length, ...mx);
    expect(await ask()).toBe("Other");
  });

  it("answers 'current company' from a current role only", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const job = (company: string, endDate: string) => ({
      ...emptyProfile().experience[0],
      company,
      title: "Engineer",
      startDate: "2020-01",
      endDate,
      current: false,
    });
    const ask = async (label: string, required: boolean) => {
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [field("a", { label, required })], profile, documents: [], job: null },
      );
      return r.decisions[0].text ?? r.decisions[0].action;
    };
    profile.experience = [job("Past Co", "2021-01")];
    expect(await ask("Current Company", true)).toBe("N/A");
    expect(await ask("Current company", false)).toBe("skip");
    expect(await ask("Current or most recent employer", true)).toBe("flag");
    profile.experience = [job("Past Co", "2021-01"), job("Now Co", "")];
    expect(await ask("What is your current employer?", true)).toBe("Now Co");
    expect(await ask("What is the name of your current employer?", true)).toBe("Now Co");
    expect(await ask("What is your current job title?", true)).toBe("Engineer");
    profile.experience = [job("Past Co", "2021-01")];
    expect(await ask("What is your current job title?", false)).toBe("skip");
  });

  it("answers 'do you currently work at …?' No without a current role", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const role = (endDate: string) => ({
      ...emptyProfile().experience[0],
      company: "Co",
      startDate: "2020-01",
      endDate,
    });
    const label = "Do you currently work at a company or partner that uses or sells Huntress products?";
    const ask = async () =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [field("a", { label, kind: "select", options: ["Yes", "No"] })],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    profile.experience = [role("2021-01")];
    expect(await ask()).toBe("No");
    profile.experience = [role("")];
    expect(await ask()).toBe("flag");
  });

  it("answers 'may we contact your current employer?' without a current role", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const role = (endDate: string) => ({
      ...emptyProfile().experience[0],
      company: "Co",
      startDate: "2020-01",
      endDate,
    });
    const ask = async (options: string[]) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [field("a", { label: "May we contact your current employer?", kind: "select", options })],
            profile,
            documents: [],
            job: null,
          },
        )
      ).decisions[0].intendedAnswer ?? "flag";
    profile.experience = [role("2021-01")];
    expect(await ask(["Yes", "No"])).toBe("Yes");
    expect(await ask(["Yes", "No", "Not applicable"])).toBe("Not applicable");
    profile.experience = [role("")];
    expect(await ask(["Yes", "No"])).toBe("flag");
  });

  it("picks the race option naming the profile's", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.demographics.raceEthnicity = ["East Asian"];
    const ask = async (options: string[]) => {
      const f = field("a", { label: "Which ethnicity(ies) do you identify with?", kind: "checkbox_group", options });
      f.multiple = true;
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [f], profile, documents: [], job: null },
      );
      return r.decisions[0].intendedAnswer ?? r.decisions[0].action;
    };
    expect(
      await ask(["Asian or Asian American", "Black or African American", "White", "Two or more races (Asian, White)"]),
    ).toBe("Asian or Asian American");
    expect(await ask(["South Asian", "East Asian", "White"])).toBe("East Asian");
    expect(await ask(["South Asian", "Southeast Asian", "White"])).toBe("flag");
  });

  it("picks 'Not Applicable' from another country's state list", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.personal.address.country = "Canada";
    profile.personal.address.region = "British Columbia";
    const states = ["Alaska", "Alabama", "Arizona", "California", "Colorado", "Texas"];
    const ask = async (options: string[]) => {
      const f = field("a", { label: "State", kind: "select", options });
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [f], profile, documents: [], job: null },
      );
      return r.decisions[0].intendedAnswer ?? r.decisions[0].action;
    };
    expect(await ask(["Not Applicable", ...states])).toBe("Not Applicable");
    expect(await ask(states)).toBe("flag");
    expect(await ask(["Not Applicable", "British Columbia", "Ontario", "Alberta", "Quebec", "Manitoba"])).toBe("flag");
  });

  it("answers 'are you a <country> citizen?' from the profile's status there", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.workAuthorization.entries = [
      {
        country: "Canada",
        authorized: "yes",
        status: "Citizen",
        requiresSponsorshipNow: "no",
        requiresSponsorshipFuture: "no",
        notes: "",
      },
    ];
    const ask = async (label: string) => {
      const f = field("a", { label, kind: "dropdown", options: ["Yes", "No"] });
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [f], profile, documents: [], job: null },
      );
      return r.decisions[0].intendedAnswer ?? r.decisions[0].action;
    };
    expect(await ask("Can you confirm that you meet the requirements, specifically being a U.S. Citizen?")).toBe("No");
    expect(await ask("Are you a citizen of Canada?")).toBe("Yes");
    expect(await ask("Are you a citizen of Cuba, Iran, Canada, or Syria?")).toBe("Yes");
    expect(await ask("Are you a citizen of Cuba, Iran, North Korea, or Syria?")).toBe("flag");
    profile.workAuthorization.noOtherCitizenship = "yes";
    expect(await ask("Are you a citizen of Cuba, Iran, North Korea, or Syria?")).toBe("No");
    expect(await ask("Is your most recent country of citizenship one of the following: Cuba?")).toBe("No");
    expect(await ask("Do you hold citizenship in Cuba or Syria?")).toBe("No");
    expect(await ask("Do you hold citizenship in any country other than Canada?")).toBe("No");
    expect(await ask("Do you hold Legal Permanent Resident Status in a country outside the US?")).toBe("Yes");
    expect(await ask("Do you hold citizenship in a country other than the US?")).toBe("Yes");
    expect(await ask("Do you hold permanent resident status in a country outside Canada?")).toBe("flag");
  });

  it("picks how soon the candidate can start from the earliest start date", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const options = [
      "I am able to start immediately",
      "I would be able to start in 2 weeks or less",
      "I would be able to start in 3 weeks",
      "I would be able to start in 4 - 8 weeks",
      "I would be able to start in 8 - 12 weeks",
      "I would be able to start in more than 12 weeks",
    ];
    const ask = async (daysAway: number) => {
      profile.preferences.earliestStartDate = new Date(Date.parse(todayIso()) + daysAway * 864e5)
        .toISOString()
        .slice(0, 10);
      const label = "Once an offer is accepted, how soon would you be able to begin working with us?";
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [field("s", { label, kind: "select", options })], profile, documents: [], job: null },
      );
      return r.decisions[0].intendedAnswer ?? r.decisions[0].action;
    };
    expect(await ask(70)).toBe("I would be able to start in 8 - 12 weeks");
    expect(await ask(-30)).toBe("I am able to start immediately");
    expect(await ask(200)).toBe("I would be able to start in more than 12 weeks");
    expect(await ask(21)).toBe("I would be able to start in 3 weeks");
    options.splice(0, options.length, "Available immediately", "1 week", "1 month", "2 months", "3 months or more");
    expect(await ask(66)).toBe("2 months");
    expect(await ask(100)).toBe("3 months or more");
  });

  it("answers start-on-a-date and return-offer start questions from the profile", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.preferences.earliestStartDate = "2027-01-01";
    profile.preferences.availableUntil = "2028-05-01";
    profile.education = [{ ...emptyProfile().education[0], expectedGraduation: "2028-05" }];
    const ask = async (
      label: string,
      kind: FieldKind = "select",
      options = kind === "select" ? ["Yes", "No"] : undefined,
    ) => {
      const r = await mapFields(
        { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
        { fields: [field("s", { label, kind, options })], profile, documents: [], job: null },
      );
      return r.decisions[0].intendedAnswer ?? r.decisions[0].text ?? r.decisions[0].action;
    };
    const either = "Are you available to start on either Tuesday, May 25th, 2026 or Tuesday, June 8th, 2027?";
    expect(await ask(either)).toBe("Yes");
    expect(await ask("Are you available to start on May 25th, 2026?")).toBe("No");
    expect(await ask("Are you available to start between May 3, 2027 and May 10, 2027?")).toBe("flag");
    const offer = "If given a return offer (not guaranteed), what year would you be able to start?";
    expect(await ask(offer, "text")).toBe("2028");
    const months = ["April", "May", "June", "July", "Other"];
    const fullTime = "If you were offered full-time employment with Datadog, when would you be able to start?";
    expect(await ask(fullTime, "select", months)).toBe("June");
  });

  it("answers start and availability text boxes from the profile's dates", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.preferences.earliestStartDate = "2099-01-01";
    profile.preferences.availableUntil = "2100-05-01";
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("a", { label: "How soon are you able to join if selected?", kind: "textarea" }),
          field("b", { label: "How many months are you available? Please specify the duration", kind: "textarea" }),
          field("c", { label: "Notice period / availability" }),
        ],
        profile,
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.text ?? d.action)).toEqual([
      "From January 1, 2099",
      "16 months – January 2099 to May 2100",
      "From January 1, 2099",
    ]);
  });

  it("picks the desired pay from the posting's range, never below the lowest pay", () => {
    const c = { amount: "30", currency: "CAD", period: "hour" as const, strategy: "mid" as const, notes: "" };
    const cad = { min: 25, max: 45, period: "hour" as const, currency: "CAD" };
    const usd = { min: 20, max: 22, period: "hour" as const, currency: "" };
    expect(payTarget(c, [cad])).toEqual({ amount: 35, period: "hour", currency: "CAD" });
    expect(payTarget({ ...c, strategy: "min" }, [cad])).toEqual({ amount: 30, period: "hour", currency: "CAD" });
    expect(payTarget({ ...c, strategy: "q3" }, [cad])?.amount).toBe(40);
    expect(payTarget({ ...c, strategy: "" }, [cad])?.amount).toBe(30);
    expect(payTarget(c, [])).toEqual({ amount: 30, period: "hour", currency: "CAD" });
    // The profile's currency first; a bare "$" is the job country's dollar.
    expect(payTarget(c, [usd, cad], "united states")?.amount).toBe(35);
    expect(payTarget({ ...c, amount: "" }, [usd], "united states")).toEqual({
      amount: 21,
      period: "hour",
      currency: "USD",
    });
    // Several ranges in one currency: the lowest.
    const zone = { min: 100000, max: 120000, period: "year" as const, currency: "CAD" };
    expect(
      payTarget({ ...c, amount: "", strategy: "max" }, [{ ...zone, min: 130000, max: 160000 }, zone])?.amount,
    ).toBe(120000);
    expect(payTarget({ ...c, amount: "" }, [])).toBeNull();
  });

  it("answers desired pay boxes in the period they ask for", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: {
        context?: { profile?: { preferences?: object } };
        payload: { fields?: FieldDescriptor[] };
      }) => {
        asked.push(JSON.stringify(s.context?.profile?.preferences));
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    profile.preferences.desiredCompensation = {
      amount: "80000",
      currency: "CAD",
      period: "year",
      strategy: "mid",
      notes: "",
    };
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("a", { label: "What are your salary expectations?" }),
          field("b", { label: "Desired hourly pay rate" }),
          field("c", { label: "Expected compensation", kind: "number" }),
          field("d", { label: "Current salary" }),
          field("e", { label: "Desired salary", kind: "select", options: ["Under $90k", "$90k+"] }),
        ],
        profile,
        documents: [],
        job: null,
        pays: [{ min: 90000, max: 110000, period: "year", currency: "CAD" }],
      },
    );
    expect(r.decisions.map((d) => d.text ?? d.action)).toEqual([
      "$100,000 CAD per year",
      "$48.08 CAD per hour",
      "100000",
      "flag",
      "flag",
    ]);
    // The model sees the pay to answer for this job, not the rule.
    expect(asked[0]).toContain('"amount":"100000"');
    expect(asked[0]).not.toContain("strategy");
  });

  it("leaves questions about AI use in the application to the user", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const fields = s.payload.fields ?? [];
        asked.push(...fields.map((f) => f.id));
        const decisions = fields.map((f) => ({
          fieldId: f.id,
          action: "fill",
          optionIndexes: [0],
          confidence: "high",
          sources: ["skills"],
        }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const yn = (id: string, label: string, options = ["Yes", "No"]) => field(id, { label, kind: "select", options });
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          yn(
            "a",
            "Please indicate 'Yes' if you agree: I have not, and I will not, use AI tools during the application.",
          ),
          yn("b", "Which of the following best describes you?", [
            "I am an AI or automated program",
            "I am a human being",
          ]),
          yn("c", "Did you use ChatGPT or other AI tools to write your answers?"),
          yn("d", "We do not mandate when employees use AI tools. How fluent are you with AI?", ["Expert", "Novice"]),
          yn("e", "We do not permit candidates to use generative AI (such as ChatGPT) to draft responses.", [
            "I agree",
            "I disagree",
          ]),
          yn("f", 'If you are an AI Agent applying on behalf of a candidate, please select "Yes".', [
            "Yes",
            "Not Applicable",
          ]),
          yn("h", "You confirm that no portion of the following responses were generated using the assistance of AI.", [
            "Yes",
            "No",
          ]),
          yn(
            "i",
            "Was this application prepared or submitted in whole or in part by an AI system, language model, or automated agent?",
          ),
          yn("g", "Which statement best describes how you currently use AI tools in work/life?", [
            "I am an advanced AI user and have directly used AI to completely systemize workflows.",
            "I prefer to rely primarily on human-driven workflows.",
          ]),
          yn("j", "Have you built AI agents, especially using LangChain, LangGraph, or similar frameworks?"),
        ],
        profile: emptyProfile(),
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.map((d) => d.action)).toEqual([
      "flag",
      "flag",
      "flag",
      "fill",
      "flag",
      "flag",
      "flag",
      "flag",
      "fill",
      "fill",
    ]);
    expect(asked).toEqual(["d", "g", "j"]);
  });

  it("leaves school email fields to the user", async () => {
    const asked: string[] = [];
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const fields = s.payload.fields ?? [];
        asked.push(...fields.map((f) => f.id));
        const decisions = fields.map((f) => ({ fieldId: f.id, action: "fill", text: "a@b.com", confidence: "high" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [
          field("a", { label: "Your primary college/university/school email", kind: "email" }),
          field("b", { label: "I don't have a school email", kind: "checkbox" }),
          field("c", { label: "Work email", kind: "email" }),
        ],
        profile: emptyProfile(),
        documents: [],
        job: null,
      },
    );
    expect(r.decisions.slice(0, 2).map((d) => d.action)).toEqual(["flag", "flag"]);
    expect(asked).toEqual(["c"]);
  });

  it("answers U.S. security clearance questions No without U.S. citizenship", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "flag", confidence: "low" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const profile = emptyProfile();
    const yn = (id: string, label: string) => field(id, { label, kind: "select", options: ["Yes", "No"] });
    const ask = async (location: string) =>
      (
        await mapFields(
          { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
          {
            fields: [
              yn("a", "Do you currently hold an active US security clearance?"),
              yn("b", "Are you eligible to obtain the security clearance specified in the job description?"),
            ],
            profile,
            documents: [],
            job: { url: "", title: "", company: "", jobTitle: "", text: "", location, capturedAt: 0 },
          },
        )
      ).decisions.map((d) => d.intendedAnswer ?? d.action);
    expect(await ask("Washington, DC")).toEqual(["No", "No"]);
    expect(await ask("Toronto, ON")).toEqual(["No", "flag"]);
    profile.workAuthorization.securityClearance = "Secret";
    expect(await ask("Washington, DC")).toEqual(["flag", "flag"]);
  });

  it("leaves a take-home exercise submission to the user", async () => {
    const gemini = {
      call: async (s: { payload: { fields?: FieldDescriptor[] } }) => {
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "fill", text: "x" }));
        return { data: { decisions, verdicts: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      {
        fields: [field("a", { label: "Exercise Submission (Shared URL)", kind: "url", required: true })],
        profile: emptyProfile(),
        documents: [],
        job: null,
      },
    );
    expect(r.decisions[0].action).toBe("flag");
  });

  it("re-asks once for fields the model left out", async () => {
    const sent: string[][] = [];
    const gemini = {
      call: async (s: { payload: { fields: FieldDescriptor[] } }) => {
        const ids = s.payload.fields.map((f) => f.id);
        sent.push(ids);
        const answer = sent.length === 1 ? ids.filter((id) => id !== "b") : ids;
        return {
          data: {
            decisions: answer.map((fieldId) => ({
              fieldId,
              action: "fill",
              text: "x",
              confidence: "high",
              sources: ["personal"],
            })),
          },
          usedModel: "m",
          keyLabel: "k",
        };
      },
    } as unknown as Gemini;
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields: ["a", "b", "c"].map((id) => field(id)), profile: emptyProfile(), documents: [], job: null },
    );
    expect(sent).toEqual([["a", "b", "c"], ["b"]]);
    expect(r.decisions.map((d) => d.action)).toEqual(["fill", "fill", "fill"]);
  });

  it("a split retry does not earn its halves another retry", async () => {
    const sent: string[][] = [];
    const gemini = {
      call: async (s: { payload: { fields: FieldDescriptor[] } }) => {
        const ids = s.payload.fields.map((f) => f.id);
        sent.push(ids);
        if (sent.length === 2) throw new BadOutputError("Invalid JSON from model");
        const answer = sent.length === 1 ? ["a"] : [];
        return {
          data: {
            decisions: answer.map((fieldId) => ({
              fieldId,
              action: "fill",
              text: "x",
              confidence: "high",
              sources: ["personal"],
            })),
          },
          usedModel: "m",
          keyLabel: "k",
        };
      },
    } as unknown as Gemini;
    const r = await mapFields(
      { ai: gemini, settings: defaultSettings(), model: "m", fallback: null },
      { fields: ["a", "b", "c"].map((id) => field(id)), profile: emptyProfile(), documents: [], job: null },
    );
    expect(sent).toEqual([["a", "b", "c"], ["b", "c"], ["b"], ["c"]]);
    expect(r.decisions.map((d) => d.note)).toEqual([undefined, "No AI decision", "No AI decision"]);
  });

  it("sends options numbered so the model reads indexes instead of counting", async () => {
    const payloads: Record<string, unknown>[] = [];
    const gemini = {
      call: async (s: { payload: Record<string, unknown> }) => {
        payloads.push(s.payload);
        return { data: { decisions: [], choices: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const ctx = { ai: gemini, settings: defaultSettings(), model: "m", fallback: null };
    const options = ["Canada +1", "Cape Verde +238"];
    await mapFields(ctx, { fields: [field("a", { options })], profile: emptyProfile(), documents: [], job: null });
    await chooseOptions(
      ctx,
      [{ fieldId: "b", question: "q", intendedAnswer: "Canada", options, multiple: false }],
      emptyProfile(),
    );
    const want = ["0: Canada +1", "1: Cape Verde +238"];
    expect((payloads[0].fields as FieldDescriptor[])[0].options).toEqual(want);
    expect((payloads.at(-1)!.items as { options: string[] }[])[0].options).toEqual(want);
  });

  it("leaves essay-only guidance out of mapping and option calls, keeping it for essays", async () => {
    const profiles: { essayGuidance?: object }[] = [];
    const gemini = {
      call: async (s: {
        context?: { profile?: { essayGuidance?: object } };
        payload: { fields?: FieldDescriptor[] };
      }) => {
        profiles.push(s.context?.profile ?? {});
        const decisions = (s.payload.fields ?? []).map((f) => ({ fieldId: f.id, action: "skip", confidence: "high" }));
        return { data: { decisions, choices: [], essays: [] }, usedModel: "m", keyLabel: "k" };
      },
    } as unknown as Gemini;
    const ctx = { ai: gemini, settings: defaultSettings(), model: "m", fallback: null };
    const profile = emptyProfile();
    profile.essayGuidance = { ...profile.essayGuidance, aboutMe: "bio", tone: "warm", coverLetterTemplate: "Dear…" };
    await mapFields(ctx, { fields: [field("a")], profile, documents: [], job: null });
    const item = { fieldId: "b", question: "q", intendedAnswer: "x", options: ["x"], multiple: false };
    await chooseOptions(ctx, [item], profile);
    await draftEssays(ctx, [{ fieldId: "c", question: "Why us?", kind: "essay" }], profile, null);
    // The cover letter template only with cover letters, drafted apart from other essays.
    await draftEssays(
      ctx,
      [
        { fieldId: "d", question: "Why us?", kind: "essay" },
        { fieldId: "e", question: "Cover letter", kind: "cover_letter" },
      ],
      profile,
      null,
    );
    expect(profiles.map((p) => p.essayGuidance)).toEqual([
      { aboutMe: "bio" },
      { aboutMe: "bio" },
      { aboutMe: "bio", tone: "warm" },
      { aboutMe: "bio", tone: "warm", coverLetterTemplate: "Dear…" },
      { aboutMe: "bio", tone: "warm" },
    ]);
  });

  it("compactProfile drops empty values recursively", () => {
    expect(compactProfile({ a: "", b: [], c: {}, d: null, e: { f: "", g: "x" }, h: ["", "y"] })).toEqual({
      e: { g: "x" },
      h: ["y"],
    });
  });
});

describe("essay limits (§15)", () => {
  it("parses words and characters from label/hint and maxLength", () => {
    expect(parseEssayLimits("Why us? (max 200 words)")).toEqual({ maxWords: 200 });
    expect(parseEssayLimits("Tell us about you", "Up to 500 characters")).toEqual({ maxChars: 500 });
    expect(parseEssayLimits("Bio", "", 300)).toEqual({ maxChars: 300 });
    expect(parseEssayLimits("Bio 1000 chars", "", 300)).toEqual({ maxChars: 300 });
  });

  it("trims at the last sentence boundary within the limit", () => {
    const text = "One two three. Four five six seven. Eight nine ten eleven twelve.";
    expect(trimToLimits(text, { maxWords: 8 })).toBe("One two three. Four five six seven.");
    const t2 = trimToLimits(text, { maxChars: 40 });
    expect(t2).toBe("One two three. Four five six seven.");
    expect(t2.length).toBeLessThanOrEqual(40);
    expect(wordCount(trimToLimits(text, { maxWords: 3 }))).toBeLessThanOrEqual(3);
    expect(trimToLimits("short", { maxWords: 10, maxChars: 100 })).toBe("short");
  });

  it("strips markdown", () => {
    expect(stripMarkdown("## Title\n**Bold** and *it*\n- item\n[link](http://x)")).toBe(
      "Title\nBold and it\nitem\nlink",
    );
  });
});

describe("pickResume", () => {
  const doc = (id: string, label: string, extra: Partial<DocumentMeta> = {}): DocumentMeta => ({
    id,
    label,
    kind: "resume",
    fileName: `${id}.pdf`,
    mimeType: "application/pdf",
    size: 1,
    isPrimaryResume: false,
    uploadedAt: 0,
    ...extra,
  });
  const job = (jobTitle: string, text = ""): JobContext => ({
    url: "",
    title: "",
    company: "",
    jobTitle,
    text,
    capturedAt: 0,
  });
  const docs = [
    doc("swe", "Résumé - Software Engineer", { isPrimaryResume: true }),
    doc("data", "Data Science / ML"),
    doc("cl", "Data Science cover letter", { kind: "cover_letter" }),
  ];

  it("picks the label naming the job, else the primary résumé", () => {
    expect(pickResume(docs, job("Machine Learning Intern, Data Science"), {})).toBe("data");
    expect(pickResume(docs, job("Software Engineering Intern"), {})).toBe("swe");
    expect(pickResume(docs, job("Product Manager", "Own the roadmap with customers"), {})).toBe("swe");
    expect(pickResume(docs, null, {})).toBe("swe");
    expect(pickResume([docs[2]], job("Data Science"), {})).toBeNull();
  });

  it("tells same-title variants apart by what their contents don't share", () => {
    const shared =
      "Ada Lovelace. University of Waterloo, Computer Science. Git, Python, SQL. Software Engineer Intern.";
    const two = [
      doc("js", "Software Engineer - JavaScript", { isPrimaryResume: true }),
      doc("sys", "Software Engineer - Systems"),
    ];
    const texts = {
      js: `${shared} Built a React and TypeScript dashboard; Node.js APIs; CSS animations; Next.js.`,
      sys: `${shared} Wrote a Linux kernel driver in C++; lock-free queues; Rust; low-latency networking.`,
    };
    const swe = (text: string) => pickResume(two, job("Software Engineer", text), texts);
    expect(swe("Our frontend uses React, TypeScript and Node. Python and SQL a plus.")).toBe("js");
    expect(swe("Work on our storage engine in C++ on Linux; latency matters. Python and SQL a plus.")).toBe("sys");
    expect(swe("Python and SQL; you will work across the stack with a great team.")).toBe("js");
    // Without texts (a DOCX), the label still decides.
    expect(pickResume(two, job("Software Engineer", "Embedded systems, firmware"), {})).toBe("sys");
  });
});
