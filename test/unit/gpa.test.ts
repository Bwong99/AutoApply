import { describe, expect, it } from "vitest";
import { localDecisions, mappingPayloadBase } from "../../src/background/services/mapFields";
import { withoutOptionalGpa } from "../../src/shared/gpa";
import { EducationSchema, emptyProfile } from "../../src/shared/profileSchema";
import type { FieldDescriptor } from "../../src/shared/types";

const field = (label: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  id: "q",
  kind: "text",
  label,
  required: false,
  optionsKnown: true,
  ...extra,
});
const profile = (only: boolean) => {
  const p = emptyProfile();
  p.education = [
    EducationSchema.parse({
      school: "University of British Columbia",
      gpa: "3.8",
      gpaScale: "4.0",
      gpaWhenOptional: only ? "blank" : "",
    }),
  ];
  return p;
};
const decide = (p: ReturnType<typeof profile>, f: FieldDescriptor) =>
  localDecisions({ fields: [f], profile: p, documents: [], job: null }).get("q");
const scale = ["3.5 - 3.69", "3.7 - 3.89", "3.9 - 4.0"];

describe("Share GPA: only when required", () => {
  it("leaves every optional GPA question blank", () => {
    const p = profile(true);
    expect(decide(p, field("GPA"))).toMatchObject({ action: "skip" });
    expect(decide(p, field("Cumulative GPA (out of 4.0)"))).toMatchObject({ action: "skip" });
    expect(decide(p, field("Undergraduate GPA", { kind: "dropdown", options: scale }))).toMatchObject({
      action: "skip",
    });
    expect(
      decide(p, field("Is your GPA 3.0 or above?", { kind: "radio_group", options: ["Yes", "No"] })),
    ).toMatchObject({ action: "skip" });
  });

  it("answers a required GPA question from the profile, and hands an unclear one to the user", () => {
    const p = profile(true);
    expect(decide(p, field("GPA", { required: true }))).toMatchObject({ action: "fill", text: "3.8" });
    expect(decide(p, field("GPA (out of 4.0)", { required: true }))).toMatchObject({ action: "fill", text: "3.8" });
    expect(
      decide(p, field("Undergraduate GPA", { kind: "dropdown", options: scale, required: true }))?.optionIndexes,
    ).toEqual([1]);
    // Not the profile's GPA, or a threshold: the user's call, never a guess by the AI.
    expect(decide(p, field("High school GPA", { required: true }))).toMatchObject({ action: "flag" });
    expect(decide(p, field("Cumulative average (%)", { required: true }))).toMatchObject({ action: "flag" });
  });

  it("changes nothing when the setting is off", () => {
    const p = profile(false);
    expect(decide(p, field("GPA"))).toBeUndefined();
    expect(decide(p, field("Undergraduate GPA", { kind: "dropdown", options: scale }))?.optionIndexes).toEqual([1]);
  });

  it("keeps the GPA and GPA answers away from every AI call", () => {
    const p = profile(true);
    p.learnedAnswers = [
      { question: "What is your GPA?", answer: "3.8" },
      { question: "Preferred pronouns", answer: "He/Him" },
    ] as never;
    const base = mappingPayloadBase({ profile: p, documents: [], job: null });
    expect(JSON.stringify(base)).not.toContain("3.8");
    expect(JSON.stringify(base)).not.toContain("gpaWhenOptional");
    expect(withoutOptionalGpa(p).learnedAnswers.map((l) => l.question)).toEqual(["Preferred pronouns"]);
    // Off: the AI sees the GPA as before (the setting itself still stays out).
    const off = JSON.stringify(mappingPayloadBase({ profile: profile(false), documents: [], job: null }));
    expect(off).toContain("3.8");
    expect(off).not.toContain("gpaWhenOptional");
  });
});
