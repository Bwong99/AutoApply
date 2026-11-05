// YOLO's navigator: where a run goes next when its wording rules can't tell (content/yolo/driver.ts). It reads the
// page as text, like the review, and names one control to press; the driver checks that choice before pressing.
import { NAVIGATE_PROMPT } from "../gemini/prompts";
import { NAVIGATE_SCHEMA, NavigateZ, type NavReply } from "../gemini/schemas";
import type { PageFacts } from "../../shared/messages";
import type { ServiceCtx } from "./mapFields";

export interface NavigateInput {
  page: string;
  facts: PageFacts;
  url: string;
  why: string;
  goal: { company: string; title: string };
  history: string[];
}

export async function navigate(ctx: ServiceCtx, input: NavigateInput): Promise<NavReply & { usedModel: string }> {
  const { text: _t, ...facts } = input.facts;
  const r = await ctx.ai.call(
    {
      system: NAVIGATE_PROMPT,
      payload: {
        goal: input.goal,
        why: input.why,
        history: input.history.slice(-15),
        facts: { url: input.url, ...facts },
        page: input.page,
      },
      schema: NAVIGATE_SCHEMA,
      validate: (d) => NavigateZ.parse(d),
      review: true,
      timeoutMs: ctx.settings.reviewTimeoutMs,
      signal: ctx.signal,
    },
    { model: ctx.model, fallback: ctx.fallback },
  );
  return { ...r.data, usedModel: r.usedModel };
}
