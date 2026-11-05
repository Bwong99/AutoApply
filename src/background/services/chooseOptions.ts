// §10.8.2 follow-up option choice for options discovered late.
import type { Choice, ChooseItem, Profile } from "../../shared/types";
import { screeningDecision } from "../../shared/screening";
import { BadOutputError, BlockedError } from "../gemini/errors";
import { CHOOSE_OPTIONS_PROMPT } from "../gemini/prompts";
import { CHOOSE_SCHEMA, ChooseZ } from "../gemini/schemas";
import { compactProfile, numbered, withoutEssayStyle, type ServiceCtx } from "./mapFields";

export function validateChoices(items: ChooseItem[], raw: Choice[]): Choice[] {
  const byId = new Map(items.map((i) => [i.fieldId, i]));
  const out = new Map<string, Choice>();
  for (const c of raw) {
    const item = byId.get(c.fieldId);
    if (!item || out.has(c.fieldId)) continue;
    let idx = c.optionIndexes;
    if (
      !idx?.length ||
      c.confidence === "low" ||
      idx.some((i) => !Number.isInteger(i) || i < 0 || i >= item.options.length)
    )
      idx = null;
    else if (!item.multiple) idx = [idx[0]];
    out.set(c.fieldId, { fieldId: c.fieldId, optionIndexes: idx, confidence: idx ? c.confidence : "low" });
  }
  return items.map((i) => out.get(i.fieldId) ?? { fieldId: i.fieldId, optionIndexes: null, confidence: "low" });
}

/** The profile resolves vague answers: "Asian" among East/South/Southeast Asian, "Citizen" (SpaceX: "U.S. citizen"). */
export async function chooseOptions(ctx: ServiceCtx, items: ChooseItem[], profile: Profile): Promise<Choice[]> {
  const local = new Map<string, Choice>();
  for (const i of items) {
    const d = screeningDecision(
      {
        id: i.fieldId,
        label: i.question,
        kind: i.multiple ? "multiselect" : "select",
        options: i.options,
        optionsKnown: true,
        required: true,
      },
      profile,
    );
    if (d)
      local.set(i.fieldId, { fieldId: i.fieldId, optionIndexes: d.optionIndexes ?? null, confidence: d.confidence });
  }
  const { resumeText: _resume, learnedAnswers: _learned, ...rest } = profile;
  const pending = items.filter((i) => !local.has(i.fieldId));
  const batches: ChooseItem[][] = [];
  for (let i = 0; i < pending.length; i += 20) batches.push(pending.slice(i, i + 20));
  const results = await Promise.all(
    batches.map(async (batch) => {
      try {
        const r = await ctx.ai.call(
          {
            system: CHOOSE_OPTIONS_PROMPT,
            context: { profile: compactProfile(withoutEssayStyle(rest)) },
            payload: { items: batch.map((i) => ({ ...i, options: numbered(i.options) })) },
            schema: CHOOSE_SCHEMA,
            validate: (d) => ChooseZ.parse(d),
            timeoutMs: ctx.settings.requestTimeoutMs,
            signal: ctx.signal,
          },
          { model: ctx.model, fallback: ctx.fallback },
        );
        return validateChoices(batch, r.data.choices);
      } catch (e) {
        if (e instanceof BadOutputError || e instanceof BlockedError) return validateChoices(batch, []);
        throw e;
      }
    }),
  );
  const mapped = new Map(results.flat().map((c) => [c.fieldId, c]));
  return items.map((i) => local.get(i.fieldId) ?? mapped.get(i.fieldId)!);
}
