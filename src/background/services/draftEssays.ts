// §10.8.3 essay drafting.
import { stripMarkdown, trimToLimits } from "../../shared/essay";
import { plainDashes, RE_AI_TELL } from "../../shared/injection";
import type { EssayItem, JobContext, Profile } from "../../shared/types";
import { BadOutputError, BlockedError } from "../gemini/errors";
import { ESSAYS_PROMPT } from "../gemini/prompts";
import { ESSAYS_SCHEMA, EssaysZ } from "../gemini/schemas";
import { jobBrief } from "./jobBrief";
import { compactProfile, type ServiceCtx } from "./mapFields";

export interface EssayResult {
  fieldId: string;
  text: string | null;
  note?: string;
}

export async function draftEssays(
  ctx: ServiceCtx,
  items: EssayItem[],
  profile: Profile,
  job: JobContext | null,
): Promise<EssayResult[]> {
  const { resumeText, learnedAnswers: _l, ...rest } = profile;
  const resume = resumeText.slice(0, 12000);
  const letterContext = { profile: compactProfile(rest) ?? {}, resume };
  // The cover letter template goes only with cover letters: beside a "Why us?" question, the model wrote a letter
  // ("Dear Hiring Team, …") in its words.
  const { coverLetterTemplate: _t, ...guidance } = rest.essayGuidance;
  const essayContext = { profile: compactProfile({ ...rest, essayGuidance: guidance }) ?? {}, resume };
  const base = { job: jobBrief(job) };
  const target = (i: EssayItem) =>
    i.maxWords || i.maxChars
      ? undefined
      : i.kind === "cover_letter"
        ? ctx.settings.coverLetterDefaultWords
        : ctx.settings.essayDefaultWords;

  async function run(batch: EssayItem[]): Promise<EssayResult[]> {
    try {
      const r = await ctx.ai.call(
        {
          system: ESSAYS_PROMPT,
          context: batch.some((i) => i.kind === "cover_letter") ? letterContext : essayContext,
          payload: { ...base, items: batch.map((i) => ({ ...i, targetWords: target(i) })) },
          schema: ESSAYS_SCHEMA,
          validate: (d) => EssaysZ.parse(d),
          essay: true,
          timeoutMs: ctx.settings.requestTimeoutMs * 2,
          signal: ctx.signal,
        },
        { model: ctx.model, fallback: ctx.fallback },
      );
      return batch.map((item) => {
        const e = r.data.essays.find((x) => x.fieldId === item.fieldId);
        // Em dashes typed as a person does, before the limits are counted.
        const text = e ? trimToLimits(plainDashes(stripMarkdown(e.text)), item) : "";
        // A draft that gives itself away as an AI's ("As an AI…") is never sent.
        if (RE_AI_TELL.test(text)) return { fieldId: item.fieldId, text: null, note: "The draft read as AI-written" };
        return text
          ? { fieldId: item.fieldId, text }
          : { fieldId: item.fieldId, text: null, note: "No draft returned" };
      });
    } catch (e) {
      if (!(e instanceof BadOutputError || e instanceof BlockedError)) throw e;
      if (batch.length > 1) return (await Promise.all(batch.map((i) => run([i])))).flat();
      return [
        {
          fieldId: batch[0].fieldId,
          text: null,
          note: e instanceof BlockedError ? "AI declined this field" : "Draft failed",
        },
      ];
    }
  }

  const batches: EssayItem[][] = [];
  for (const group of [items.filter((i) => i.kind === "cover_letter"), items.filter((i) => i.kind !== "cover_letter")])
    for (let i = 0; i < group.length; i += 4) batches.push(group.slice(i, i + 4));
  return (await Promise.all(batches.map(run))).flat();
}
