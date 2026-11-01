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
const claudeTasks = z.object({ fill: claudeTask, write: claudeTask, resume: claudeTask });

/** What the AI is told about tailoring a LaTeX résumé (Documents → AI tailoring prompt). The user may edit it. */
export const DEFAULT_TAILOR_PROMPT = `Tailor this résumé to the job. It should read as the same résumé sharpened for this role, not a rewrite: make the few changes that matter most.

You may:
- Reword bullets to use the job's own terms for skills and tools the résumé already shows. Keep each bullet's meaning, tense and voice, and its length within about 15%.
- Reorder bullets within an entry, and sections, so the most relevant come first. Reorder entries only in sections not ordered by date (such as projects).
- Drop up to 2 bullets that matter least for this job, but never an entire entry and never an entry's only bullet.
- Add up to 2 bullets to existing experiences or projects that expand on details the résumé already states about them.
- Add a skill to the skills section only if the job asks for it and it is in the candidate's Profile skills.
- Lightly reword a summary or objective to fit the role.

You must not:
- Invent or exaggerate anything: no employers, titles, dates, projects, degrees, awards, metrics, numbers, tools or skills that the résumé (or, for skills, the Profile) doesn't have.
- Change names, contact details, dates, company or school names, job titles, degrees or grades.
- Make the résumé longer: balance any added text with shorter or dropped bullets so it keeps its number of pages.
- Change its spelling conventions (US or UK English), capitalization or punctuation style.`;

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
  /**
   * Résumé upload fields: the résumé variant that best fits the job (Documents), the LaTeX résumé tailored to it by
   * the AI, or left for the user. YOLO sets its own.
   */
  resumeUpload: z.enum(["variants", "tailor", "flag"]).catch("variants"),
  /** The AI tailor's instructions; one for autofill and YOLO. */
  tailorPrompt: z.string().catch(DEFAULT_TAILOR_PROMPT),
  showBadges: b(true),
  learnPrompts: b(false),
  excludedHosts: z.array(z.string()).catch([]),
  maxFieldsPerRequest: n(40, 1, 200),
  requestTimeoutMs: n(25000, 1000, 120000),
  maxConcurrentRequests: n(4, 1, 16),
  debugLogging: b(false),
  /** How many YOLO applications' debug logs are kept. */
  debugLogLimit: n(100, 1, MAX_BATCH_APPLICATIONS),
});

export const SettingsSchema = base.catch(() => base.parse({}));
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings = (): Settings => SettingsSchema.parse({});
export type AiTask = keyof Settings["claude"];
export type ClaudeTask = Settings["claude"][AiTask];
