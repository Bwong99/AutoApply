// The AI review of a filled page (content/review): a second, independent read of the page as shown, which checks
// every answer against the candidate's data, names the controls the scan missed, and says what is left. Its answers
// pass the same profile guards as the mapping's (mapFields.ts) before the page is changed.
import { RE_SENSITIVE_LABEL } from "../../shared/constants";
import { plainDashes, RE_AI_TELL, trapLabel } from "../../shared/injection";
import { normalize } from "../../shared/normalize";
import type { Decision, DocumentMeta, FieldDescriptor, FieldKind, JobContext, Pay, Profile } from "../../shared/types";
import { REVIEW_FORM_PROMPT } from "../gemini/prompts";
import { REVIEW_SCHEMA, ReviewZ } from "../gemini/schemas";
import {
  citedDateCheck,
  compactProfile,
  deniesNeededSponsorship,
  GUESS,
  jobCountry,
  type ServiceCtx,
  withoutEssayStyle,
  workCountry,
  wrongSiteLink,
} from "./mapFields";
import type { ReviewField, ReviewFix, ReviewResult } from "../../shared/review";
import { todayIso } from "../../shared/time";

export interface ReviewInput {
  page: string;
  fields: ReviewField[];
  profile: Profile;
  documents: Pick<DocumentMeta, "id" | "label" | "kind">[];
  job: JobContext | null;
  pays?: Pay[];
  yolo: boolean;
  consents: { required: "accept" | "ask"; optional: "accept" | "decline" | "ask" };
}

const SINGLE_CHOICE = new Set<FieldKind>(["select", "radio_group", "dropdown"]);
const CHOICE = new Set<FieldKind>(["select", "multiselect", "radio_group", "checkbox_group", "dropdown"]);

const descOf = (f: ReviewField, question = f.question): FieldDescriptor => ({
  id: f.id,
  kind: f.kind,
  label: question,
  required: f.required,
  optionsKnown: !!f.options,
  ...(f.options ? { options: f.options } : {}),
  ...(f.hint ? { hint: f.hint } : {}),
});

/**
 * The review's answer, held to the rules every answer meets: nothing made up outside YOLO's best guesses, optional
 * fields only from the data, the profile's sponsorship needs, links to the site asked for, dates as the profile cites.
 * Returns the fix to apply (possibly turned into "needs you"), or null to leave the field as it is.
 */
export function checkFix(
  fix: ReviewFix,
  f: ReviewField,
  profile: Profile,
  yolo: boolean,
  job: string | undefined,
): ReviewFix | null {
  if (f.locked || f.status === "you" || f.status === "edited") return null;
  if (RE_SENSITIVE_LABEL.test(f.question) || trapLabel(f.question)) return null;
  const question = fix.verdict === "relabel" && fix.question ? fix.question : f.question;
  if (fix.verdict === "needs_user") return { ...fix, reason: fix.reason || "Needs your answer" };
  let answer = fix.answer;
  if (answer === undefined) return fix.verdict === "relabel" ? { ...fix, question } : null;
  answer = plainDashes(answer.trim());
  if (RE_AI_TELL.test(answer)) return null;
  // Emptying: only what holds a value, and nothing required.
  if (answer === "") return f.shown && !f.required ? { ...fix, answer } : null;
  const guess = fix.sources.includes(GUESS);
  const sourced = fix.sources.some((s) => s !== GUESS);
  if (!f.required) {
    // Today's rule for optional fields: the data's answer, or nothing. YOLO also guesses single choices.
    if (!sourced && !(yolo && guess && SINGLE_CHOICE.has(f.kind))) return null;
  } else if (guess && !sourced && !yolo)
    // The user answers what the data doesn't (manual mode): the guess is only a suggestion.
    return { ...fix, verdict: "needs_user", answer, reason: fix.reason || "Not in your profile" };
  const d = descOf(f, question);
  const home = profile.personal.address.country;
  if (deniesNeededSponsorship(d, answer, workCountry(question, home, job), profile.workAuthorization.entries))
    return { ...fix, verdict: "needs_user", answer, reason: "Sponsorship needed in this country" };
  if (wrongSiteLink(question, answer, fix.sources)) return null;
  if (CHOICE.has(f.kind) && f.options?.length && !answer.includes(" | ")) {
    const i = f.options.findIndex((o) => normalize(o) === normalize(answer!));
    if (i >= 0) {
      const decision: Decision = {
        fieldId: f.id,
        action: "fill",
        optionIndexes: [i],
        intendedAnswer: f.options[i],
        confidence: "high",
        sources: fix.sources,
      };
      const checked = citedDateCheck(d, decision, profile);
      if (checked.action === "flag")
        return { ...fix, verdict: "needs_user", answer: checked.suggestion, reason: checked.note ?? "No option fits" };
      answer = f.options[checked.optionIndexes![0]];
    }
  }
  // Already showing it: nothing to change.
  if (fix.verdict !== "relabel" && normalize(answer) === normalize(f.shown)) return null;
  return { ...fix, answer, question };
}

export async function reviewForm(ctx: ServiceCtx, input: ReviewInput): Promise<ReviewResult> {
  const { resumeText, learnedAnswers, ...rest } = input.profile;
  const job = input.job?.location ? jobCountry(input.job.location) : undefined;
  const policy = {
    mode: input.yolo ? "yolo" : "manual",
    requiredWithoutData: input.yolo
      ? 'best guess (add "guess" to sources); never ID, passport, tax, bank or card numbers: those are needs_user'
      : 'needs_user, with your best suggestion in answer and "guess" in sources',
    optionalWithoutData: "leave_blank",
    consents: {
      requiredAcknowledgements: input.consents.required === "accept" ? "accepted" : "the candidate decides: needs_user",
      optionalConsents: input.consents.optional,
      jobOpportunityOptIns: input.profile.background.consentToJobOpportunities || "follow optionalConsents",
      marketingOptIns: input.profile.background.consentToMarketing || "follow optionalConsents",
    },
  };
  const r = await ctx.ai.call(
    {
      system: REVIEW_FORM_PROMPT,
      context: { profile: compactProfile(withoutEssayStyle(rest)) ?? {}, resume: resumeText.slice(0, 30000) },
      payload: {
        learnedAnswers: [...learnedAnswers]
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
          .slice(0, 100)
          .map((l) => ({ q: l.question, a: l.answer })),
        documents: input.documents,
        job: compactProfile({
          company: input.job?.company,
          title: input.job?.jobTitle,
          url: input.job?.url,
          location: input.job?.location,
          description: input.job?.text.slice(0, 8000) || input.job?.header,
        }),
        today: todayIso(),
        policy,
        fields: input.fields,
        page: input.page,
      },
      schema: REVIEW_SCHEMA,
      validate: (d) => ReviewZ.parse(d),
      review: true,
      timeoutMs: ctx.settings.reviewTimeoutMs,
      maxOutputTokens: 32768,
      signal: ctx.signal,
    },
    { model: ctx.model, fallback: ctx.fallback },
  );
  const byId = new Map(input.fields.map((f) => [f.id, f]));
  const fixes: ReviewFix[] = [];
  const seen = new Set<string>();
  for (const v of r.data.fields) {
    const f = byId.get(v.fieldId);
    if (!f || seen.has(f.id) || v.verdict === "ok" || v.verdict === "leave_blank") continue;
    seen.add(f.id);
    const fix = checkFix(
      {
        fieldId: f.id,
        verdict: v.verdict,
        ...(v.answer !== undefined && v.answer !== null ? { answer: v.answer } : {}),
        ...(v.question ? { question: v.question } : {}),
        reason: v.reason ?? "",
        sources: v.sources,
      },
      f,
      input.profile,
      input.yolo,
      job,
    );
    if (fix) fixes.push(fix);
  }
  const missed = r.data.missed
    .filter((m) => m.refs.length && m.question.trim() && !trapLabel(m.question))
    .map((m) => ({
      refs: m.refs,
      question: m.question.trim(),
      kind: m.kind,
      required: m.required,
      answer: m.answer,
      reason: m.reason ?? "",
    }));
  return { fixes, missed, reveal: r.data.reveal, usedModel: r.usedModel };
}
