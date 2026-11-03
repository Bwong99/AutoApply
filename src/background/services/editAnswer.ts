// An answer rewritten as the user asks, from the field's "Edit with AI" box.
import { stripMarkdown, trimToLimits } from "../../shared/essay";
import type { AnswerEdit, JobContext, Profile } from "../../shared/types";
import { EDIT_PROMPT } from "../gemini/prompts";
import { EDIT_SCHEMA, EditZ } from "../gemini/schemas";
import { jobBrief } from "./jobBrief";
import { compactProfile, type ServiceCtx } from "./mapFields";

export async function editAnswer(
  ctx: ServiceCtx,
  edit: AnswerEdit,
  profile: Profile,
  job: JobContext | null,
): Promise<string> {
  const { resumeText, learnedAnswers: _l, ...rest } = profile;
  const { coverLetterTemplate: _t, ...guidance } = rest.essayGuidance;
  const r = await ctx.ai.call(
    {
      system: EDIT_PROMPT,
      context: {
        profile: compactProfile({ ...rest, essayGuidance: guidance }) ?? {},
        resume: resumeText.slice(0, 12000),
      },
      payload: { job: jobBrief(job), ...edit },
      schema: EDIT_SCHEMA,
      validate: (d) => EditZ.parse(d),
      essay: true,
      timeoutMs: ctx.settings.requestTimeoutMs * 2,
      signal: ctx.signal,
    },
    { model: ctx.model, fallback: ctx.fallback },
  );
  return trimToLimits(stripMarkdown(r.data.text), edit);
}
