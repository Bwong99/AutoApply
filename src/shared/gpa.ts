// "GPA only when required": the Profile's choice to keep its GPA off every application that doesn't demand it.
import type { Profile } from "./types";

/** A question asking for a grade average: "GPA", "Cumulative GPA (out of 4.0)", "Grade point average". */
export const RE_GPA_Q = /\b(c?gpa|grade[- ]point|cumulative (grade )?average|academic average|grade average)\b/i;

/** The source of the "leave this optional GPA question blank" decision: the review may not refill or flag it. */
export const GPA_KEPT = "education.gpaWhenOptional";

/** Whether the Profile gives its GPA only to questions that require it. */
export const gpaOnlyWhenRequired = (p: Pick<Profile, "education">) =>
  p.education.some((e) => e.gpaWhenOptional === "blank");

/**
 * The profile as the AI sees it: with "GPA only when required" on, no GPA at all (nor saved answers to GPA
 * questions), so no AI call can put it in an optional field, an essay or a cover letter. Required GPA questions are
 * answered by code from the stored profile instead. The setting itself never goes to the AI.
 */
export function withoutOptionalGpa<T extends Pick<Profile, "education"> & Partial<Pick<Profile, "learnedAnswers">>>(
  p: T,
): T {
  const hide = gpaOnlyWhenRequired(p);
  const education = p.education.map(({ gpaWhenOptional: _, ...e }) => (hide ? { ...e, gpa: "", gpaScale: "" } : e));
  const learned =
    p.learnedAnswers && hide ? { learnedAnswers: p.learnedAnswers.filter((l) => !RE_GPA_Q.test(l.question)) } : {};
  return { ...p, education, ...learned };
}
