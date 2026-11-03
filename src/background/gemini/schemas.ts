// Appendix B response schemas (Gemini OpenAPI subset) and their zod mirrors.
import { z } from "zod";
import type { Decision } from "../../shared/types";

const nullableStr = { type: "STRING", nullable: true };
const CONFIDENCE = { type: "STRING", enum: ["high", "medium", "low"] };

const DECISION_PROPS = {
  fieldId: { type: "STRING" },
  action: { type: "STRING", enum: ["fill", "essay", "consent", "skip", "flag"] },
  text: nullableStr,
  // Before optionIndexes: the model picks the right index more often once it has written the option it means.
  intendedAnswer: nullableStr,
  optionIndexes: { type: "ARRAY", items: { type: "INTEGER" }, nullable: true },
  searchQuery: nullableStr,
  checked: { type: "BOOLEAN", nullable: true },
  documentId: nullableStr,
  confidence: CONFIDENCE,
  sources: { type: "ARRAY", items: { type: "STRING" } },
  note: nullableStr,
};

export const MAPPING_SCHEMA = {
  type: "OBJECT",
  properties: {
    decisions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: DECISION_PROPS,
        // Without this Gemini orders optional keys alphabetically, so "text" is last: when the model wants to add
        // "sources" after it, the grammar forbids closing into another key and the reply spills into the string.
        propertyOrdering: Object.keys(DECISION_PROPS),
        required: ["fieldId", "action", "confidence"],
      },
    },
  },
  required: ["decisions"],
};

export const AUDIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdicts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { fieldId: { type: "STRING" }, supported: { type: "BOOLEAN" } },
        required: ["fieldId", "supported"],
      },
    },
  },
  required: ["verdicts"],
};

export const CHOOSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    choices: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          fieldId: { type: "STRING" },
          optionIndexes: { type: "ARRAY", items: { type: "INTEGER" }, nullable: true },
          confidence: CONFIDENCE,
        },
        required: ["fieldId", "confidence"],
      },
    },
  },
  required: ["choices"],
};

export const ESSAYS_SCHEMA = {
  type: "OBJECT",
  properties: {
    essays: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { fieldId: { type: "STRING" }, text: { type: "STRING" } },
        required: ["fieldId", "text"],
      },
    },
  },
  required: ["essays"],
};

export const VALIDATION_SCHEMA = {
  type: "OBJECT",
  properties: { ok: { type: "BOOLEAN" } },
  required: ["ok"],
};

const opt = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);
const Confidence = z.enum(["high", "medium", "low"]);

export const MappingZ = z.object({
  decisions: z.array(
    z.object({
      fieldId: z.string(),
      action: z.enum(["fill", "essay", "consent", "skip", "flag"]),
      text: opt(z.string()),
      optionIndexes: opt(z.array(z.number())),
      intendedAnswer: opt(z.string()),
      searchQuery: opt(z.string()),
      checked: opt(z.boolean()),
      documentId: opt(z.string()),
      confidence: Confidence,
      sources: opt(z.array(z.string())),
      note: opt(z.string()),
    }),
  ),
});
export type RawDecision = Omit<Decision, "suggestion">;

export const AuditZ = z.object({ verdicts: z.array(z.object({ fieldId: z.string(), supported: z.boolean() })) });

export const ChooseZ = z.object({
  choices: z.array(
    z.object({
      fieldId: z.string(),
      optionIndexes: z
        .array(z.number())
        .nullish()
        .transform((v) => v ?? null),
      confidence: Confidence,
    }),
  ),
});

export const EDIT_SCHEMA = {
  type: "OBJECT",
  properties: { text: { type: "STRING" } },
  required: ["text"],
};
export const EditZ = z.object({ text: z.string() });

export const EssaysZ = z.object({ essays: z.array(z.object({ fieldId: z.string(), text: z.string() })) });

export const ValidationZ = z.object({ ok: z.boolean() });

export const RELEVANCE_SCHEMA = {
  type: "OBJECT",
  properties: { keep: { type: "ARRAY", items: { type: "INTEGER" } } },
  required: ["keep"],
};
export const RelevanceZ = z.object({ keep: z.array(z.number()) });

// Résumé tailoring: edit operations on the LaTeX body's numbered units (shared/latex.ts).
export const TAILOR_SCHEMA = {
  type: "OBJECT",
  properties: {
    edits: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { id: { type: "STRING" }, text: { type: "STRING" } },
        required: ["id", "text"],
      },
    },
    add: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { after: { type: "STRING" }, text: { type: "STRING" } },
        required: ["after", "text"],
      },
    },
    remove: { type: "ARRAY", items: { type: "STRING" } },
    order: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { group: { type: "STRING" }, items: { type: "ARRAY", items: { type: "STRING" } } },
        required: ["group", "items"],
      },
    },
  },
  required: ["edits", "add", "remove", "order"],
};
export const TailorZ = z.object({
  edits: z.array(z.object({ id: z.string(), text: z.string() })).catch([]),
  add: z.array(z.object({ after: z.string(), text: z.string() })).catch([]),
  remove: z.array(z.string()).catch([]),
  order: z.array(z.object({ group: z.string(), items: z.array(z.string()) })).catch([]),
});
