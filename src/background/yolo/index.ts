// YOLO coordinator: the check timer, the queue, the application log, and every message of a run. With YOLO off no
// alarm exists, so none of this runs.
import type { Message, Responses, YoloResult } from "../../shared/messages";
import { RE_APPLIED, SLEPT_MS } from "../../shared/constants";
import { isTailoredDoc, resumeProblem } from "../../shared/resumeMode";
import { createStorage, session } from "../../shared/storage";
import type { AiTask } from "../../shared/settings";
import type { ApiError, DocumentMeta, Settings } from "../../shared/types";
import {
  defaultYolo,
  type Application,
  type Guess,
  type Listing,
  type QueueItem,
  type Yolo,
  type YoloState,
} from "../../shared/yolo";
import { RELEVANCE_PROMPT } from "../gemini/prompts";
import { RELEVANCE_SCHEMA, RelevanceZ } from "../gemini/schemas";
import { draftEssays } from "../services/draftEssays";
import { FALLBACK, tailoredDoc } from "../services/tailorResume";
import { jobBrief } from "../services/jobBrief";
import { compactProfile, type ServiceCtx } from "../services/mapFields";
import { getJobContext } from "../jobContext";
import { realInput, realInputReady } from "./realInput";
import { confirmation, confirmFirst, kindOf, refused, signature, verifyFailed } from "./classify";
import { applied, discover, inQueueOrder, RETRY } from "./discover";
import {
  checkGmail,
  connectGmail,
  GmailAuthError,
  gmailToken,
  siteOfUrl,
  waitForEmail,
  waitForFeedCode,
} from "./gmail";
import { closeFrame } from "./host";
import { altKey, applyUrl, jobKey } from "./jobKey";
import { textPdf } from "./pdf";
import {
  credit,
  end,
  fromRun,
  getRun,
  overdue,
  resolveScrape,
  saveRun,
  scrape,
  start,
  watchTab,
  WATCHDOG,
  woke,
  type Run,
} from "./runner";
import { createAccount, deleteAccount, getAccount } from "./vault";

const store = createStorage("background");
const CHECK = "yolo";
const RESUME = "yolo-resume";
/** `yolo-online|<what>|<tries>`: a batch step held until the network is back after the computer woke. */
const ONLINE = "yolo-online";
const WAKING = "Resuming after sleep";

type Handler<T extends Message["type"]> = (
  msg: Extract<Message, { type: T }>,
  sender: chrome.runtime.MessageSender,
) => Promise<Responses[T]>;

export interface YoloDeps {
  serviceCtx: (task?: AiTask) => Promise<ServiceCtx | { error: ApiError }>;
  /** How many applications' debug logs to keep: 0 with debug logging off. */
  logLimit: () => number;
}

let yolo: Yolo = defaultYolo();
let deps: YoloDeps;

const hostOf = (u: string) => new URL(u).hostname.replace(/^www\./, "");
const submittedSince = (apps: Application[], since: number) =>
  apps.filter((a) => a.mode === "yolo" && a.status === "submitted" && a.at >= since).length;

async function setState(patch: Partial<YoloState>) {
  await store.set({ yoloState: { ...(await store.get("yoloState")), ...patch } });
}

function notify(id: string, title: string, message: string) {
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/128.png"),
    title,
    message,
    priority: 1,
  });
}

/** Later answers to the same question replace earlier ones (a page re-filled after a validation error). */
const mergeGuesses = (a: Guess[], b: Guess[] = []) => [...a.filter((g) => !b.some((x) => x.q === g.q)), ...b];

/** One record per posting: a later outcome (the user resuming a "needs you") replaces the earlier one. */
async function record(a: Application) {
  const apps = (await store.get("applications")).filter((x) => x.key !== a.key);
  await store.set({ applications: [...apps, a] });
}

// ---------- timer ----------
/** Matches the alarm to the settings: one batch every interval while on and searching for something. */
async function schedule() {
  const on = yolo.enabled && yolo.queries.length > 0;
  const a = await chrome.alarms.get(CHECK);
  if (!on) {
    if (a) await chrome.alarms.clearAll();
    const run = await getRun();
    if (run) await end(run.id);
    await closeFrame().catch(() => undefined);
    return;
  }
  if (a?.periodInMinutes !== yolo.intervalMin)
    await chrome.alarms.create(CHECK, {
      periodInMinutes: yolo.intervalMin,
      delayInMinutes: a ? yolo.intervalMin : 0.5,
    });
}

let cycling: Promise<void> | null = null;
let toppingUp = false;
/** The batch (its `batchAt`) whose last discovery found nothing new: no top-up until the next batch. */
let dryBatch = 0;
/**
 * One batch: discovery, then applying to up to `batchSize` jobs. A run in the host keeps it busy, so rendered sources
 * wait for the next batch; a run still going from the last batch counts toward this one. `topUp`: more discovery for
 * the current batch, its queue having run dry.
 */
function cycle(topUp = false): Promise<void> {
  // A batch's own check waits out a top-up instead of being skipped for it, so its `batchAt` still starts a new batch.
  const again = () => cycle();
  if (cycling && toppingUp && !topUp) return cycling.then(again, again);
  return (cycling ??= (async () => {
    toppingUp = topUp;
    let batchAt = 0;
    let added = 0;
    try {
      if (!yolo.enabled || !yolo.queries.length) return;
      if (!topUp) await setState({ batchAt: Date.now(), pauseReason: "" });
      const [busy, state, queue, apps] = await Promise.all([
        getRun(),
        store.get("yoloState"),
        store.get("yoloQueue"),
        store.get("applications"),
      ]);
      batchAt = state.batchAt;
      added = await discover({
        yolo,
        fetch: (url, init) => fetch(url, init),
        scrape: busy ? undefined : scrape,
        relevance: yolo.aiRelevanceCheck ? relevance : undefined,
        want: yolo.batchSize - submittedSince(apps, state.batchAt) - queue.length,
      });
      await setState({ lastCheckAt: Date.now() });
    } catch (e) {
      console.warn("[AutoApply] YOLO check failed:", (e as Error)?.message);
    } finally {
      cycling = null;
    }
    // Failed or found nothing: topping up again would repeat it.
    if (batchAt && !added) dryBatch = batchAt;
    await pump();
  })());
}

/** The queue ran dry with the batch short of `batchSize`: finds more now rather than at the next batch. */
async function topUp(): Promise<boolean> {
  const [state, next] = await Promise.all([store.get("yoloState"), chrome.alarms.get(CHECK)]);
  // Not when the next batch, which discovers anyway, is due within minutes (or YOLO was just turned on).
  if (!next || next.scheduledTime - Date.now() < 5 * 60e3) return false;
  if (cycling || !yolo.queries.length || state.batchAt === dryBatch || state.pausedUntil > Date.now()) return false;
  if (submittedSince(await store.get("applications"), state.batchAt) >= yolo.batchSize) return false;
  void cycle(true);
  return true;
}

async function relevance(items: Listing[]): Promise<Set<number>> {
  const all = new Set(items.keys());
  const ctx = await deps.serviceCtx();
  if ("error" in ctx) return all;
  const p = await store.get("profile");
  const r = await ctx.ai
    .call(
      {
        system: RELEVANCE_PROMPT,
        payload: {
          queries: yolo.queries,
          candidate: compactProfile({
            education: p.education.map(({ degree, major, expectedGraduation, yearLevel }) => ({
              degree,
              major,
              expectedGraduation,
              yearLevel,
            })),
            workAuthorization: p.workAuthorization.entries,
            home: p.personal.address.country,
            willingToRelocate: p.preferences.willingToRelocate,
          }),
          jobs: items.map((l, i) => ({ i, title: l.title, company: l.company, location: l.location })),
        },
        schema: RELEVANCE_SCHEMA,
        validate: (d) => RelevanceZ.parse(d),
        timeoutMs: ctx.settings.requestTimeoutMs,
      },
      { model: ctx.model, fallback: ctx.fallback },
    )
    .catch(() => null);
  return r ? new Set(r.data.keep) : all;
}

/** Why YOLO can't upload résumés in its mode (Variant select with none, AI tailor without a .tex); "" when it can. */
async function resumeBlocker(): Promise<string> {
  const s = await store.getMany(["documentsIndex", "tailorResume"]);
  return resumeProblem(yolo.resumeUpload, s.documentsIndex, !!s.tailorResume, "YOLO");
}

// ---------- queue ----------
let pumping = false;
/** Starts the next queued job when nothing runs, the batch has room, and the AI is usable. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    if (!yolo.enabled || (await getRun())) return;
    const queue = await store.get("yoloQueue");
    if (!queue.length) return void ((await topUp()) || (await closeFrame().catch(() => undefined)));
    const state = await store.get("yoloState");
    if (state.pausedUntil > Date.now()) return;
    if (submittedSince(await store.get("applications"), state.batchAt) >= yolo.batchSize) {
      await setState({ pauseReason: "Batch done" });
      return void (await closeFrame().catch(() => undefined));
    }
    const ctx = await deps.serviceCtx();
    if ("error" in ctx) return void (await setState({ pauseReason: ctx.error.message }));
    const blocked = await resumeBlocker();
    if (blocked) return void (await setState({ pauseReason: blocked }));
    const [item, ...rest] = inQueueOrder(queue, yolo);
    await store.set({ yoloQueue: rest });
    await setState({ pauseReason: "" });
    const tab = yolo.tabFallback && (await store.get("yoloTabHosts")).includes(hostOf(applyUrl(item.url)));
    await start(item, "apply", tab ? "tab" : "frame");
  } finally {
    pumping = false;
  }
}

async function pause(until: number, reason: string) {
  await setState({ pausedUntil: until, pauseReason: reason });
  await chrome.alarms.create(RESUME, { when: until });
}

async function requeue(item: QueueItem) {
  await store.set({ yoloQueue: [{ ...item, postedAt: RETRY }, ...(await store.get("yoloQueue"))] });
}

/**
 * After the computer wakes (or the browser starts): the next pump or check 30 s on, once the network is back (Wi-Fi
 * reconnects after the computer does). Still offline after 5 minutes, it goes ahead anyway.
 */
async function whenOnline(what: "pump" | "check", tries = 0) {
  const until = Date.now() + 30_000;
  // Holds other pumps off meanwhile, short of a longer pause (an AI usage limit's).
  if (what === "pump" && (await store.get("yoloState")).pausedUntil < until)
    await setState({ pausedUntil: until, pauseReason: WAKING });
  await chrome.alarms.create(`${ONLINE}|${what}|${tries}`, { delayInMinutes: 0.5 });
}

async function online(alarm: string) {
  const [, what, tries] = alarm.split("|") as [string, "pump" | "check", string];
  if (!navigator.onLine && +tries < 10) return whenOnline(what, +tries + 1);
  if (what === "check") return cycle();
  if ((await store.get("yoloState")).pauseReason === WAKING) await setState({ pauseReason: "" });
  await pump();
}

/** A hidden application the computer's sleep likely broke: it failed moments after waking, before submitting. */
async function sleptThrough(run: Run, r: YoloResult): Promise<boolean> {
  if (run.mode !== "apply" || run.host === "visible" || run.confirming || (run.item.retries ?? 0) >= 2) return false;
  if (r.status === "submitted" || r.status === "skipped" || ("retryAt" in r && r.retryAt)) return false;
  const now = Date.now();
  if (woke(run, now)) return true;
  // Woken just now, before the watchdog's late tick.
  const due = (await chrome.alarms.get(WATCHDOG))?.scheduledTime;
  return !!due && now - due > SLEPT_MS;
}

/** A browser restart lost the run (session storage) mid-application: its job goes back to the front of the queue. */
async function recoverLost() {
  const item = await store.get("yoloInFlight");
  if (!item || (await getRun())) return;
  await store.set({ yoloInFlight: null });
  if ((item.retries ?? 0) >= 2) return;
  await requeue({ ...item, retries: (item.retries ?? 0) + 1 });
  if (yolo.enabled) await whenOnline("pump");
}

/**
 * A run's outcome: started again when the computer's sleep broke it, retried in a tab when the hidden frame was
 * refused, re-queued on a quota stop, else logged.
 */
async function finish(run: Run, r: YoloResult) {
  if (await sleptThrough(run, r)) {
    if (!(await end(run.id))) return;
    const limit = deps.logLimit();
    if (limit) await logRun(run, r, limit);
    await requeue({ ...run.item, retries: (run.item.retries ?? 0) + 1 });
    return whenOnline("pump");
  }
  if (!(await end(run.id))) return;
  if (run.mode === "scrape") return resolveScrape(run, r);
  const limit = deps.logLimit();
  if (limit) await logRun(run, r, limit);
  if (r.status === "blocked" && run.host === "frame" && yolo.tabFallback) {
    await start(run.item, "apply", "tab");
    return;
  }
  if (r.status !== "submitted" && r.status !== "scraped" && r.retryAt) {
    await requeue(run.item);
    await pause(r.retryAt, "AI usage limit reached");
    return;
  }
  const { item } = run;
  const a: Application = {
    key: run.atsUrl ? jobKey(run.atsUrl) : item.key,
    alt: item.alt,
    url: run.atsUrl ?? applyUrl(item.url),
    company: item.company,
    title: item.title,
    location: item.location,
    source: item.source,
    doneUrl: r.status === "submitted" ? r.doneUrl : "",
    mode: "yolo",
    status: r.status === "blocked" || r.status === "scraped" ? "failed" : r.status,
    reason: "reason" in r ? r.reason : "",
    guesses: mergeGuesses(run.guesses, "guesses" in r ? r.guesses : []),
    notes: run.notes ?? [],
    at: Date.now(),
  };
  await record(a);
  if (a.status === "needs" && run.host !== "visible")
    notify(`yolo:${a.key}`, "AutoApply needs you", `${a.company} – ${a.title}: ${a.reason}`);
  void pump();
}

/** Debug logging: one entry per application with its steps, every field's answer, and what the page said at the end. */
async function logRun(run: Run, r: YoloResult, limit: number) {
  const answers = Object.values(run.answers ?? {});
  const up = await uploaded(run);
  const text = [
    `${r.status}: ${run.item.company} – ${run.item.title} (${run.host})`,
    run.atsUrl ?? run.item.url,
    `Steps: ${run.steps.map((s) => s.split("|")[0]).join(" → ") || "none"}`,
    "reason" in r && r.reason && `Reason: ${r.reason}`,
    run.confirmation && `Confirmation: ${run.confirmation}`,
    `Résumé: ${up.resume.join(", ") || "None"}`,
    `Cover letter: ${up.letter.join(", ") || "None"}`,
    `Answers (${answers.length}):`,
    ...answers.map((g) => `  ${g.q} = ${g.a}`),
  ]
    .filter(Boolean)
    .join("\n");
  const entry = { at: Date.now(), text, ...(up.files.length ? { files: up.files } : {}) };
  await store.set({ yoloLogs: [...(await store.get("yoloLogs")), entry].slice(-limit) });
}

type LogFile = { name: string; base64: string };

/** The résumés and cover letters the run uploaded, by name, and the files YOLO made for the job as uploaded. */
async function uploaded(run: Run) {
  const docs = await store.get("documentsIndex");
  const up = { resume: [] as string[], letter: [] as string[], files: [] as LogFile[] };
  for (const id of run.uploads ?? []) {
    if (isTailoredDoc(id) || isYoloDoc(id)) {
      const d = await (isYoloDoc(id) ? yoloDoc(id) : tailoredDoc(store, id));
      if (d) up.files.push({ name: d.meta.fileName, base64: d.base64 });
      if (isYoloDoc(id)) up.letter.push(`Generated (${d?.meta.fileName ?? "file no longer kept"})`);
      // The untailored PDF made when the .tex was uploaded, or a tailoring a browser restart lost.
      else up.resume.push(d && id !== FALLBACK ? `Tailored (${d.meta.fileName})` : "Untailored LaTeX résumé");
      continue;
    }
    const d = docs.find((x) => x.id === id);
    if (d?.kind === "resume") up.resume.push(d.label);
    else if (d?.kind === "cover_letter") up.letter.push(d.label);
  }
  return up;
}

async function watchdog(due: number) {
  const run = await getRun();
  if (!run) return void (await chrome.alarms.clear(WATCHDOG));
  const now = Date.now();
  // Fired late: the computer slept since `due`, which the run's time limits don't count.
  if (now - due > SLEPT_MS) {
    credit(run, due, now);
    await saveRun(run);
  }
  const late = overdue(run, now);
  if (late) await finish(run, late);
  // After a worker restart the tab listener is gone: listen again.
  else if (run.host !== "frame") watchTab(run);
}

/** Opens an application that needs the user in a visible tab, where the run continues once they're done. */
async function resume(key: string): Promise<Responses["YOLO_RESUME"]> {
  const a = (await store.get("applications")).find((x) => x.key === key);
  if (!a) return { error: { kind: "other", message: "Unknown application" } };
  const run = await getRun();
  if (run && (await end(run.id)) && run.mode === "apply") await requeue(run.item);
  await start({ ...a, listing: "", postedAt: 0, addedAt: Date.now() }, "apply", "visible");
  return { ok: true };
}

// ---------- page probes ----------
/** Self-contained (runs in the page): whether it confirms an application, by RE_APPLIED's source. */
const confirmed = (src: string) => (new RegExp(src, "i").test(document.body?.innerText ?? "") ? location.href : null);

const accountEmail = async () => yolo.email || (await store.get("profile")).personal.email;

/**
 * A YOLO run's job as its source listed it: a proper company name and title where the page offers only a slug
 * ("nuovophotography" on Workable), for essays and cover letters. Career sites' listings know no better than the page.
 */
export async function yoloJob(
  sender: chrome.runtime.MessageSender,
): Promise<{ company: string; title: string } | null> {
  const run = await getRun();
  if (!fromRun(run, sender) || run.mode !== "apply" || run.item.source === "careers") return null;
  return { company: run.item.company, title: run.item.title };
}

/** The run's tab as the rest of the background sees it; the hidden frame has none, so it stands in as tab -1. */
export async function runTab(sender: chrome.runtime.MessageSender): Promise<chrome.tabs.Tab | undefined> {
  if (sender.tab) return sender.tab;
  const run = await getRun();
  return fromRun(run, sender)
    ? ({ id: chrome.tabs.TAB_ID_NONE, url: run.atsUrl ?? run.item.url } as chrome.tabs.Tab)
    : undefined;
}

/** What a YOLO run's page fills with: nothing left for the user, the YOLO email, essays always drafted. */
export async function yoloOverrides(sender: chrome.runtime.MessageSender): Promise<{
  settings: Partial<Settings>;
  email: string;
  visible: boolean;
} | null> {
  const run = await getRun();
  if (!fromRun(run, sender)) return null;
  return {
    settings: {
      draftEssays: true,
      autoAcceptAcknowledgements: true,
      coverLetterPdfs: yolo.optionalCoverLetters,
      resumeUpload: yolo.resumeUpload,
      ...(run.host === "visible" ? {} : { showBadges: false }),
    },
    email: await accountEmail(),
    visible: run.host === "visible",
  };
}

/** For the warning on a manual fill: YOLO's submission for this posting, if any. */
export async function yoloApplied(url: string): Promise<{ at: number; url: string } | undefined> {
  if (!yolo.warnOnYoloApplied || !url) return;
  const key = jobKey(url);
  const a = (await store.get("applications")).find(
    (x) => x.mode === "yolo" && x.status === "submitted" && x.key === key,
  );
  return a && { at: a.at, url: a.doneUrl || a.url };
}

/** Adds a note to the run's application record, when `sender` is a YOLO run's page. */
export async function yoloNote(sender: chrome.runtime.MessageSender, note: string) {
  const run = await getRun();
  if (!fromRun(run, sender) || run.mode !== "apply" || run.notes?.includes(note)) return;
  await saveRun({ ...run, notes: [...(run.notes ?? []), note] });
}

/** Debug logging: a document the run's page fetched to upload, for the run's log. */
export async function yoloUpload(sender: chrome.runtime.MessageSender, id: string) {
  if (!deps.logLimit()) return;
  const run = await getRun();
  if (!fromRun(run, sender) || run.mode !== "apply" || run.uploads?.includes(id)) return;
  await saveRun({ ...run, uploads: [...(run.uploads ?? []), id] });
}

export const isYoloDoc = (id: string) => id.startsWith("yolo-");
export const yoloDoc = (id: string) => session.get<{ meta: DocumentMeta; base64: string }>(`yolodoc:${id}`);

// ---------- messages ----------
export const yoloHandlers: { [T in Message["type"]]?: Handler<T> } = {
  async YOLO_STATUS() {
    const [apps, queue, state, run, alarm] = await Promise.all([
      store.get("applications"),
      store.get("yoloQueue"),
      store.get("yoloState"),
      getRun(),
      chrome.alarms.get(CHECK),
    ]);
    return {
      enabled: yolo.enabled,
      searches: yolo.queries.length,
      appliedBatch: submittedSince(apps, state.batchAt),
      batchSize: yolo.batchSize,
      queued: queue.length,
      needsYou: apps.filter((a) => a.status === "needs").length,
      nextCheckAt: alarm?.scheduledTime ?? null,
      running: run?.mode === "apply" ? `${run.item.company} – ${run.item.title}` : null,
      paused: state.gmailNeedsAuth ? "Reconnect Gmail in Settings" : state.pauseReason,
    };
  },

  async YOLO_SET({ enabled }) {
    const blocked = enabled ? await resumeBlocker() : "";
    if (blocked) return { error: { kind: "other", message: blocked } };
    yolo = { ...yolo, enabled };
    await store.set({ yolo });
    // The new alarm's first firing, 30 s on, starts the first batch.
    await schedule();
    return { ok: true };
  },

  async YOLO_CHECK_NOW() {
    void cycle();
    return { ok: true };
  },

  YOLO_RESUME: ({ key }) => resume(key),

  async YOLO_FORGET({ key }) {
    const [apps, seen] = await Promise.all([store.get("applications"), store.get("yoloSeen")]);
    delete seen[key];
    await store.set({ applications: apps.filter((a) => a.key !== key), yoloSeen: seen });
    return { ok: true };
  },

  async YOLO_GMAIL_CONNECT() {
    try {
      await connectGmail(yolo, await accountEmail());
      await setState({ gmailNeedsAuth: false, gmailConnected: true });
      return { ok: true };
    } catch (e) {
      return { error: { kind: "other", message: (e as Error).message } };
    }
  },

  async YOLO_GMAIL_CHECK() {
    try {
      await checkGmail(yolo);
      await setState({ gmailNeedsAuth: false, gmailConnected: true });
    } catch (e) {
      // A network error says nothing about the sign-in: keep the last known state.
      if (!(e instanceof GmailAuthError)) return { ok: true };
      const { gmailConnected, gmailNeedsAuth } = await store.get("yoloState");
      await setState({ gmailConnected: false, gmailNeedsAuth: gmailNeedsAuth || gmailConnected });
    }
    return { ok: true };
  },

  async YOLO_ACCOUNTS() {
    return Object.entries(await store.get("vault")).map(([site, e]) => ({
      site,
      email: e.email,
      createdAt: e.createdAt,
    }));
  },

  async YOLO_REVEAL({ site }) {
    const a = await getAccount(site).catch(() => null);
    return a ? { password: a.password } : { error: { kind: "other", message: "Can't decrypt this password" } };
  },

  async YOLO_DELETE_ACCOUNT({ site }) {
    await deleteAccount(site);
    return { ok: true };
  },

  async YOLO_HELLO(_m, sender) {
    const run = await getRun();
    if (!fromRun(run, sender)) return null;
    const skipped = run.mode === "apply" && !run.helloAt && applyUrl(run.item.url) !== run.item.url;
    run.helloAt = run.stepAt = Date.now();
    await saveRun(run);
    return {
      mode: run.mode,
      company: run.item.company,
      title: run.item.title,
      visible: run.host === "visible",
      realInput: run.host !== "frame" && realInputReady() ? yolo.realInput : "off",
      ...(skipped ? { posting: run.item.url } : {}),
    };
  },

  async YOLO_STEP({ facts, url, guesses }, sender) {
    const run = await getRun();
    if (!fromRun(run, sender)) return { kind: "unknown", stop: "Not running" };
    // Without the tab retry, a bot check in the frame is the user's, like anywhere else.
    let kind = kindOf(facts, run.host === "frame" && yolo.tabFallback);
    let stop: string | undefined;
    // An emailed link must land back on the run's sites (a click tracker's destination is only known now). The browser
    // says where the page is, not the page.
    const landed = siteOfUrl(sender.url ?? url);
    if (run.linkSites && !run.linkSites.includes(landed)) stop = `The emailed link led to another site (${landed})`;
    run.linkSites = undefined;
    // Held after submitting (past a form step, not an account's verification): the page after the emailed link or
    // code confirms it, unless it says that failed.
    const held = run.confirming;
    if (kind === "verify" && confirmFirst(facts)) run.confirming ||= run.steps.some((s) => s.startsWith("form|"));
    else if (run.confirming && kind !== "verify" && kind !== "success") {
      if (verifyFailed(facts)) stop ??= "The emailed confirmation didn't go through";
      else kind = "success";
    }
    // Submitted: never applied to again after a browser restart.
    if (run.confirming && !held) await store.set({ yoloInFlight: null });
    const sig = signature(kind, facts);
    run.guesses = mergeGuesses(run.guesses, guesses);
    // The page reloads to retry a submission flagged as spam: its steps repeat from the start, only the flags count.
    if (kind === "flagged") run.steps = run.steps.filter((s) => s.startsWith("flagged|"));
    run.steps.push(sig);
    run.stepAt = Date.now();
    if (kind === "success") run.confirmation = confirmation(facts);
    if (kind === "blocked" && run.host === "frame") {
      const hosts = (await store.get("yoloTabHosts")).filter((h) => h !== hostOf(url));
      await store.set({ yoloTabHosts: [...hosts, hostOf(url)].slice(-200) });
    }
    // Reached the employer's own posting from a board link: it may be one applied to through another source.
    if (!run.atsUrl && /^(form|signin|signup)$/.test(kind) && hostOf(url) !== hostOf(run.item.url)) {
      run.atsUrl = url;
      if (applied(await store.get("applications"), jobKey(url), run.item.alt, yolo.reapplyManual))
        stop = "Already applied through another link";
    }
    if (run.steps.filter((s) => s === sig).length >= 3)
      stop = kind === "flagged" ? "The site kept flagging it as automated" : `Stuck at the same ${kind} step`;
    if (run.steps.length > 40) stop = "Too many steps";
    await saveRun(run);
    return {
      kind,
      refused: /^(signin|signup|reset)$/.test(kind) && refused(facts),
      // Turned down as a bot each time (a visible tab, the user's browser, usually passes), or already sent: the
      // user's to finish, never a failure.
      ...(stop ? { stop, needs: kind === "flagged" || !!run.confirming } : {}),
    };
  },

  async REAL_INPUT({ op }, sender) {
    const run = await getRun();
    const tabId = sender.tab?.id;
    const want = op.kind === "type" ? "typing" : "clicks";
    // Only the run's own tab, its top frame (whose viewport the points are in), and only what the setting allows.
    if (!fromRun(run, sender) || run.host === "frame" || tabId === undefined || sender.frameId !== 0)
      return { ok: false };
    if (yolo.realInput !== want && yolo.realInput !== "both") return { ok: false };
    return { ok: await realInput(tabId, op) };
  },

  async YOLO_RESULT({ result }, sender) {
    const run = await getRun();
    if (fromRun(run, sender)) await finish(run, result);
    return { ok: true };
  },

  async YOLO_ANSWERS({ answers, guesses }, sender) {
    const run = await getRun();
    // A later pass over the same field (a refill) replaces its answer.
    if (fromRun(run, sender))
      await saveRun({ ...run, answers: { ...run.answers, ...answers }, guesses: mergeGuesses(run.guesses, guesses) });
    return { ok: true };
  },

  async YOLO_CREDENTIAL({ site, create }, sender) {
    if (!fromRun(await getRun(), sender)) return null;
    if (!create) {
      const a = await getAccount(site).catch(() => null);
      return a && { ...a, created: false };
    }
    return { ...(await createAccount(site, await accountEmail())), created: true };
  },

  async YOLO_WAIT_EMAIL({ since, want }, sender) {
    const run = await getRun();
    if (!fromRun(run, sender)) return { error: { kind: "other", message: "Not running" } };
    const off = (message: string) => ({ error: { kind: "other" as const, message } });
    if (want === "code" && !yolo.emailCodes) return off("Emailed codes are off in YOLO settings");
    if (want === "link" && !yolo.verifyLinks) return off("Verification links are off in YOLO settings");
    // Only a link back to the run's sites: the page asking (the browser's record of it, not the page's word), the
    // employer's application site and the posting's.
    const asking = siteOfUrl(sender.url ?? "");
    if (want === "link" && !asking) return off("Unknown site");
    const sites = [asking, siteOfUrl(run.atsUrl ?? ""), siteOfUrl(run.item.url)].filter(Boolean);
    const email = await accountEmail();
    try {
      // No API client: codes can still come from the Gmail inbox signed in to this browser, links can't.
      if (!yolo.gmailClientId && want === "link") return off("Gmail isn't connected");
      const found = yolo.gmailClientId
        ? await waitForEmail(() => gmailToken(yolo), email, since, want, sites)
        : await waitForFeedCode(email, since);
      if (!found) return { error: { kind: "other", message: "No verification email arrived" } };
      if (want === "code") return { code: found };
      // Read minutes later: the run as it is now.
      const now = await getRun();
      if (now?.id !== run.id) return off("Not running");
      await saveRun({ ...now, linkSites: sites });
      return { link: found };
    } catch (e) {
      if (e instanceof GmailAuthError) {
        await setState({ gmailNeedsAuth: true, gmailConnected: false });
        notify(
          "yolo-gmail",
          "AutoApply: reconnect Gmail",
          "YOLO needs Gmail to verify new accounts. Open Settings → YOLO.",
        );
      }
      return { error: { kind: "other", message: (e as Error).message } };
    }
  },

  async COVER_LETTER_PDF({ question }, sender) {
    const tab = await runTab(sender);
    const ctx = await deps.serviceCtx("write");
    if ("error" in ctx) return ctx;
    const profile = await store.get("profile");
    const job = tab?.id !== undefined ? await getJobContext(tab.id) : null;
    const [e] = await draftEssays(ctx, [{ fieldId: "cl", question, kind: "cover_letter" }], profile, job);
    if (!e?.text) return { error: { kind: "other", message: e?.note ?? "No cover letter drafted" } };
    const id = `yolo-${crypto.randomUUID()}`;
    const base64 = textPdf(e.text);
    const name = `${profile.personal.firstName} ${profile.personal.lastName}`.trim().replace(/\s+/g, "_") || "Cover";
    const meta: DocumentMeta = {
      id,
      label: "Cover letter (generated)",
      kind: "cover_letter",
      fileName: `${name}_Cover_Letter.pdf`,
      mimeType: "application/pdf",
      size: Math.floor((base64.length * 3) / 4),
      isPrimaryResume: false,
      uploadedAt: Date.now(),
    };
    await Promise.all([
      session.set(`yolodoc:${id}`, { meta, base64 }),
      // For the overlay: the job as draftEssays gave it to the AI.
      session.set(`docjob:${id}`, jobBrief(job) ?? {}),
    ]);
    return { meta };
  },

  async APPLY_ATTEMPT({ job, doneUrl }, sender) {
    const save = (done: string) =>
      record({
        key: jobKey(job.url),
        alt: altKey(job.company, job.title),
        url: job.url,
        company: job.company,
        title: job.title,
        location: "",
        source: "manual",
        doneUrl: done,
        mode: "manual",
        status: "submitted",
        reason: "",
        guesses: [],
        notes: [],
        at: Date.now(),
      });
    if (doneUrl) {
      await save(doneUrl);
      return { ok: true };
    }
    // The form navigated away before its page could confirm: look at the tab's next page once it has loaded.
    const tabId = sender.tab?.id;
    if (tabId !== undefined)
      setTimeout(async () => {
        const res = await chrome.scripting
          .executeScript({ target: { tabId, allFrames: true }, func: confirmed, args: [RE_APPLIED.source] })
          .catch(() => []);
        const done = res.map((x) => x.result).find(Boolean);
        if (done) await save(String(done));
      }, 6000);
    return { ok: true };
  },
};

export function initYolo(d: YoloDeps) {
  deps = d;
  const ready = store.get("yolo").then(async (y) => {
    yolo = y;
    await recoverLost();
  });
  store.onChange(["yolo"], (c) => {
    const prev = yolo;
    yolo = c.yolo ?? yolo;
    // New searches: re-read the feeds in full at the next check, not only what changed since the last one.
    const search = (y: Yolo) => JSON.stringify([y.queries, y.locations, y.remoteOk, y.excludeTitleWords, y.feeds]);
    if (search(prev) !== search(yolo)) void store.set({ feedCache: {} });
    void schedule().then(() => pump());
  });
  chrome.alarms.onAlarm.addListener(
    (a) =>
      void ready.then(async () => {
        // Fired late, the computer just woke: the network may not be back yet.
        if (a.name === CHECK)
          await (Date.now() - a.scheduledTime > SLEPT_MS || !navigator.onLine ? whenOnline("check") : cycle());
        else if (a.name === WATCHDOG) await watchdog(a.scheduledTime);
        else if (a.name.startsWith(`${ONLINE}|`)) await online(a.name);
        else if (a.name === RESUME) {
          await setState({ pausedUntil: 0, pauseReason: "" });
          await pump();
        }
      }),
  );
  chrome.notifications.onClicked.addListener((id) => {
    chrome.notifications.clear(id);
    if (id.startsWith("yolo:")) void ready.then(() => resume(id.slice(5)));
    else if (id === "yolo-gmail")
      void chrome.tabs.create({ url: chrome.runtime.getURL("src/options/index.html#/yolo") });
  });
  return ready;
}
