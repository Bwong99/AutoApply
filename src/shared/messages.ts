import type {
  ApiError,
  Choice,
  ChooseItem,
  Decision,
  DocumentMeta,
  AnswerEdit,
  EssayItem,
  FieldDescriptor,
  FrameStatus,
  JobBrief,
  JobContext,
  LearnedAnswerInput,
  Pay,
  Profile,
  RuntimeConfig,
  Settings,
  TabStatus,
} from "./types";
import type { Guess, REAL_INPUT, YoloStatus } from "./yolo";

/** What a YOLO driver reads off its page; the background decides what kind of step that is (yolo/classify.ts). */
export interface PageFacts {
  /** Visible text, its start. */
  text: string;
  title: string;
  path: string;
  headings: string;
  /** Visible error and alert messages. */
  alerts: string;
  /** Fields the fill scan sees. */
  fields: number;
  passwords: number;
  codeInput: boolean;
  /** A visible CAPTCHA challenge. */
  captcha: boolean;
  /**
   * A bot check grades what the page submits: an invisible score check (reCAPTCHA, hCaptcha, Turnstile) is loaded, or a
   * bot-detection service (Akamai, HUMAN, DataDome, Imperva, Kasada) set its cookie.
   */
  scored: boolean;
  /** An ATS form in an iframe the run could load on its own. */
  embedded: boolean;
  apply: boolean;
  /** Whether the Apply candidate navigates, starts an application, or submits an existing form. */
  applyKind: "none" | "link" | "entry" | "submit";
  /** The Apply candidate belongs to a native form. */
  applyInForm: boolean;
  /** Required fields the scanner sees, distinct from job-page search/newsletter chrome. */
  requiredFields: number;
  /** A Next / Continue / Submit control. */
  onward: boolean;
}

/** A pointer moved to (or clicked at) a point, or text typed into the focused box. */
export type RealOp = { kind: "move" | "click"; x: number; y: number } | { kind: "type"; text: string };

export type StepKind =
  | "captcha"
  | "success"
  | "blocked"
  | "closed"
  /** The site's bot score turned the submission down and left no form: loading the page again retries it. */
  | "flagged"
  | "verify"
  | "reset"
  | "signup"
  | "signin"
  | "embedded"
  | "form"
  | "job"
  | "unknown";

/** How a YOLO run ended in its frame. "blocked": the page refused to work hidden, so the tab host may retry it. */
export type YoloResult =
  | { status: "submitted"; doneUrl: string; guesses?: Guess[] }
  /** `retryAt`: the AI's quota or usage limit ran out; the job goes back in the queue until then. */
  | { status: "needs" | "failed" | "skipped" | "blocked"; reason: string; guesses?: Guess[]; retryAt?: number }
  /** `walled`: the page was a bot check (Cloudflare's "Just a moment…"), not the one asked for. */
  | { status: "scraped"; links: { href: string; text: string }[]; walled?: boolean };

/** Typed message protocol (§17). `C` = content script, `B` = background, `O` = options page. */
export type Message =
  // C → B
  | { type: "GET_RUNTIME_CONFIG"; yolo?: boolean }
  | { type: "GET_DOCUMENT"; id: string }
  | { type: "GET_DOC_JOB"; id: string }
  | { type: "SET_JOB_CONTEXT"; ctx: JobContext }
  /** A job page opened in a new tab: keep the posting of the tab that opened it, while that tab still shows it. */
  | { type: "BORROW_POSTING" }
  /** Which résumé variant to upload for the tab's job. */
  | { type: "PICK_RESUME" }
  /** `passive`: read on page load, outside a fill. */
  | { type: "SET_JOB_PAY"; pays: Pay[]; passive?: boolean }
  /** `uploads`: labels of the page's upload boxes, for questions about attached documents. */
  | { type: "MAP_FIELDS"; fields: FieldDescriptor[]; host: string; groupId: string; yolo?: boolean; uploads?: string[] }
  /** The user submitted a form we filled; `doneUrl` once its confirmation shows. */
  | { type: "APPLY_ATTEMPT"; job: { url: string; company: string; title: string }; doneUrl?: string }
  // YOLO driver C → B
  | { type: "YOLO_HELLO"; url: string }
  /** `guesses`: this page's made-up answers so far; the run keeps every page's. */
  | { type: "YOLO_STEP"; facts: PageFacts; url: string; guesses: Guess[] }
  | { type: "YOLO_RESULT"; result: YoloResult }
  /**
   * After a fill, before the page moves on: its made-up answers, and with debug logging each field on the page and
   * its answer, keyed by document and field.
   */
  | { type: "YOLO_ANSWERS"; answers: Record<string, Guess>; guesses: Guess[] }
  | { type: "YOLO_CREDENTIAL"; site: string; create: boolean }
  | { type: "YOLO_WAIT_EMAIL"; since: number; want: "link" | "code" }
  | { type: "COVER_LETTER_PDF"; question: string }
  /** The résumé to upload for the tab's job in AI tailor mode: tailored, else the untailored fallback. */
  | { type: "TAILOR_RESUME"; groupId: string }
  /** Real (trusted) input through Chrome's debugger, in CSS pixels of the tab's viewport (background/yolo/realInput.ts). */
  | { type: "REAL_INPUT"; op: RealOp }
  // B → C (a YOLO run in a tab), B → offscreen host
  | { type: "YOLO_ATTACH" }
  | { type: "YOLO_HOST_NAVIGATE"; url: string }
  /** YOLO is done with its frame while a compile keeps the document open. */
  | { type: "YOLO_HOST_CLEAR" }
  | { type: "LATEX_COMPILE"; tex: string; timeoutMs: number }
  // popup / O → B
  | { type: "YOLO_STATUS" }
  | { type: "YOLO_SET"; enabled: boolean }
  | { type: "YOLO_CHECK_NOW" }
  | { type: "YOLO_RESUME"; key: string }
  | { type: "YOLO_FORGET"; key: string }
  | { type: "YOLO_GMAIL_CONNECT" }
  | { type: "YOLO_GMAIL_CHECK" }
  | { type: "YOLO_ACCOUNTS" }
  | { type: "YOLO_REVEAL"; site: string }
  | { type: "YOLO_DELETE_ACCOUNT"; site: string }
  | { type: "CHOOSE_OPTIONS"; items: ChooseItem[]; groupId: string }
  | { type: "DRAFT_ESSAYS"; items: EssayItem[]; groupId: string }
  | { type: "EDIT_ANSWER"; edit: AnswerEdit; groupId: string }
  | { type: "SAVE_LEARNED_ANSWER"; answer: LearnedAnswerInput }
  | { type: "LEARNED_USED"; ids: string[] }
  | { type: "FRAME_STATUS"; status: FrameStatus }
  | { type: "ABORT"; groupId: string }
  | { type: "SLEEP"; ms: number }
  | { type: "BROADCAST_FILL"; rerun: boolean }
  | { type: "SET_OVERLAY_POS"; host: string; bottom: number }
  | { type: "OPEN_OPTIONS"; hash: string }
  // B/popup → C
  | { type: "TRIGGER_FILL"; force: boolean; rerun?: boolean }
  | { type: "FOCUS_FIELD"; frameId: number; fieldId: string }
  | { type: "TOGGLE_OVERLAY" }
  | { type: "READ_POSTING" }
  // popup → B
  | { type: "TAB_STATUS"; tabId: number }
  // O → B
  | { type: "ADD_KEY"; label: string; key: string }
  | { type: "TEST_KEY"; id: string }
  | { type: "REFRESH_MODELS"; force: boolean }
  | { type: "VALIDATE_MODEL"; model: string }
  | { type: "PARSE_RESUME"; text: string }
  | { type: "CLAUDE_TEST"; restarted?: boolean }
  | { type: "CLAUDE_MODELS"; force: boolean };

export type Ok = { ok: true };
export type Err = { error: ApiError };

export interface TabStatusResponse {
  status: TabStatus | null;
  provider: Settings["aiProvider"];
  /** The AI is set up: keys and a model, or Claude connected. */
  ready: boolean;
  model: string | null;
  keysTotal: number;
  keysHealthy: number;
}

export interface Responses {
  GET_RUNTIME_CONFIG: RuntimeConfig;
  GET_DOCUMENT: { meta: DocumentMeta; base64: string } | null;
  GET_DOC_JOB: JobBrief | null;
  SET_JOB_CONTEXT: Ok;
  BORROW_POSTING: Ok;
  READ_POSTING: JobContext | null;
  PICK_RESUME: { id: string | null };
  SET_JOB_PAY: Ok;
  MAP_FIELDS: { decisions: Decision[]; usedModel: string } | Err;
  CHOOSE_OPTIONS: { choices: Choice[] } | Err;
  DRAFT_ESSAYS: { essays: { fieldId: string; text: string | null; note?: string }[] } | Err;
  EDIT_ANSWER: { text: string } | Err;
  SAVE_LEARNED_ANSWER: Ok;
  LEARNED_USED: Ok;
  FRAME_STATUS: Ok;
  ABORT: Ok;
  SLEEP: Ok;
  BROADCAST_FILL: Ok;
  SET_OVERLAY_POS: Ok;
  OPEN_OPTIONS: Ok;
  TRIGGER_FILL: Ok;
  FOCUS_FIELD: Ok;
  TOGGLE_OVERLAY: Ok;
  TAB_STATUS: TabStatusResponse;
  ADD_KEY: Ok | Err;
  TEST_KEY: Ok | Err;
  REFRESH_MODELS: Ok | Err;
  VALIDATE_MODEL: Ok | Err;
  PARSE_RESUME: { proposed: Partial<Profile> } | Err;
  CLAUDE_TEST: { model: string; ms: number } | Err;
  CLAUDE_MODELS: Ok | Err;
  APPLY_ATTEMPT: Ok;
  YOLO_HELLO: {
    mode: "apply" | "scrape";
    company: string;
    title: string;
    visible: boolean;
    /** Real input for pages a bot check grades: "off" in the hidden frame, or without chrome.debugger. */
    realInput: (typeof REAL_INPUT)[number];
    /** The posting the run went past straight to its form (Lever's /apply): read for its description and pay. */
    posting?: string;
  } | null;
  /** `refused`: the site turned down our sign-in or sign-up (an account we hold no password for). */
  /** `needs`: a `stop` the user can finish (flagged as automated, or the application was already sent). */
  YOLO_STEP: { kind: StepKind; stop?: string; refused?: boolean; needs?: boolean };
  YOLO_RESULT: Ok;
  /** `ok` false: not done (no debugger, the user cancelled the debugging bar): the caller uses script input. */
  REAL_INPUT: { ok: boolean };
  YOLO_ANSWERS: Ok;
  YOLO_CREDENTIAL: { email: string; password: string; created: boolean } | null;
  YOLO_WAIT_EMAIL: { link?: string; code?: string } | Err;
  COVER_LETTER_PDF: { meta: DocumentMeta } | Err;
  /** `note`: why the untailored résumé was used (or a short summary of the tailoring). */
  TAILOR_RESUME: { meta: DocumentMeta; tailored: boolean; note: string } | Err;
  YOLO_HOST_CLEAR: Ok;
  LATEX_COMPILE: { pdf: string; log: string; pages: number };
  YOLO_ATTACH: Ok;
  YOLO_HOST_NAVIGATE: Ok;
  YOLO_STATUS: YoloStatus;
  YOLO_SET: Ok | Err;
  YOLO_CHECK_NOW: Ok;
  YOLO_RESUME: Ok | Err;
  YOLO_FORGET: Ok;
  YOLO_GMAIL_CONNECT: Ok | Err;
  YOLO_GMAIL_CHECK: Ok;
  YOLO_ACCOUNTS: { site: string; email: string; createdAt: number }[];
  YOLO_REVEAL: { password: string } | Err;
  YOLO_DELETE_ACCOUNT: Ok;
}

/**
 * Sends to the background and resolves with the typed response. Never throws synchronously: in a content script
 * orphaned by an extension reload, sendMessage throws "Extension context invalidated" before returning a promise,
 * which would skip every caller's .catch/rejection fallback and surface as an uncaught error.
 */
export function send<M extends Message>(msg: M): Promise<Responses[M["type"]]> {
  try {
    return chrome.runtime.sendMessage(msg) as Promise<Responses[M["type"]]>;
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Injects the content script into the tab's frames that have no live instance, so a fill reaches them: a tab open
 * since before an install, or an injection that raced an extension reload and bailed (content/index.ts main).
 * Frames that have one cost a tiny probe. Resolves false when a frame's world itself has no extension bindings:
 * a fresh copy would bail there too, and only reloading the page helps.
 */
export async function ensureContentScript(tabId: number): Promise<boolean> {
  const probes = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      injectImmediately: true,
      // Frames main() skips on purpose (not http) count as served.
      func: () =>
        (globalThis as { __autoapply?: boolean }).__autoapply || !/^https?:$/.test(location.protocol)
          ? "ok"
          : chrome.runtime?.id
            ? "missing"
            : "dead",
    })
    .catch(() => []); // a browser page: nothing of ours runs there
  const frameIds = probes.filter((p) => p.result === "missing").map((p) => p.frameId);
  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
  if (frameIds.length)
    await chrome.scripting.executeScript({ target: { tabId, frameIds }, files }).catch(() => undefined);
  return !probes.some((p) => p.result === "dead");
}

export function isErr(r: unknown): r is Err {
  return !!r && typeof r === "object" && "error" in r;
}
