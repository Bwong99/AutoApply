// One YOLO run at a time: a queued job (or a page read for discovery) loaded in a host and driven by the content
// script inside it (src/content/yolo), which reports each step and the outcome. The run lives in session storage, so
// a service-worker restart mid-application loses nothing but in-memory waiters.
import { CAPTCHA_WAIT_MS, EMAIL_WAIT_MS } from "../../shared/constants";
import type { YoloResult } from "../../shared/messages";
import { createStorage, session } from "../../shared/storage";
import type { Guess, QueueItem, SubmissionReview } from "../../shared/yolo";
import { closeTab, openFrame, openTab } from "./host";
import { applyUrl } from "./jobKey";
import type { Link } from "./sources";

export interface Run {
  id: string;
  item: QueueItem;
  mode: "apply" | "scrape";
  host: "frame" | "tab" | "visible";
  tabId?: number;
  startedAt: number;
  /** Last sign of progress: the driver's hello or a step. */
  stepAt: number;
  helloAt: number;
  steps: string[];
  guesses: Guess[];
  /** The employer's posting the run reached, when the queued link was a job board's. */
  atsUrl?: string;
  /** Debug logging: every field the run filled and its answer, by document and field. */
  answers?: Record<string, Guess>;
  /** Debug logging: the documents fetched for upload, in order. */
  uploads?: string[];
  /** What the confirmation page said. */
  confirmation?: string;
  /** For the application's record (Application.notes). */
  notes?: string[];
  /** Submitted, but held until the emailed link or code: the page after it confirms it, unless it says it failed. */
  confirming?: boolean;
  /** An emailed link was just handed out: the sites its page must land on. */
  linkSites?: string[];
  /** When the computer last woke from sleeping during the run. */
  wokeAt?: number;
  reviewPolicy?: SubmissionReview;
  reviewKey?: string;
  hasGuessedAnswers?: boolean;
  reviewTab?: boolean;
  documentId?: string;
}

const KEY = "yoloRun";
const store = createStorage("background");
export const WATCHDOG = "yolo-watchdog";
/** No driver within this long: the page didn't load, or refused to run hidden. */
const HELLO_MS = 45_000;
const STEP_MS = 180_000;
const RUN_MS = 12 * 60_000;
/** With AI review or navigation, an application can take several times as long. */
export const REVIEW_RUN_MS = 45 * 60_000;

export const getRun = () => session.get<Run>(KEY);
export const saveRun = (r: Run) => session.set(KEY, r);

/** Messages from the run's page: any frame of the hidden host (no tab), or of the run's tab. */
export function fromRun(run: Run | null, s: chrome.runtime.MessageSender): run is Run {
  if (!run) return false;
  return run.host === "frame" ? !s.tab && /^https?:/.test(s.url ?? "") : s.tab?.id === run.tabId;
}

const scrapes = new Map<string, (links: Link[] | null) => void>();

export async function start(
  item: QueueItem,
  mode: Run["mode"],
  host: Run["host"],
  review?: {
    policy: SubmissionReview;
    key?: string;
    tab: boolean;
  },
): Promise<Run> {
  const now = Date.now();
  const run: Run = {
    id: crypto.randomUUID(),
    item,
    mode,
    host,
    startedAt: now,
    stepAt: now,
    helloAt: 0,
    steps: [],
    guesses: [],
    ...(review ? { reviewPolicy: review.policy, reviewKey: review.key, reviewTab: review.tab } : {}),
  };
  const url = mode === "apply" ? applyUrl(item.url) : item.url;
  // Saved before the page loads: its driver says hello as soon as it starts.
  await saveRun(run);
  // Survives a browser restart, which loses the run: the job goes back in the queue (index.ts initYolo).
  if (mode === "apply" && host !== "visible") await store.set({ yoloInFlight: item });
  if (host === "frame") await openFrame(url);
  else {
    run.tabId = await openTab(url, host === "visible");
    if (review?.tab) await chrome.tabs.update(run.tabId, { autoDiscardable: false });
    await saveRun(run);
    watchTab(run);
  }
  await chrome.alarms.create(WATCHDOG, { periodInMinutes: 0.5 });
  return run;
}

/** Reads a page's links in the hidden host (Indeed results, career sites without an API); null = a bot check stood in. */
export async function scrape(url: string, timeoutMs = 40_000): Promise<Link[] | null> {
  const run = await start(
    { key: url, alt: "", listing: "", url, company: "", title: "", location: "", source: "", postedAt: 0, addedAt: 0 },
    "scrape",
    "frame",
  );
  return new Promise((resolve) => {
    const t = setTimeout(() => void end(run.id).then(() => resolve([])), timeoutMs);
    scrapes.set(run.id, (links) => (clearTimeout(t), resolve(links)));
  });
}

/** Clears the run if it is still `id`; returns it, so its result is handled once. */
export async function end(id: string, keepTab = false): Promise<Run | null> {
  const run = await getRun();
  if (run?.id !== id) return null;
  // Before the run: a worker dying in between leaves no marker to requeue a finished job by.
  await store.set({ yoloInFlight: null });
  await session.remove(KEY);
  unwatchTab();
  await chrome.alarms.clear(WATCHDOG);
  if (!keepTab && (run.host === "tab" || (run.reviewKey && run.reviewTab)) && run.tabId !== undefined)
    await closeTab(run.tabId);
  return run;
}

/** A scrape's links reach the discovery that waits for them; an application's result is the caller's to record. */
export function resolveScrape(run: Run, r: YoloResult) {
  scrapes.get(run.id)?.(r.status !== "scraped" ? [] : r.walled ? null : r.links);
  scrapes.delete(run.id);
}

/** The run's failure when it is overdue; null while it is on time. */
export function overdue(run: Run, now = Date.now(), limitMs = RUN_MS): YoloResult | null {
  const blocked = run.host === "frame" ? "blocked" : "failed";
  if (!run.helloAt && now - run.startedAt > HELLO_MS) return { status: blocked, reason: "The page didn't load" };
  // A visible tab waits on the user: a CAPTCHA step gets the driver's whole wait, and the run no time limit.
  const visible = run.host === "visible";
  const captcha = visible && run.steps.at(-1)?.startsWith("captcha|");
  // A verification step waits on the inbox without stepping.
  const wait = captcha ? CAPTCHA_WAIT_MS : run.steps.at(-1)?.startsWith("verify|") ? EMAIL_WAIT_MS : 0;
  if (now - run.stepAt > wait + STEP_MS)
    return { status: "failed", reason: captcha ? "The CAPTCHA wasn't solved" : "No progress for 3 minutes" };
  if (!visible && now - run.startedAt > limitMs)
    return { status: "failed", reason: `Took over ${Math.round(limitMs / 60_000)} minutes` };
  return null;
}

/**
 * Counts the time the computer slept (from `asleepSince` until `now`) as paused: the run's clocks that started before
 * it move on by as much, so the limits above count awake time only. Progress made since waking stays as it is.
 */
export function credit(run: Run, asleepSince: number, now = Date.now()) {
  const shift = (t: number) => (t <= asleepSince ? t + now - asleepSince : t);
  run.startedAt = shift(run.startedAt);
  run.stepAt = shift(run.stepAt);
  run.wokeAt = now;
}

/** The computer woke during the run moments ago: a failure now is likely the sleep's (an expired session, no network). */
export const woke = (run: Run, now = Date.now()) => !!run.wokeAt && now - run.wokeAt < STEP_MS;

// ---------- tab hosts ----------
// A tab's content script waits to be told it runs YOLO (a hidden frame knows from its ancestors). Listening only
// while a tab run exists keeps tab events from waking the worker otherwise.
let tabListener: ((id: number, info: chrome.tabs.OnUpdatedInfo) => void) | null = null;
let openedListener: ((tab: chrome.tabs.Tab) => void) | null = null;

export function watchTab(run: Run) {
  unwatchTab();
  tabListener = (id, info) => {
    if (id === run.tabId && info.status === "complete") void attach(id);
  };
  // A page opening its next step in a new tab: carry on in the run's tab instead.
  openedListener = (tab) => {
    if (tab.openerTabId !== run.tabId || tab.id === undefined) return;
    const url = tab.pendingUrl ?? tab.url;
    void closeTab(tab.id);
    if (url && run.tabId !== undefined) void chrome.tabs.update(run.tabId, { url });
  };
  chrome.tabs.onUpdated.addListener(tabListener);
  chrome.tabs.onCreated.addListener(openedListener);
  if (run.tabId !== undefined) void attach(run.tabId);
}

function unwatchTab() {
  if (tabListener) chrome.tabs.onUpdated.removeListener(tabListener);
  if (openedListener) chrome.tabs.onCreated.removeListener(openedListener);
  tabListener = openedListener = null;
}

/** Retries until the page's content script listens (it loads at document_idle, after "complete" at times). */
async function attach(tabId: number) {
  for (let i = 0; i < 40; i++) {
    if (await chrome.tabs.sendMessage(tabId, { type: "YOLO_ATTACH" }, { frameId: 0 }).catch(() => null)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}
