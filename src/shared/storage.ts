import { z } from "zod";
import { ProfileSchema } from "./profileSchema";
import { SettingsSchema } from "./settings";
import type { ClaudeModel, DocumentMeta, JobContext, Pay, TabStatus } from "./types";
import {
  ApplicationSchema,
  migrateYoloReview,
  QueueItemSchema,
  SourceCheckSchema,
  VaultEntrySchema,
  YoloSchema,
  YoloStateSchema,
} from "./yolo";

export const SCHEMA_VERSION = 4;

const ThinkingSchema = z.union([
  z.object({ kind: z.literal("level"), value: z.enum(["minimal", "low", "high"]) }),
  z.object({ kind: z.literal("budget"), value: z.union([z.literal(0), z.literal(-1)]) }),
  z.object({ kind: z.literal("none") }),
]);

const rec = <T extends z.ZodType>(v: T) =>
  z
    .record(z.string(), z.unknown())
    .catch({})
    .transform((o) => {
      const out: Record<string, z.infer<T>> = {};
      for (const [k, val] of Object.entries(o)) {
        const r = v.safeParse(val);
        if (r.success) out[k] = r.data;
      }
      return out;
    });
const list = <T extends z.ZodType>(v: T) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((a) =>
      a.flatMap((x) => {
        const r = v.safeParse(x);
        return r.success ? [r.data as z.infer<T>] : [];
      }),
    );

export const DocumentMetaSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["resume", "cover_letter", "transcript", "other"]),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  isPrimaryResume: z.boolean(),
  uploadedAt: z.number(),
}) satisfies z.ZodType<DocumentMeta>;

export const ApiKeyEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
  key: z.string(),
  addedAt: z.number(),
});

export const KeyStateSchema = z.object({
  invalid: z.object({ reason: z.string(), at: z.number() }).optional(),
  cooldownUntil: z.number().optional(),
  perModel: z
    .record(z.string(), z.object({ exhaustedUntil: z.number().optional(), unavailableUntil: z.number().optional() }))
    .optional(),
  lastUsedAt: z.number().optional(),
  lastError: z.object({ status: z.number(), message: z.string(), at: z.number() }).optional(),
  successCount: z.number().catch(0),
  errorCount: z.number().catch(0),
});

export const CatalogEntrySchema = z.object({
  firstSeenAt: z.number(),
  apiIndex: z.number(),
  displayName: z.string().catch(""),
  description: z.string().catch(""),
  inputTokenLimit: z.number().catch(0),
  outputTokenLimit: z.number().catch(0),
  thinking: z.boolean().optional(),
  lastSeenAt: z.number(),
});

export const ClaudeModelSchema = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string().catch(""),
}) satisfies z.ZodType<ClaudeModel>;

export const ModelCapsSchema = z.object({
  thinking: ThinkingSchema,
  schema: z.enum(["responseSchema", "promptOnly"]),
  verifiedAt: z.number(),
  essayThinking: ThinkingSchema.optional(),
  reviewThinking: ThinkingSchema.optional(),
});

/** Every chrome.storage.local key and its schema. All reads are validated. */
export const LOCAL_SCHEMAS = {
  schemaVersion: z.number().catch(0),
  settings: SettingsSchema,
  profile: ProfileSchema,
  documentsIndex: list(DocumentMetaSchema),
  apiKeys: list(ApiKeyEntrySchema),
  keyState: rec(KeyStateSchema),
  modelCatalog: rec(CatalogEntrySchema),
  modelListFetchedAt: z.number().catch(0),
  selectedModel: z.string().nullable().catch(null),
  fallbackModel: z.string().nullable().catch(null),
  /** The model the AI review and YOLO's navigator use (Gemini); null: the selected model. */
  reviewModel: z.string().nullable().catch(null),
  modelCapabilities: rec(ModelCapsSchema),
  /** Claude Code answered a Test connection and hasn't failed setup since (background/claude). */
  claudeReady: z.boolean().catch(false),
  /** Options page to reopen after the restart that finishes connecting Claude ("" when none; background CLAUDE_TEST). */
  claudeRestart: z.string().catch(""),
  /** The models Claude Code offers the user's sign-in, in its order (background CLAUDE_MODELS). */
  claudeModels: list(ClaudeModelSchema),
  claudeModelsFetchedAt: z.number().catch(0),
  overlayPos: rec(z.number()),
  yolo: YoloSchema,
  yoloState: YoloStateSchema.catch(() => YoloStateSchema.parse({})),
  /** Every application YOLO made and every one the user submitted after a fill: what is never applied to twice. */
  applications: list(ApplicationSchema),
  yoloQueue: list(QueueItemSchema),
  /** The job a hidden YOLO run is applying to, until it ends: put back in the queue if a browser restart lost the run. */
  yoloInFlight: QueueItemSchema.nullable().catch(null),
  /** Debug logging: the latest YOLO applications' steps, answers and confirmations, oldest first. */
  yoloLogs: list(
    z.object({
      at: z.number(),
      text: z.string(),
      /** The tailored résumé and generated cover letter the run uploaded; `text` in logs from before PDFs were kept. */
      files: z
        .array(z.object({ name: z.string(), base64: z.string().optional(), text: z.string().optional() }))
        .optional(),
    }),
  ),
  /** The latest discovery's per-source report (yolo/sourceCheck.ts), shown whatever Debug logging is set to. */
  yoloSourceCheck: SourceCheckSchema.nullable().catch(null),
  /** Job keys the AI fit check judged not a fit → when (yolo/discover.ts). */
  yoloRejected: rec(z.number()),
  /** Hosts whose bot checks stopped YOLO's hidden frame, latest last: their jobs start in a background tab. */
  yoloTabHosts: list(z.string()),
  /** Company → its ATS board ("greenhouse:lyft"), "" when none was found (yolo/careers.ts). */
  employerBoards: rec(z.string()),
  /** Validators of each source URL's last response, for conditional requests. */
  feedCache: rec(z.object({ etag: z.string().catch(""), modified: z.string().catch("") })),
  /** Site accounts YOLO created, passwords encrypted with a device key (yolo/vault.ts). Never exported. */
  vault: rec(VaultEntrySchema),
  /** Google's refresh token for the YOLO inbox, encrypted like the vault (yolo/gmail.ts). Never exported. */
  gmailRefresh: z.object({ iv: z.string(), ct: z.string() }).nullable().catch(null),
  /**
   * The LaTeX résumé for AI tailoring: its source in doc:tailor-tex and its untailored PDF (the fallback) in
   * doc:tailor-pdf. Not a document: never a variant, never offered for other uploads. null: none uploaded.
   * `fallback`: an optional PDF the user uploaded (doc:tailor-fallback-pdf), used in place of the untailored PDF;
   * its `pages`, counted in Documents, for the one-page limit (absent: uploaded before they were counted).
   */
  tailorResume: z
    .object({
      fileName: z.string(),
      size: z.number(),
      uploadedAt: z.number(),
      pages: z.number().catch(1),
      fallback: z
        .object({
          fileName: z.string(),
          size: z.number(),
          uploadedAt: z.number(),
          pages: z.number().int().positive().optional().catch(undefined),
        })
        .nullable()
        .catch(null),
    })
    .nullable()
    .catch(null),
  /** Résumé document id → its extracted text, for matching résumé variants to jobs (options keeps it in sync). */
  resumeTexts: rec(z.string()),
};

export type LocalKey = keyof typeof LOCAL_SCHEMAS;
export type LocalValues = { [K in LocalKey]: z.output<(typeof LOCAL_SCHEMAS)[K]> };

/**
 * Per-context allow-list (§18.5). Content scripts have no entry: they never touch
 * chrome.storage and get what they need from the background via messages.
 */
export type StorageContext = "background" | "options" | "popup";
const ALLOW: Record<StorageContext, (key: string) => boolean> = {
  background: () => true,
  options: () => true,
  popup: (k) => ["settings", "selectedModel", "modelCatalog", "yoloState"].includes(k),
};

export function createStorage(ctx: StorageContext) {
  const check = (k: string) => {
    if (!ALLOW[ctx](k)) throw new Error(`storage key "${k}" is not allowed in ${ctx}`);
  };

  async function get<K extends LocalKey>(key: K): Promise<LocalValues[K]> {
    check(key);
    const raw = (await chrome.storage.local.get(key))[key];
    return LOCAL_SCHEMAS[key].parse(raw) as LocalValues[K];
  }

  async function getMany<K extends LocalKey>(keys: K[]): Promise<Pick<LocalValues, K>> {
    keys.forEach(check);
    const raw = await chrome.storage.local.get(keys);
    const out = {} as Pick<LocalValues, K>;
    for (const k of keys) out[k] = LOCAL_SCHEMAS[k].parse(raw[k]) as LocalValues[K];
    return out;
  }

  async function set(values: Partial<LocalValues>): Promise<void> {
    Object.keys(values).forEach(check);
    await chrome.storage.local.set(values);
  }

  function onChange(keys: LocalKey[], cb: (changed: Partial<LocalValues>) => void): () => void {
    keys.forEach(check);
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== "local") return;
      const changed: Partial<LocalValues> = {};
      let any = false;
      for (const k of keys)
        if (k in changes) {
          (changed as Record<string, unknown>)[k] = LOCAL_SCHEMAS[k].parse(changes[k].newValue);
          any = true;
        }
      if (any) cb(changed);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }

  async function getDoc(id: string): Promise<string | null> {
    check(`doc:${id}`);
    const v = (await chrome.storage.local.get(`doc:${id}`))[`doc:${id}`] as { base64?: unknown } | undefined;
    return typeof v?.base64 === "string" ? v.base64 : null;
  }

  async function setDoc(id: string, base64: string): Promise<void> {
    check(`doc:${id}`);
    await chrome.storage.local.set({ [`doc:${id}`]: { base64 } });
  }

  async function removeDoc(id: string): Promise<void> {
    check(`doc:${id}`);
    await chrome.storage.local.remove(`doc:${id}`);
  }

  return { get, getMany, set, onChange, getDoc, setDoc, removeDoc };
}

/** Runs once at service-worker start: stamps schemaVersion and rewrites values into validated shape. */
export async function migrate(): Promise<void> {
  const raw = await chrome.storage.local.get(["schemaVersion", "settings", "profile", "yolo"]);
  if (raw.schemaVersion === SCHEMA_VERSION) return;
  const settings = LOCAL_SCHEMAS.settings.parse(raw.settings);
  await chrome.storage.local.set({
    schemaVersion: SCHEMA_VERSION,
    settings,
    profile: LOCAL_SCHEMAS.profile.parse(raw.profile),
    yolo: migrateYoloReview(raw.yolo, settings.reviewFills),
  });
  // v4: every job not in Applications can be queued; the old every-job-looked-at memory would still block them.
  await chrome.storage.local.remove("yoloSeen");
}

// ---------- chrome.storage.session (background only) ----------
/** The pay ranges of the last job posting a tab showed, and that tab's address then. */
export interface JobPay {
  pays: Pay[];
  url: string;
  at: number;
}

export const session = {
  async getJobContext(tabId: number): Promise<JobContext | null> {
    return ((await chrome.storage.session.get(`jobContext:${tabId}`))[`jobContext:${tabId}`] as JobContext) ?? null;
  },
  setJobContext: (tabId: number, ctx: JobContext) => chrome.storage.session.set({ [`jobContext:${tabId}`]: ctx }),
  async getJobPay(tabId: number): Promise<JobPay | null> {
    return ((await chrome.storage.session.get(`jobPay:${tabId}`))[`jobPay:${tabId}`] as JobPay) ?? null;
  },
  setJobPay: (tabId: number, p: JobPay) => chrome.storage.session.set({ [`jobPay:${tabId}`]: p }),
  async getTabStatus(tabId: number): Promise<TabStatus | null> {
    return ((await chrome.storage.session.get(`tabStatus:${tabId}`))[`tabStatus:${tabId}`] as TabStatus) ?? null;
  },
  setTabStatus: (tabId: number, s: TabStatus) => chrome.storage.session.set({ [`tabStatus:${tabId}`]: s }),
  /** YOLO's run state, temporary documents and Gmail access token (yolo/*), cleared with the browser session. */
  async get<T>(key: string): Promise<T | null> {
    return ((await chrome.storage.session.get(key))[key] as T) ?? null;
  },
  set: (key: string, value: unknown) => chrome.storage.session.set({ [key]: value }),
  remove: (key: string) => chrome.storage.session.remove(key),
  /** Removes the per-tab keys of tabs not in `open`. */
  async pruneTabs(open: Set<number | undefined>) {
    const closed = Object.keys(await chrome.storage.session.get(null)).filter((k) => {
      const id = /^(jobContext|jobPay|tabStatus):(\d+)$/.exec(k)?.[2];
      return id !== undefined && !open.has(Number(id));
    });
    if (closed.length) await chrome.storage.session.remove(closed);
  },
};
