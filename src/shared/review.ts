// What the AI review of a filled page (content/review, background/services/reviewForm.ts) sends and answers.
import type { FieldKind } from "./types";

/** A field as the content script sends it for review. */
export interface ReviewField {
  id: string;
  question: string;
  kind: FieldKind;
  required: boolean;
  section?: string;
  hint?: string;
  placeholder?: string;
  maxLength?: number;
  options?: string[];
  multiple?: boolean;
  /** What the page shows now ("" when empty). */
  shown: string;
  status: string;
  /** Where its answer came from (a profile path, "Saved answer", the AI's sources). */
  source?: string;
  note?: string;
  /** Never changed by the review: the user's own, a consent the settings decide, a sensitive or policy-held one. */
  locked?: boolean;
}

export type FixVerdict = "wrong" | "fill" | "relabel" | "needs_user";

export interface ReviewFix {
  fieldId: string;
  verdict: FixVerdict;
  /** The answer to enter; "" empties the field. Absent for needs_user without a suggestion. */
  answer?: string;
  /** relabel: the question the field really asks. */
  question?: string;
  reason: string;
  sources: string[];
}

export interface ReviewMissed {
  refs: string[];
  question: string;
  kind: FieldKind;
  required: boolean;
}

export interface ReviewResult {
  fixes: ReviewFix[];
  missed: ReviewMissed[];
  reveal: string[];
  usedModel: string;
}
