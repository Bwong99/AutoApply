// YOLO coordinator: the check timer, the queue, the application log, and every message of a run. With YOLO off no
// alarm exists, so none of this runs.
import type { Message, Responses, YoloResult } from "../../shared/messages";
import { RE_APPLIED } from "../../shared/constants";
import { resumeProblem } from "../../shared/resumeMode";
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
import { compactProfile, type ServiceCtx } from "../services/mapFields";
import { getJobContext } from "../jobContext";
import { confirmation, kindOf, refused, signature } from "./classify";
import { applied, discover, inQueueOrder, RETRY } from "./discover";
import { checkGmail, GmailAuthError, gmailToken, waitForEmail, waitForFeedCode } from "./gmail";
import { closeFrame } from "./host";
import { altKey, applyUrl, jobKey } from "./jobKey";
import { textPdf } from "./pdf";
import {
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
  type Run,
} from "./runner";
import { createAccount, deleteAccount, getAccount } from "./vault";

const store = createStorage("background");
const CHECK = "yolo";
const RESUME = "yolo-resume";

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
/**
 * One batch: discovery, then applying to up to `batchSize` jobs. A run in the host keeps it busy, so rendered sources
 * wait for the next batch; a run still going from the last batch counts toward this one.
 */
function cycle(): Promise<void> {
  return (cycling ??= (async () => {
    try {
      if (!yolo.enabled || !yolo.queries.length) return;
      await setState({ batchAt: Date.now(), pauseReason: "" });
      const busy = !!(await getRun());
      await discover({
        yolo,
        fetch: (url, init) => fetch(url, init),
        scrape: busy ? undefined : scrape,
        relevance: yolo.aiRelevanceCheck ? relevance : undefined,
      });
      await setState({ lastCheckAt: Date.now() });
    } catch (e) {
      console.warn("[AutoApply] YOLO check failed:", (e as Error)?.message);
    } finally {
      cycling = null;
    }
    await pump();
  })());
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
    if (!queue.length) return void (await closeFrame().catch(() => undefined));
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

/** A run's outcome: retried in a tab when the hidden frame was refused, re-queued on a quota stop, else logged. */
async function finish(run: Run, r: YoloResult) {
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
  const text = [
    `${r.status}: ${run.item.company} – ${run.item.title} (${run.host})`,
    run.atsUrl ?? run.item.url,
    `Steps: ${run.steps.map((s) => s.split("|")[0]).join(" → ") || "none"}`,
    "reason" in r && r.reason && `Reason: ${r.reason}`,
    run.confirmation && `Confirmation: ${run.confirmation}`,
    `Answers (${answers.length}):`,
    ...answers.map((g) => `  ${g.q} = ${g.a}`),
  ]
    .filter(Boolean)
    .join("\n");
  await store.set({ yoloLogs: [...(await store.get("yoloLogs")), { at: Date.now(), text }].slice(-limit) });
}

async function watchdog() {
  const run = await getRun();
  if (!run) return void (await chrome.alarms.clear(WATCHDOG));
  const late = overdue(run);
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
      await session.remove("gmailToken");
      await gmailToken(yolo.gmailClientId, await accountEmail(), true);
      await setState({ gmailNeedsAuth: false, gmailConnected: true });
      return { ok: true };
    } catch (e) {
      return { error: { kind: "other", message: (e as Error).message } };
    }
  },

  async YOLO_GMAIL_CHECK() {
    try {
      await checkGmail(yolo.gmailClientId, await accountEmail());
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
      ...(skipped ? { posting: run.item.url } : {}),
    };
  },

  async YOLO_STEP({ facts, url, guesses }, sender) {
    const run = await getRun();
    if (!fromRun(run, sender)) return { kind: "unknown", stop: "Not running" };
    // Without the tab retry, a bot check in the frame is the user's, like anywhere else.
    const kind = kindOf(facts, run.host === "frame" && yolo.tabFallback);
    const sig = signature(kind, facts);
    run.guesses = mergeGuesses(run.guesses, guesses);
    // The page reloads to retry a submission flagged as spam: its steps repeat from the start, only the flags count.
    if (kind === "flagged") run.steps = run.steps.filter((s) => s.startsWith("flagged|"));
    run.steps.push(sig);
    run.stepAt = Date.now();
    if (kind === "success") run.confirmation = confirmation(facts);
    // Reached the employer's own posting from a board link: it may be one applied to through another source.
    let stop: string | undefined;
    if (kind === "blocked" && run.host === "frame") {
      const hosts = (await store.get("yoloTabHosts")).filter((h) => h !== hostOf(url));
      await store.set({ yoloTabHosts: [...hosts, hostOf(url)].slice(-200) });
    }
    if (!run.atsUrl && /^(form|signin|signup)$/.test(kind) && hostOf(url) !== hostOf(run.item.url)) {
      run.atsUrl = url;
      if (applied(await store.get("applications"), jobKey(url), run.item.alt, yolo.reapplyManual))
        stop = "Already applied through another link";
    }
    if (run.steps.filter((s) => s === sig).length >= 3)
      stop = kind === "flagged" ? "The site kept flagging it as automated" : `Stuck at the same ${kind} step`;
    if (run.steps.length > 40) stop = "Too many steps";
    await saveRun(run);
    return { kind, refused: /^(signin|signup|reset)$/.test(kind) && refused(facts), ...(stop ? { stop } : {}) };
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
    if (!fromRun(await getRun(), sender)) return { error: { kind: "other", message: "Not running" } };
    const email = await accountEmail();
    try {
      // No API client: codes can still come from the Gmail inbox signed in to this browser, links can't.
      if (!yolo.gmailClientId && want === "link") return { error: { kind: "other", message: "Gmail isn't connected" } };
      const found = yolo.gmailClientId
        ? await waitForEmail(() => gmailToken(yolo.gmailClientId, email, false), email, since, want)
        : await waitForFeedCode(email, since);
      if (!found) return { error: { kind: "other", message: "No verification email arrived" } };
      return want === "link" ? { link: found } : { code: found };
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
    await session.set(`yolodoc:${id}`, { meta, base64 });
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
  const ready = store.get("yolo").then((y) => (yolo = y));
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
        if (a.name === CHECK) await cycle();
        else if (a.name === WATCHDOG) await watchdog();
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
