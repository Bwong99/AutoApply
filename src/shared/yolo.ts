// YOLO mode: finds new postings on a timer and applies to them end to end (src/background/yolo).
import { z } from "zod";

const b = (d: boolean) => z.boolean().catch(d);
const n = (d: number, min: number, max: number) => z.number().int().min(min).max(max).catch(d);
const strs = (d: string[] = []) => z.array(z.string()).catch(d);

export const SIMPLIFY_FEED =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json";

/** Job boards searched with the user's queries. They only find jobs: applying happens on the employer's own site. */
export const BOARDS = ["linkedin", "indeed", "glassdoor"] as const;
export type Board = (typeof BOARDS)[number];

/** Where a queued job was found, as the queue order ranks it. */
export const SOURCE_GROUPS = ["careers", "feeds", ...BOARDS] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];
/** How queued jobs are ordered (within a source, when sources are ranked). */
export const QUEUE_SORTS = ["newest", "oldest", "foundFirst", "foundLast", "random"] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];

/** The most YOLO applies to in one batch, and so the most applications' debug logs worth keeping. */
export const MAX_BATCH_APPLICATIONS = 500;

const base = z.object({
  enabled: b(false),
  /** Minutes between batches: each finds new jobs, then applies to up to `batchSize` of the queue. */
  intervalMin: n(30, 5, 1440),
  /** Submissions per batch. 0 finds jobs without applying (a dry run). */
  batchSize: n(3, 0, MAX_BATCH_APPLICATIONS),
  queries: strs(),
  locations: strs(),
  remoteOk: b(true),
  postedWithinDays: n(14, 1, 90),
  excludeTitleWords: strs(["senior", "sr", "staff", "principal", "lead", "manager", "director", "ii", "iii", "phd"]),
  skipCompanies: strs(),
  aiRelevanceCheck: b(true),
  boards: z.array(z.enum(BOARDS)).catch(["linkedin", "indeed", "glassdoor"]),
  feeds: strs([SIMPLIFY_FEED]),
  careerSites: strs(),
  queueSort: z.enum(QUEUE_SORTS).catch("newest"),
  /** Ranks jobs by `sourceOrder` before `queueSort`. */
  queueBySource: b(false),
  sourceOrder: z.array(z.enum(SOURCE_GROUPS)).catch([...SOURCE_GROUPS]),
  email: z.string().catch(""),
  gmailClientId: z.string().catch(""),
  /** Types one-time codes sites email to the YOLO address. */
  emailCodes: b(true),
  /** Opens a verification link a site emails, only when the application can't go on without it. */
  verifyLinks: b(true),
  reapplyManual: b(false),
  warnOnYoloApplied: b(true),
  tabFallback: b(true),
  /** Required cover-letter uploads always get one written; this extends it to optional ones. */
  optionalCoverLetters: b(false),
  /** Résumé upload fields: the best-fitting résumé variant, or the LaTeX résumé tailored by the AI. Never left blank. */
  resumeUpload: z.enum(["variants", "tailor"]).catch("variants"),
});
export const YoloSchema = base.catch(() => base.parse({}));
export type Yolo = z.infer<typeof YoloSchema>;
export const defaultYolo = (): Yolo => YoloSchema.parse({});

/** A posting found by a source. */
export interface Listing {
  url: string;
  company: string;
  title: string;
  location: string;
  postedAt?: number;
  source: string;
  /** Applied to on the board itself (LinkedIn Easy Apply, Indeed Apply): not supported yet, so never queued. */
  easyApply?: boolean;
}

export const QueueItemSchema = z.object({
  key: z.string(),
  alt: z.string().catch(""),
  /** The posting's key as found: a board listing's, when `url` is the employer's own posting. */
  listing: z.string().catch(""),
  url: z.string(),
  company: z.string().catch(""),
  title: z.string().catch(""),
  location: z.string().catch(""),
  source: z.string().catch(""),
  postedAt: z.number().catch(0),
  addedAt: z.number().catch(0),
  /** Times the job was restarted after the computer slept or the browser restarted mid-application. */
  retries: z.number().optional().catch(undefined),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const ApplicationSchema = QueueItemSchema.omit({
  listing: true,
  postedAt: true,
  addedAt: true,
  retries: true,
}).extend({
  /** The confirmation page a submission ended on. */
  doneUrl: z.string().catch(""),
  mode: z.enum(["yolo", "manual"]).catch("yolo"),
  status: z.enum(["submitted", "needs", "failed", "skipped"]).catch("failed"),
  reason: z.string().catch(""),
  /** Answers YOLO made up where the profile had none, for the user to review. */
  guesses: z.array(z.object({ q: z.string(), a: z.string() })).catch([]),
  /** What else the run did worth knowing: the résumé tailored, or why it wasn't. */
  notes: z.array(z.string()).catch([]).optional(),
  at: z.number().catch(0),
});
export type Application = z.infer<typeof ApplicationSchema>;
export type Guess = Application["guesses"][number];

export const VaultEntrySchema = z.object({
  email: z.string(),
  iv: z.string(),
  ct: z.string(),
  createdAt: z.number().catch(0),
});

export const YoloStateSchema = z.object({
  lastCheckAt: z.number().catch(0),
  /** When the current batch started: its submissions are the ones since. */
  batchAt: z.number().catch(0),
  pausedUntil: z.number().catch(0),
  pauseReason: z.string().catch(""),
  gmailNeedsAuth: b(false),
  /** Gmail last answered as signed in (Connect, or the options page's silent check). */
  gmailConnected: b(false),
});
export type YoloState = z.infer<typeof YoloStateSchema>;

export interface YoloStatus {
  enabled: boolean;
  /** Search queries set: YOLO has something to look for. */
  searches: number;
  appliedBatch: number;
  batchSize: number;
  queued: number;
  needsYou: number;
  nextCheckAt: number | null;
  running: string | null;
  paused: string;
}
