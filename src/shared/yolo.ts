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
export const SOURCE_GROUPS = ["careers", "feeds", ...BOARDS, "jobright"] as const;
export type SourceGroup = (typeof SOURCE_GROUPS)[number];
/** How queued jobs are ordered (within a source, when sources are ranked). */
export const QUEUE_SORTS = ["newest", "oldest", "foundFirst", "foundLast", "random"] as const;
export type QueueSort = (typeof QUEUE_SORTS)[number];

/** The most YOLO applies to in one batch, and so the most applications' debug logs worth keeping. */
export const MAX_BATCH_APPLICATIONS = 500;

export const REAL_INPUT = ["off", "clicks", "typing", "both"] as const;

const reviewBase = z.object({
  mode: z.enum(["off", "all", "matching"]).catch("off"),
  sources: z.array(z.enum(SOURCE_GROUPS)).catch([]),
  fortune: z.enum(["off", "500", "1000"]).catch("off"),
  companies: strs(),
  guessedAnswers: b(false),
  maxPending: n(10, 1, 50),
});
export const SubmissionReviewSchema = reviewBase.catch(() => reviewBase.parse({}));
export type SubmissionReview = z.infer<typeof SubmissionReviewSchema>;

/** Legacy source labels include the ATS used to read a company career site. */
export function sourceGroup(source: string): SourceGroup {
  if ((SOURCE_GROUPS as readonly string[]).includes(source)) return source as SourceGroup;
  return ["greenhouse", "lever", "ashby", "smartrecruiters", "workday"].includes(source) ? "careers" : "feeds";
}

export const SOURCE_NAMES: Record<SourceGroup, string> = {
  careers: "Company career sites",
  feeds: "GitHub job lists",
  linkedin: "LinkedIn",
  indeed: "Indeed",
  glassdoor: "Glassdoor",
  jobright: "Jobright",
};

export function hasReviewRules(r: SubmissionReview): boolean {
  return r.sources.length > 0 || r.fortune !== "off" || r.companies.some((c) => c.trim()) || r.guessedAnswers;
}

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
  /** Days a job the AI judged not a fit is skipped without asking again (yolo/discover.ts). */
  aiRejectDays: n(90, 1, 365),
  boards: z.array(z.enum(BOARDS)).catch(["linkedin", "indeed", "glassdoor"]),
  feeds: strs([SIMPLIFY_FEED]),
  /** Non-empty = read the signed-in user's Jobright recommendations. Its values are unused (once Jobright's GitHub lists). */
  jobright: strs(),
  careerSites: strs(),
  queueSort: z.enum(QUEUE_SORTS).catch("newest"),
  /** Ranks jobs by `sourceOrder` before `queueSort`. */
  queueBySource: b(false),
  // Groups added since the order was saved go last, so they can be moved.
  sourceOrder: z
    .array(z.enum(SOURCE_GROUPS))
    .catch([...SOURCE_GROUPS])
    .transform((o) => [...o, ...SOURCE_GROUPS.filter((g) => !o.includes(g))]),
  email: z.string().catch(""),
  gmailClientId: z.string().catch(""),
  /** The OAuth client's secret: Google's token endpoint asks a Web application client for it (yolo/gmail.ts). */
  gmailClientSecret: z.string().catch(""),
  /** Types one-time codes sites email to the YOLO address. */
  emailCodes: b(true),
  /** Opens a verification link a site emails, only when the application can't go on without it. */
  verifyLinks: b(true),
  reapplyManual: b(false),
  warnOnYoloApplied: b(true),
  tabFallback: b(true),
  /**
   * On pages a bot check grades, in a tab: which of the run's input goes through Chrome's debugger as a person's
   * (trusted) events; any failure falls back to script input.
   */
  realInput: z.enum(REAL_INPUT).catch("off"),
  /** Required cover-letter uploads always get one written; this extends it to optional ones. */
  optionalCoverLetters: b(false),
  /** Résumé upload fields: the best-fitting résumé variant, or the LaTeX résumé tailored by the AI. Never left blank. */
  resumeUpload: z.enum(["variants", "tailor"]).catch("variants"),
  /** Check filled pages against the profile and correct missed or wrong answers. */
  reviewFills: b(true),
  /** Use AI to find the next step when the usual navigation gets stuck. */
  aiNavigation: b(true),
  /** Human review before the final application submission, independently of AI form review. */
  submissionReview: SubmissionReviewSchema,
});
export const YoloSchema = base.catch(() => base.parse({}));
export type Yolo = z.infer<typeof YoloSchema>;
export const defaultYolo = (): Yolo => YoloSchema.parse({});

/** Split legacy review preferences without changing which AI features are enabled. */
export const migrateYoloReview = (value: unknown, reviewFills: boolean): Yolo => {
  const previous = { reviewFills, ...(value && typeof value === "object" ? value : {}) };
  return YoloSchema.parse({ aiNavigation: previous.reviewFills, ...previous });
};

/** A posting found by a source. */
export interface Listing {
  url: string;
  company: string;
  title: string;
  location: string;
  postedAt?: number;
  source: string;
  sourceGroups?: SourceGroup[];
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
  sourceGroups: z.array(z.enum(SOURCE_GROUPS)).optional().catch(undefined),
  postedAt: z.number().catch(0),
  addedAt: z.number().catch(0),
  /** Times the job was restarted after the computer slept or the browser restarted mid-application. */
  retries: z.number().optional().catch(undefined),
  /** In-flight only: past Submit, so a browser restart records it rather than applying again. */
  submitted: z.boolean().optional().catch(undefined),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

export const ApplicationSchema = QueueItemSchema.omit({
  listing: true,
  postedAt: true,
  addedAt: true,
  retries: true,
  submitted: true,
}).extend({
  /** The confirmation page a submission ended on. */
  doneUrl: z.string().catch(""),
  mode: z.enum(["yolo", "manual"]).catch("yolo"),
  status: z.enum(["submitted", "needs", "failed", "skipped", "review"]).catch("failed"),
  review: z
    .object({
      reasons: strs(),
      /** First successful preparation: remains unchanged after refill or manual submission. */
      preparedAt: z.number().catch(0),
    })
    .optional()
    .catch(undefined),
  submittedBy: z.enum(["user", "auto"]).optional().catch(undefined),
  reason: z.string().catch(""),
  /** Answers YOLO made up where the profile had none, for the user to review. */
  guesses: z.array(z.object({ q: z.string(), a: z.string() })).catch([]),
  /** What else the run did worth knowing: the résumé tailored, or why it wasn't. */
  notes: z.array(z.string()).catch([]).optional(),
  at: z.number().catch(0),
});
export type Application = z.infer<typeof ApplicationSchema>;
export type Guess = Application["guesses"][number];

/** How a source fared in a check, worst last. */
export const SOURCE_LEVELS = ["ok", "info", "warn", "error"] as const;
export type SourceLevel = (typeof SOURCE_LEVELS)[number];
const level = z.enum(SOURCE_LEVELS).catch("ok");
const SourceRowSchema = z.object({
  /** One feed, career site, or "query · location" search. */
  label: z.string().catch(""),
  found: z.number().catch(0),
  problem: z.string().catch(""),
  level,
});
const SourceGroupCheckSchema = z.object({
  group: z.enum(SOURCE_GROUPS),
  /** Read; the counts past `found` are filled in when the check finishes. */
  done: b(false),
  found: z.number().catch(0),
  /** Passed the user's filters. */
  matched: z.number().catch(0),
  /** Of those, not already queued or judged not a fit by the AI. */
  fresh: z.number().catch(0),
  queued: z.number().catch(0),
  /** Why found postings weren't queued → how many. */
  drops: z.record(z.string(), z.number()).catch({}),
  rows: z.array(SourceRowSchema).catch([]),
  problem: z.string().catch(""),
  level,
});
/** The latest discovery's report, per enabled source: what each read and why it queued what it did. */
export const SourceCheckSchema = z.object({
  at: z.number().catch(0),
  /** A mid-batch top-up rather than a batch's start. */
  topUp: b(false),
  /** 0 while sources are being read. */
  doneAt: z.number().catch(0),
  /** Why discovery stopped early, if it did. */
  error: z.string().catch(""),
  groups: z.array(SourceGroupCheckSchema).catch([]),
});
export type SourceCheck = z.infer<typeof SourceCheckSchema>;
export type SourceGroupCheck = SourceCheck["groups"][number];
export type SourceRow = SourceGroupCheck["rows"][number];

export const VaultEntrySchema = z.object({
  email: z.string(),
  iv: z.string(),
  ct: z.string(),
  createdAt: z.number().catch(0),
});

export const YoloStateSchema = z.object({
  reviewUpdatedAt: z.number().catch(0),
  lastCheckAt: z.number().catch(0),
  /** When the current batch started: its submissions are the ones since. */
  batchAt: z.number().catch(0),
  pausedUntil: z.number().catch(0),
  pauseReason: z.string().catch(""),
  gmailNeedsAuth: b(false),
  /** Gmail last answered as signed in (Connect, or the options page's silent check). */
  gmailConnected: b(false),
  /** Jobright's feed last answered 401: the user isn't signed in to jobright.ai in this browser. */
  jobrightSignedOut: b(false),
  /** Indeed's account page last sent the user to sign in: they aren't signed in to indeed.com in this browser. */
  indeedSignedOut: b(false),
  /** Indeed's search last showed a bot check (Cloudflare) instead of results. */
  indeedBlocked: b(false),
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
  pendingReviews?: number;
  preparedBatch?: number;
  nextCheckAt: number | null;
  running: string | null;
  paused: string;
  /** Sources YOLO is on for but can't read right now, for the user to tend to (empty while YOLO is off). */
  warnings: string[];
  /** Sources that had problems in the latest finished source check (0 while YOLO is off). */
  sourceProblems?: number;
}
