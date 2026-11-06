// The AI review of a filled page (content/review): a second, independent read of the page as shown, which checks
// every answer against the candidate's data, names the controls the scan missed, and says what is left. Its answers
// pass the same profile guards as the mapping's (mapFields.ts) before the page is changed.
import { RE_SENSITIVE_LABEL } from "../../shared/constants";
import { plainDashes, RE_AI_TELL, trapLabel } from "../../shared/injection";
import { normalize } from "../../shared/normalize";
import type { Decision, DocumentMeta, FieldDescriptor, FieldKind, JobContext, Pay, Profile } from "../../shared/types";
import { BadOutputError } from "../gemini/errors";
import { REVIEW_FORM_PROMPT } from "../gemini/prompts";
import { REVIEW_SCHEMA, ReviewZ } from "../gemini/schemas";
import {
  citedDateCheck,
  compactProfile,
  deniesNeededSponsorship,
  GUESS,
  jobCountry,
  localDecisions,
  mappingPayloadBase,
  payTarget,
  type ServiceCtx,
  workCountry,
  wrongSiteLink,
  validateDecisions,
} from "./mapFields";
import type { ReviewField, ReviewFix, ReviewResult } from "../../shared/review";
import { todayIso } from "../../shared/time";
import { isScreeningQuestion } from "../../shared/screening";

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
/** Kinds a fill can empty: text boxes, native selects and single boxes (FillOp "clear" / unchecked). */
const CLEARABLE = new Set<FieldKind>([
  "text",
  "email",
  "tel",
  "url",
  "number",
  "date",
  "month",
  "textarea",
  "select",
  "checkbox",
]);
const CHOICE = new Set<FieldKind>(["select", "multiselect", "radio_group", "checkbox_group", "dropdown"]);

const descOf = (f: ReviewField, question = f.question): FieldDescriptor => ({
  id: f.id,
  kind: f.kind,
  label: question,
  required: f.required,
  optionsKnown: !!f.options,
  ...(f.options ? { options: f.options } : {}),
  ...(f.hint ? { hint: f.hint } : {}),
  ...(f.section ? { section: f.section } : {}),
  ...(f.multiple ? { multiple: true } : {}),
  ...(f.placeholder ? { placeholder: f.placeholder } : {}),
  ...(f.maxLength ? { maxLength: f.maxLength } : {}),
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
  if (RE_SENSITIVE_LABEL.test(question) || trapLabel(question)) return null;
  if (fix.verdict === "needs_user") return { ...fix, reason: fix.reason || "Needs your answer" };
  let answer = fix.answer;
  if (answer === undefined) return fix.verdict === "relabel" ? { ...fix, question } : null;
  answer = plainDashes(answer.trim());
  if (RE_AI_TELL.test(answer)) return null;
  // Emptying: only what holds a value, and nothing required.
  if (answer === "") return f.shown && !f.required ? { ...fix, answer } : null;
  // A phone country picker that shows only the dial code (Greenhouse's "+1" for Canada or the US) can't show more.
  if (/^\+\d{1,4}$/.test(f.shown.trim()) && new RegExp(`\\${f.shown.trim()}(?!\\d)`).test(answer)) return null;
  const guess = fix.sources.includes(GUESS);
  const sourced = fix.sources.some((s) => s !== GUESS);
  if (!f.required) {
    // Today's rule for optional fields: the data's answer, or nothing. YOLO also guesses single choices.
    if (!sourced && !(yolo && guess && SINGLE_CHOICE.has(f.kind))) return null;
  } else if (guess && !sourced && !yolo)
    // The user answers what the data doesn't (manual mode): the guess is only a suggestion.
    return { ...fix, verdict: "needs_user", answer, reason: fix.reason || "Not in your profile" };
  const d = descOf(f, question);
  // The same source check as the first pass: a review cannot invent an identity or treat a job as candidate data.
  const evidence = validateDecisions(
    [d],
    [
      {
        fieldId: f.id,
        action: "fill",
        text: answer,
        intendedAnswer: answer,
        confidence: "medium",
        sources: fix.sources,
      },
    ],
  )[0];
  if (evidence.action === "flag" && evidence.note === "Not in your profile")
    return yolo ? null : { ...fix, verdict: "needs_user", answer, reason: evidence.note };
  const home = profile.personal.address.country;
  if (deniesNeededSponsorship(d, answer, workCountry(question, home, job), profile.workAuthorization.entries))
    return { ...fix, verdict: "needs_user", answer, reason: "Sponsorship needed in this country" };
  if (wrongSiteLink(question, answer, fix.sources)) return null;
  // A choice's answer must be one of its options: "British Columbia" for a list of US states is no answer. Not a
  // custom dropdown's: its list was read once and may have changed since (BambooHR's provinces after the country).
  if (CHOICE.has(f.kind) && f.kind !== "dropdown" && f.options?.length) {
    const parts = answer.split(/\s*\|\s*/).filter(Boolean);
    const listed = parts.every((p) => f.options!.some((o) => normalize(o) === normalize(p)));
    if (!listed)
      return yolo
        ? null
        : { ...fix, verdict: "needs_user", answer, reason: fix.reason || "No option fits your answer" };
  }
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

/** Every requested field needs a verdict; duplicate or unrelated ids cannot cover an omitted field. */
export function covered<T extends { fields: { fieldId: string }[] }>(r: T, fields: ReviewField[]): T {
  const ids = new Set(r.fields.map((v) => v.fieldId));
  const answered = fields.filter((f) => ids.has(f.id)).length;
  if (answered < fields.length) throw new BadOutputError(`The review answered ${answered} of ${fields.length} fields`);
  return r;
}

export async function reviewForm(ctx: ServiceCtx, input: ReviewInput): Promise<ReviewResult> {
  const { resumeText, learnedAnswers } = input.profile;
  const job = input.job?.location ? jobCountry(input.job.location) : undefined;
  const base = mappingPayloadBase(
    { ...input, documents: [] },
    payTarget(input.profile.preferences.desiredCompensation, input.pays ?? [], job),
  );
  const descriptors = input.fields.map((f) => descOf(f));
  const localInput = {
    ...input,
    fields: descriptors,
    documents: [],
    uploads: descriptors.filter((f) => f.kind === "file").map((f) => f.label),
  };
  const original = localDecisions(localInput);
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
  const spec = {
    system: REVIEW_FORM_PROMPT,
    context: { profile: base.profile, resume: resumeText.slice(0, 30000) },
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
    validate: (d: unknown) => ReviewZ.parse(d),
    review: true,
    timeoutMs: ctx.settings.reviewTimeoutMs,
    maxOutputTokens: 32768,
    signal: ctx.signal,
  };
  const models = { model: ctx.model, fallback: ctx.fallback };
  const r = await ctx.ai.call(spec, models);
  const answered = new Set(r.data.fields.map((v) => v.fieldId));
  const missing = input.fields.filter((f) => !answered.has(f.id));
  if (missing.length) {
    ctx.signal?.throwIfAborted();
    // Keep the page and every field as context for dependent questions, but request only omitted verdicts. The
    // clients retry incomplete recovery once, then use the configured fallback; never return a partial review.
    const recovery = await ctx.ai.call(
      {
        ...spec,
        system: `${spec.system}\n\nCOVERAGE RECOVERY: The earlier reply omitted some field verdicts. For this request, step 1 applies only to the ids in "fieldIdsToReview": return exactly one verdict for each of those ids. All original fields and the page are provided for context. Do not repeat other verdicts. Steps 2 and 3 were already requested: return empty "missed" and "reveal" arrays.`,
        payload: { ...spec.payload, fieldIdsToReview: missing.map((f) => f.id) },
        validate: (d) => covered(ReviewZ.parse(d), missing),
      },
      models,
    );
    const missingIds = new Set(missing.map((f) => f.id));
    r.data.fields.push(...recovery.data.fields.filter((v) => missingIds.has(v.fieldId)));
    if (recovery.usedModel !== ctx.model) r.usedModel = recovery.usedModel;
  }
  covered(r.data, input.fields);
  const byId = new Map(input.fields.map((f) => [f.id, f]));
  const fixes: ReviewFix[] = [];
  const seen = new Set<string>();
  for (const v of r.data.fields) {
    const f = byId.get(v.fieldId);
    if (!f || seen.has(f.id) || v.verdict === "ok") continue;
    seen.add(f.id);
    // "Leave it empty" about a field that holds a value means empty it (an optional box, list or tick only).
    if (v.verdict === "leave_blank") {
      if (!f.shown || f.required || !CLEARABLE.has(f.kind)) continue;
      v.verdict = "wrong";
      v.answer = "";
    }
    let fix = checkFix(
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
    if (fix) {
      let policy = original.get(f.id);
      // A corrected label can change which profile rule applies. A flag or screening constraint on the original
      // question still holds: renaming the question must not evade it.
      if (fix.verdict === "relabel" && fix.question && policy?.action !== "flag" && !isScreeningQuestion(descOf(f)))
        policy = localDecisions({
          ...localInput,
          fields: descriptors.map((d) => (d.id === f.id ? descOf(f, fix!.question) : d)),
        }).get(f.id);
      if (policy?.action === "flag") {
        fix = {
          fieldId: f.id,
          verdict: "needs_user",
          reason: policy.note ?? "Needs your answer",
          sources: policy.sources ?? [],
        };
      } else if (fix.verdict !== "needs_user" && policy?.action === "fill") {
        const answer =
          policy.text ??
          (policy.optionIndexes && f.options
            ? policy.optionIndexes.map((i) => f.options![i]).join(" | ")
            : policy.intendedAnswer) ??
          (policy.checked !== undefined ? (policy.checked ? "checked" : "unchecked") : undefined);
        if (answer !== undefined)
          fix = checkFix(
            { ...fix, answer, sources: policy.sources ?? [], reason: "Profile and screening policy" },
            f,
            input.profile,
            input.yolo,
            job,
          );
      } else if ((policy?.action === "skip" && fix.answer !== "") || policy?.action === "consent") fix = null;
    }
    if (fix) fixes.push(fix);
  }
  const missed = r.data.missed
    .filter((m) => m.refs.length && m.question.trim() && !trapLabel(m.question))
    .map((m) => ({
      refs: m.refs,
      question: m.question.trim(),
      kind: m.kind,
      required: m.required,
    }));
  return { fixes, missed, reveal: r.data.reveal, usedModel: r.usedModel };
}
