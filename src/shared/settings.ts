import { z } from "zod";
import { MAX_BATCH_APPLICATIONS } from "./yolo";

const b = (d: boolean) => z.boolean().catch(d);
const n = (d: number, min: number, max: number) => z.number().int().min(min).max(max).catch(d);

/** What the Claude bridge passes on claude's command line as a model or effort (src/native). */
export const CLAUDE_ARG = /^[a-z0-9.-]{0,32}$/;

/** A Claude Code model (an alias or id from its model list) and effort level; "": Claude Code's own default. */
const claudeTask = z
  .object({
    model: z.string().regex(CLAUDE_ARG).catch(""),
    effort: z.enum(["", "low", "medium", "high", "xhigh", "max"]).catch(""),
  })
  .catch({ model: "", effort: "" });
const claudeTasks = z.object({
  fill: claudeTask,
  write: claudeTask,
  resume: claudeTask,
  /** The AI review of each filled page and YOLO's navigator: the strongest model, thinking hardest (accuracy first). */
  review: z
    .object({ model: z.string().regex(CLAUDE_ARG), effort: z.enum(["", "low", "medium", "high", "xhigh", "max"]) })
    .catch({ model: "opus", effort: "high" }),
});

const TAILOR_PROMPT_MAY = `You may:
- Reword bullets to use the job's own terms for skills and tools the résumé already shows. Keep each bullet's meaning, tense and voice, and its length within about 15%.
- Reorder bullets within an entry, and sections, so the most relevant come first. Reorder entries only in sections not ordered by date (such as projects).`;

const TAILOR_PROMPT_REST = `- Add up to 2 bullets to existing experiences or projects that expand on details the résumé already states about them.
- Add skills to the skills section only if the job asks for it and it is in the candidate's Profile skills.
- Lightly reword a summary or objective to fit the role.

You must not:
- Invent or exaggerate anything: no employers, titles, dates, projects, degrees, awards, metrics, numbers, tools or skills that the résumé (or, for skills, the Profile) doesn't have.
- Change names, contact details, dates, company or school names, job titles, degrees or grades.
- Make the résumé longer: balance any added text with shorter or dropped bullets.
- Change its spelling conventions (US or UK English), capitalization or punctuation style.`;

const TAILOR_PROMPT_HEAD = `Tailor this résumé to the job. It should read as the same résumé sharpened for this role, not a rewrite: make the few changes that matter most.`;

/**
 * What the AI is told about tailoring a LaTeX résumé (Documents → AI tailoring prompt). The user may edit it. The
 * one-page limit isn't part of it: the "Keep the tailored résumé to one page" setting adds it (gemini/prompts.ts).
 */
export const DEFAULT_TAILOR_PROMPT = `${TAILOR_PROMPT_HEAD}

${TAILOR_PROMPT_MAY}
- Drop up to 2 bullets that matter least for this job, but never an entire entry.
${TAILOR_PROMPT_REST}`;

/** The default prompt before the one-page limit became a setting: a prompt still equal to it gets the new default. */
export const LEGACY_TAILOR_PROMPT = `${TAILOR_PROMPT_HEAD}

You must:
- Keep the résumé to one page.
  - If it runs over, remove whole entries until it fits, starting with the entry least relevant to this job, regardless of section. When entries are about equally relevant, remove Extracurriculars before Projects, and Projects before Work Experience.

${TAILOR_PROMPT_MAY}
- Drop up to 2 bullets that matter least for this job, but never an entire entry, except to meet the one-page limit.
${TAILOR_PROMPT_REST}`;

const base = z.object({
  /** Gemini with API keys, or Claude through the user's own Claude Code and plan (background/claude). */
  aiProvider: z.enum(["gemini", "claude"]).catch("gemini"),
  /** Per task: fill = autofill and YOLO's relevance check, write = essays and cover letters, resume = résumé import. */
  claude: claudeTasks.catch(() => claudeTasks.parse({})),
  overwritePrefilled: b(false),
  autoAcceptAcknowledgements: b(true),
  optionalConsents: z.enum(["ask", "accept", "decline"]).catch("decline"),
  draftEssays: b(true),
  essayDefaultWords: n(150, 10, 2000),
  coverLetterDefaultWords: n(300, 10, 2000),
  /** If no cover letter is uploaded in Documents, generate a tailored cover letter. YOLO sets its own. */
  coverLetterPdfs: b(false),
  /** Generated cover letter PDFs (autofill and YOLO) never run past one page; one that would isn't uploaded. */
  coverLetterOnePage: b(true),
  /**
   * Résumé upload fields: the résumé variant that best fits the job (Documents), the LaTeX résumé tailored to it by
   * the AI, or left for the user. YOLO sets its own.
   */
  resumeUpload: z.enum(["variants", "tailor", "flag"]).catch("variants"),
  /** The AI tailor's instructions; one for autofill and YOLO. */
  tailorPrompt: z
    .string()
    .transform((p) => (p === LEGACY_TAILOR_PROMPT ? DEFAULT_TAILOR_PROMPT : p))
    .catch(DEFAULT_TAILOR_PROMPT),
  /** AI tailor (autofill and YOLO) never uploads a résumé over one page: tailored, or the fallback. */
  tailorOnePage: b(true),
  showBadges: b(true),
  learnPrompts: b(false),
  excludedHosts: z.array(z.string()).catch([]),
  maxFieldsPerRequest: n(40, 1, 200),
  requestTimeoutMs: n(25000, 1000, 120000),
  maxConcurrentRequests: n(4, 1, 16),
  debugLogging: b(false),
  /**
   * After each fill, an AI reads the page as shown and checks every answer against the profile: it corrects wrong
   * ones, fills what the scan missed, and flags the rest (content/review). Manual fills only; YOLO sets its own.
   */
  reviewFills: b(true),
  /** How long one review (or YOLO navigator) call may take: these think longer than a fill's calls. */
  reviewTimeoutMs: n(180000, 10000, 600000),
  /** How many YOLO applications' debug logs are kept. */
  debugLogLimit: n(100, 1, MAX_BATCH_APPLICATIONS),
});

export const SettingsSchema = base.catch(() => base.parse({}));
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings = (): Settings => SettingsSchema.parse({});
export type AiTask = keyof Settings["claude"];
export type ClaudeTask = Settings["claude"][AiTask];
