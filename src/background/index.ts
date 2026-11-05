// Service worker: message router, commands, onInstalled.
import { ensureContentScript, type Message, type Responses } from "../shared/messages";
import { createStorage, migrate, session } from "../shared/storage";
import { normalize } from "../shared/normalize";
import { formatTime } from "../shared/time";
import type { ApiError, EntryCounts, ModelCaps, Profile, Settings, TabStatus } from "../shared/types";
import { defaultSettings, type AiTask, type ClaudeTask } from "../shared/settings";
import { createClaude } from "./claude/client";
import { createGemini, listModels, type CallSpec } from "./gemini/client";
import { defangDeep } from "../shared/injection";
import {
  AllKeysExhaustedError,
  BadRequestError,
  BlockedError,
  ClaudeSetupError,
  classify,
  ModelGoneError,
  NoKeysError,
} from "./gemini/errors";
import { KeyPool } from "./gemini/keyPool";
import { defaultModel, updateCatalog, visibleModels } from "./gemini/models";
import { VALIDATION_PROMPT } from "./gemini/prompts";
import { VALIDATION_SCHEMA, ValidationZ } from "./gemini/schemas";
import { adoptPosting, getJobContext, getJobPay, setJobContext, setJobPay } from "./jobContext";
import { mapFields, type ServiceCtx } from "./services/mapFields";
import { chooseOptions } from "./services/chooseOptions";
import { draftEssays } from "./services/draftEssays";
import { editAnswer } from "./services/editAnswer";
import { parseResume } from "./services/parseResume";
import { pickResume } from "./services/pickResume";
import { tailoredDoc, tailoredResume } from "./services/tailorResume";
import { isTailoredDoc, TAILOR_PLACEHOLDER } from "../shared/resumeMode";
import {
  initYolo,
  isYoloDoc,
  runTab,
  yoloApplied,
  yoloDoc,
  yoloHandlers,
  yoloJob,
  yoloNote,
  yoloOverrides,
  yoloUpload,
} from "./yolo";

const store = createStorage("background");

function throttle(fn: () => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (!t)
      t = setTimeout(() => {
        t = null;
        fn();
      }, ms);
  };
}

// ---------- state (rebuilt whenever the service worker starts) ----------
let settings: Settings = defaultSettings();
let caps: Record<string, ModelCaps> = {};
const pool = new KeyPool([], {}, () => persistKeys());
const persistKeys = throttle(() => void store.set({ keyState: pool.state }), 500);
const persistCaps = throttle(() => void store.set({ modelCapabilities: caps }), 200);

const gemini = createGemini({
  pool,
  getCaps: (m) => caps[m],
  setCaps: (m, c) => {
    caps[m] = c;
    persistCaps();
  },
  concurrency: () => settings.maxConcurrentRequests,
  debug: () => settings.debugLogging,
});

const claude = createClaude({
  concurrency: () => settings.maxConcurrentRequests,
  debug: () => settings.debugLogging,
  onSetupError: () => void store.set({ claudeReady: false }),
});
const claudeLabel = (t: ClaudeTask) => `Claude (${t.model || "default"})`;
/** A Gemini model id (or Claude's fill model) as the AI page's Model list names it, for the popup and overlay. */
async function modelName(id: string | null): Promise<string | null> {
  if (settings.aiProvider === "claude") {
    const { model } = settings.claude.fill;
    const listed = (await store.get("claudeModels")).find((m) => m.value === model)?.displayName;
    // Capitalized alias until Claude Code has listed its models.
    return `Claude (${listed ?? (model ? model[0].toUpperCase() + model.slice(1) : "Default")})`;
  }
  return id && ((await store.get("modelCatalog"))[id]?.displayName || id);
}
const CLAUDE_MAP_FIELDS = 6;

const ready = (async () => {
  // Listen before reading, and let anything that changes meanwhile win over the initial read.
  const changed = new Set<string>();
  store.onChange(["settings", "apiKeys", "modelCapabilities"], (c) => {
    Object.keys(c).forEach((k) => changed.add(k));
    if (c.settings) settings = c.settings;
    if (c.apiKeys) pool.setKeys(c.apiKeys);
    if (c.modelCapabilities) caps = Object.keys(c.modelCapabilities).length ? { ...caps, ...c.modelCapabilities } : {};
  });
  await migrate();
  const s = await store.getMany(["settings", "apiKeys", "keyState", "modelCapabilities", "claudeRestart"]);
  // CLAUDE_TEST reloaded the extension to restart this worker: reopen the options page that closed.
  if (s.claudeRestart) {
    void store.set({ claudeRestart: "" });
    void chrome.tabs.create({ url: s.claudeRestart });
  }
  if (!changed.has("settings")) settings = s.settings;
  pool.setKeys(changed.has("apiKeys") ? pool.keys : s.apiKeys, s.keyState);
  caps = { ...s.modelCapabilities, ...caps };
  await initYolo({
    serviceCtx: (task) => serviceCtx(undefined, task),
    logLimit: () => (settings.debugLogging ? settings.debugLogLimit : 0),
  });
})();

// ---------- helpers ----------
/** What the AI is offered in AI tailor mode, for a file field it decides wants the résumé. */
const TAILORED_PLACEHOLDER_META = {
  id: TAILOR_PLACEHOLDER,
  label: "Résumé (tailored for this job)",
  kind: "resume" as const,
  fileName: "resume.pdf",
  mimeType: "application/pdf",
  size: 0,
  isPrimaryResume: true,
  uploadedAt: 0,
};

const groups = new Map<string, AbortController>();
function groupSignal(sender: chrome.runtime.MessageSender, groupId: string): AbortSignal {
  const k = `${sender.tab?.id}:${sender.frameId}:${groupId}`;
  let c = groups.get(k);
  if (!c) groups.set(k, (c = new AbortController()));
  return c.signal;
}

function toApiError(e: unknown): ApiError {
  if (e instanceof AllKeysExhaustedError)
    return {
      kind: "allKeysExhausted",
      message: `${e.message}${e.earliestRetryAt ? ` Next retry possible at ${formatTime(e.earliestRetryAt)}.` : ""}`,
      earliestRetryAt: e.earliestRetryAt,
    };
  if (e instanceof NoKeysError) return { kind: "noKey", message: "No API key" };
  if (e instanceof ClaudeSetupError) return { kind: "noKey", message: e.message };
  if (e instanceof ModelGoneError) return { kind: "modelGone", message: e.message };
  if (e instanceof BlockedError) return { kind: "blocked", message: "AI declined this request" };
  if (e instanceof DOMException && e.name === "AbortError") return { kind: "other", message: "Stopped" };
  return { kind: "other", message: (e as Error)?.message ?? String(e) };
}

const hostOf = (url?: string) => {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
};

/**
 * Every AI request, with the page's part (`payload`; the candidate's own data is `context`) cleared of traps for AI:
 * instructions planted for an AI or bot to catch automated applicants (shared/injection.ts).
 */
const untrapped = <T>(spec: CallSpec<T>): CallSpec<T> => ({ ...spec, payload: defangDeep(spec.payload) });

/** What a service calls the AI with; `task` picks Claude's model and effort. */
async function serviceCtx(signal?: AbortSignal, task: AiTask = "fill"): Promise<ServiceCtx | { error: ApiError }> {
  if (settings.aiProvider === "claude") {
    if (!(await store.get("claudeReady")))
      return { error: { kind: "noKey", message: "Claude isn't connected: set it up in AutoApply → AI." } };
    const t = settings.claude[task];
    // Claude always thinks, and thinking is serial: small parallel MAP calls finish sooner (15 fields: ~11 s → ~8.5 s).
    const capped = { ...settings, maxFieldsPerRequest: Math.min(settings.maxFieldsPerRequest, CLAUDE_MAP_FIELDS) };
    return {
      ai: { call: (spec) => claude.call(untrapped(spec), t) },
      settings: capped,
      model: claudeLabel(t),
      fallback: null,
      signal,
    };
  }
  const { selectedModel, fallbackModel } = await store.getMany(["selectedModel", "fallbackModel"]);
  if (!pool.keys.length) return { error: { kind: "noKey", message: "No API key" } };
  if (!selectedModel) return { error: { kind: "noModel", message: "No model selected" } };
  return {
    ai: { call: (spec, o) => gemini.call(untrapped(spec), o) },
    settings,
    model: selectedModel,
    fallback: fallbackModel,
    signal,
  };
}

async function refreshModels(force: boolean, onlyKey?: string): Promise<Responses["REFRESH_MODELS"]> {
  const { modelListFetchedAt, modelCatalog, selectedModel } = await store.getMany([
    "modelListFetchedAt",
    "modelCatalog",
    "selectedModel",
  ]);
  if (!force && !onlyKey && Date.now() - modelListFetchedAt < 24 * 3600 * 1000) return { ok: true };
  const keys = onlyKey
    ? [{ id: "", label: "new", key: onlyKey, addedAt: 0 }]
    : [...pool.keys].sort((a, b) => Number(!!pool.state[a.id]?.invalid) - Number(!!pool.state[b.id]?.invalid));
  let lastMsg = "No API key";
  for (const k of keys) {
    const r = await listModels(k.key);
    if ("models" in r) {
      const now = Date.now();
      const catalog = updateCatalog(modelCatalog, r.models, now);
      const sorted = visibleModels(catalog, now, now).map(([id]) => id);
      await store.set({
        modelCatalog: catalog,
        modelListFetchedAt: now,
        ...(selectedModel ? {} : { selectedModel: defaultModel(sorted) }),
      });
      if (k.id) pool.record(k.id, "", { kind: "success" }, 200);
      return { ok: true };
    }
    const c = classify(r.status, r.body);
    lastMsg = "message" in c ? c.message : `HTTP ${r.status}`;
    if (k.id) pool.record(k.id, "", c, r.status);
  }
  return { error: { kind: "other", message: lastMsg } };
}

async function updateTabStatus(tabId: number, fn: (s: TabStatus) => void) {
  const s = (await session.getTabStatus(tabId)) ?? { frames: {}, updatedAt: 0 };
  fn(s);
  s.updatedAt = Date.now();
  await session.setTabStatus(tabId, s);
}

const isExcluded = (host: string) => settings.excludedHosts.some((h) => h && (host === h || host.endsWith("." + h)));

/**
 * The tab's status from the page it now shows: frames that reported before that page's navigation began are an
 * earlier page's. Checked when the popup asks, instead of a tabs.onUpdated listener waking the service worker on
 * every tab change.
 */
async function currentTabStatus(tabId: number): Promise<TabStatus | null> {
  const s = await session.getTabStatus(tabId);
  if (!s) return null;
  const since = await chrome.scripting
    // Immediately: by default it waits for a loading page to go idle, delaying the popup.
    .executeScript({ target: { tabId, frameIds: [0] }, injectImmediately: true, func: () => performance.timeOrigin })
    .then(([r]) => Number(r?.result ?? Infinity))
    .catch(() => Infinity); // a browser page: nothing of ours runs there
  const frames = Object.fromEntries(Object.entries(s.frames).filter(([, f]) => (f.at ?? 0) >= since));
  if (Object.keys(frames).length === Object.keys(s.frames).length) return s;
  const fresh = { ...s, frames };
  await session.setTabStatus(tabId, fresh);
  return fresh;
}

/** Drops closed tabs' session data on a fill, instead of a tabs.onRemoved listener waking the worker on every close. */
const pruneClosedTabs = () => chrome.tabs.query({}).then((tabs) => session.pruneTabs(new Set(tabs.map((t) => t.id))));

const sendToTab = (tabId: number, msg: Message, frameId?: number) =>
  chrome.tabs.sendMessage(tabId, msg, frameId === undefined ? {} : { frameId }).catch(() => undefined);

/** Keeps the posting of the tab that opened `tab`, if it has none yet. Never reads a site the user excluded. */
async function borrowPosting(tab: chrome.tabs.Tab) {
  if (tab.id === undefined || tab.openerTabId === undefined || isExcluded(hostOf(tab.url))) return;
  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  if (!opener?.url || isExcluded(hostOf(opener.url))) return;
  await adoptPosting(tab.id, (await sendToTab(tab.openerTabId, { type: "READ_POSTING" }, 0)) ?? null);
}

function entryCounts(p: Profile): EntryCounts {
  const { links } = p.personal;
  return {
    experience: p.experience.filter((e) => e.title || e.company).length,
    education: p.education.filter((e) => e.school).length,
    certifications: p.skills.certifications.filter((c) => c.name).length,
    languages: p.skills.languages.filter((l) => l.language).length,
    projects: p.projects.filter((x) => x.name).length,
    // LinkedIn has its own field on the forms that have a Websites section. Each address once: a website that is the
    // GitHub link made Workday add a second entry, filled with the same URL ("You can't add duplicate website URLs").
    websites: new Set(
      [links.github, links.portfolio, links.website, ...links.other.map((o) => o.url)]
        .map((u) => u.trim().toLowerCase().replace(/\/+$/, ""))
        .filter(Boolean),
    ).size,
  };
}

// ---------- router ----------
type Handler<T extends Message["type"]> = (
  msg: Extract<Message, { type: T }>,
  sender: chrome.runtime.MessageSender,
) => Promise<Responses[T]>;
type Handlers = { [T in Message["type"]]?: Handler<T> };

const handlers: Handlers = {
  async GET_RUNTIME_CONFIG({ yolo }, sender) {
    const s = await store.getMany(["profile", "documentsIndex", "selectedModel", "overlayPos", "tailorResume"]);
    const host = hostOf(sender.tab?.url ?? sender.url);
    const y = yolo ? await yoloOverrides(sender) : null;
    const excluded = !y && isExcluded(host);
    return {
      settings: y ? { ...settings, ...y.settings } : settings,
      profileSnapshotForDeterministic: {
        personal: y ? { ...s.profile.personal, email: y.email } : s.profile.personal,
        aiReviewConsent: s.profile.background.consentToAiReview,
        optInConsents: {
          consentToJobOpportunities: s.profile.background.consentToJobOpportunities,
          consentToMarketing: s.profile.background.consentToMarketing,
        },
        learnedAnswers: s.profile.learnedAnswers.map(({ id, question, normalizedQuestion, kind, options, answer }) => ({
          id,
          question,
          normalizedQuestion,
          kind,
          options,
          answer,
        })),
      },
      entryCounts: entryCounts(s.profile),
      documentsIndex: s.documentsIndex,
      tailorReady: !!s.tailorResume,
      excluded,
      selectedModel: await modelName(s.selectedModel),
      hasKeys: pool.keys.length > 0,
      overlayBottom: s.overlayPos[host] ?? null,
      appliedBefore: y ? undefined : await yoloApplied(sender.tab?.url ?? ""),
    };
  },

  async GET_DOCUMENT({ id }, sender) {
    await yoloUpload(sender, id);
    if (isYoloDoc(id)) return yoloDoc(id);
    if (isTailoredDoc(id)) return tailoredDoc(store, id);
    const meta = (await store.get("documentsIndex")).find((d) => d.id === id);
    const base64 = meta ? await store.getDoc(id) : null;
    return meta && base64 ? { meta, base64 } : null;
  },

  /** The job details an AI-made document (tailored résumé, generated cover letter) was written from. */
  GET_DOC_JOB: ({ id }) => session.get(`docjob:${id}`),

  async SET_JOB_CONTEXT({ ctx }, sender) {
    const tab = await runTab(sender);
    const job = await yoloJob(sender);
    if (job) ctx = { ...ctx, company: job.company || ctx.company, jobTitle: job.title || ctx.jobTitle };
    // A run's pages are all one job: Paccar's career site ("portalcareer") names no location, the posting did
    // ("Kirkland, WA, US"), and "authorized to work in the country where position is based?" got the home country's Yes.
    if (!ctx.location && tab?.id !== undefined && (await yoloOverrides(sender))) {
      const prev = await getJobContext(tab.id);
      if (prev?.location) ctx = { ...ctx, location: prev.location };
    }
    // A page of the user's own without a description, whose address didn't say "job" when it opened.
    if (tab && !job && !ctx.text && !sender.frameId) await borrowPosting(tab);
    // A YOLO frame's driver is the page's top frame; it has no tab.
    if (tab?.id !== undefined)
      await setJobContext(tab.id, ctx, sender.frameId && sender.tab ? (tab.url ?? "") : undefined);
    void pruneClosedTabs().catch(() => undefined);
    return { ok: true };
  },

  async BORROW_POSTING(_, sender) {
    if (sender.tab && !(await yoloJob(sender))) await borrowPosting(sender.tab);
    return { ok: true };
  },

  async PICK_RESUME(_, sender) {
    const tab = await runTab(sender);
    const job = tab?.id !== undefined ? await getJobContext(tab.id) : null;
    const s = await store.getMany(["documentsIndex", "resumeTexts"]);
    return { id: pickResume(s.documentsIndex, job, s.resumeTexts) };
  },

  async SET_JOB_PAY({ pays, passive }, sender) {
    // Content scripts no longer ask on load whether a site is excluded; a read there on its own is dropped here.
    const excluded =
      isExcluded(hostOf(sender.tab?.url ?? sender.url)) || settings.excludedHosts.includes(hostOf(sender.url));
    const tab = await runTab(sender);
    if (tab && !(passive && excluded)) await setJobPay(tab, pays);
    return { ok: true };
  },

  async MAP_FIELDS({ fields, groupId, yolo, uploads }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId));
    if ("error" in ctx) return ctx;
    const s = await store.getMany(["profile", "documentsIndex"]);
    const tab = await runTab(sender);
    const job = tab?.id !== undefined ? await getJobContext(tab.id) : null;
    const pays = tab ? await getJobPay(tab) : [];
    const y = yolo ? await yoloOverrides(sender) : null;
    const profile = y ? { ...s.profile, personal: { ...s.profile.personal, email: y.email } } : s.profile;
    // Résumé variants are offered only in Variant select; AI tailor offers its tailored résumé in their place.
    const mode = y?.settings.resumeUpload ?? settings.resumeUpload;
    const documents =
      mode === "variants"
        ? s.documentsIndex
        : [
            ...s.documentsIndex.filter((d) => d.kind !== "resume"),
            ...(mode === "tailor" ? [{ ...TAILORED_PLACEHOLDER_META }] : []),
          ];
    const r = await mapFields(ctx, { fields, profile, documents, job, pays, yolo: !!y, uploads });
    return { ...r, usedModel: (await modelName(r.usedModel)) ?? r.usedModel };
  },

  async TAILOR_RESUME({ groupId }, sender) {
    const tab = await runTab(sender);
    const job = tab?.id !== undefined ? await getJobContext(tab.id) : null;
    const signal = groupSignal(sender, groupId);
    const r = await tailoredResume(store, job, () => serviceCtx(signal, "write"));
    if ("error" in r) return { error: { kind: "other", message: r.error } };
    await yoloNote(sender, r.tailored ? `Résumé tailored: ${r.note}` : `Untailored résumé uploaded: ${r.note}`);
    return { meta: r.meta, tailored: r.tailored, note: r.note };
  },

  async CHOOSE_OPTIONS({ items, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId));
    if ("error" in ctx) return ctx;
    return { choices: await chooseOptions(ctx, items, await store.get("profile")) };
  },

  async DRAFT_ESSAYS({ items, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId), "write");
    if ("error" in ctx) return ctx;
    const profile = await store.get("profile");
    const tab = await runTab(sender);
    const job = tab?.id !== undefined ? await getJobContext(tab.id) : null;
    return { essays: await draftEssays(ctx, items, profile, job) };
  },

  async EDIT_ANSWER({ edit, groupId }, sender) {
    const ctx = await serviceCtx(groupSignal(sender, groupId), "write");
    if ("error" in ctx) return ctx;
    const profile = await store.get("profile");
    const tab = await runTab(sender);
    const job = tab?.id !== undefined ? await getJobContext(tab.id) : null;
    try {
      const text = await editAnswer(ctx, edit, profile, job);
      return text ? { text } : { error: { kind: "other", message: "The AI returned nothing. Try again." } };
    } catch (e) {
      return { error: toApiError(e) };
    }
  },

  async SAVE_LEARNED_ANSWER({ answer }) {
    const profile = await store.get("profile");
    const nq = normalize(answer.question);
    const now = Date.now();
    const existing = profile.learnedAnswers.find((l) => l.normalizedQuestion === nq && l.kind === answer.kind);
    if (existing)
      Object.assign(existing, { answer: answer.answer, options: answer.options, host: answer.host, lastUsedAt: now });
    else
      profile.learnedAnswers.push({
        id: crypto.randomUUID(),
        question: answer.question,
        normalizedQuestion: nq,
        kind: answer.kind,
        options: answer.options,
        answer: answer.answer,
        host: answer.host,
        createdAt: now,
        lastUsedAt: now,
      });
    await store.set({ profile });
    return { ok: true };
  },

  async LEARNED_USED({ ids }) {
    const profile = await store.get("profile");
    const now = Date.now();
    for (const l of profile.learnedAnswers) if (ids.includes(l.id)) l.lastUsedAt = now;
    await store.set({ profile });
    return { ok: true };
  },

  async FRAME_STATUS({ status }, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { ok: true };
    const frameId = sender.frameId ?? 0;
    const st = { ...status, frameId, at: Date.now() };
    await updateTabStatus(tabId, (s) => void (s.frames[String(frameId)] = st));
    if (frameId !== 0) await sendToTab(tabId, { type: "FRAME_STATUS", status: st }, 0);
    return { ok: true };
  },

  async ABORT({ groupId }, sender) {
    const k = `${sender.tab?.id}:${sender.frameId}:${groupId}`;
    groups.get(k)?.abort();
    groups.delete(k);
    return { ok: true };
  },

  // The content script's timer while its tab is hidden (see sleep in fill/events.ts).
  SLEEP: ({ ms }) => new Promise((r) => setTimeout(() => r({ ok: true }), ms)),

  async BROADCAST_FILL({ rerun }, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return { ok: true };
    await ensureContentScript(tabId);
    await sendToTab(tabId, { type: "TRIGGER_FILL", force: true, rerun });
    return { ok: true };
  },

  async SET_OVERLAY_POS({ host, bottom }) {
    const overlayPos = await store.get("overlayPos");
    overlayPos[host] = bottom;
    await store.set({ overlayPos });
    return { ok: true };
  },

  async OPEN_OPTIONS({ hash }) {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/index.html#${hash}`) });
    return { ok: true };
  },

  async FOCUS_FIELD(msg, sender) {
    if (sender.tab?.id !== undefined) await sendToTab(sender.tab.id, msg, msg.frameId);
    return { ok: true };
  },

  async TAB_STATUS({ tabId }) {
    const status = await currentTabStatus(tabId);
    if (settings.aiProvider === "claude")
      return {
        status,
        provider: "claude",
        ready: await store.get("claudeReady"),
        model: await modelName(null),
        keysTotal: 0,
        keysHealthy: 0,
      };
    const selectedModel = await store.get("selectedModel");
    return {
      status,
      provider: "gemini",
      ready: pool.keys.length > 0 && !!selectedModel,
      model: selectedModel,
      keysTotal: pool.keys.length,
      keysHealthy: pool.healthyCount(selectedModel),
    };
  },

  async ADD_KEY({ label, key }) {
    const k = key.trim();
    if (!k) return { error: { kind: "other", message: "Enter a key" } };
    const keys = await store.get("apiKeys");
    if (keys.some((e) => e.key === k)) return { error: { kind: "other", message: "This key is already added" } };
    const r = await refreshModels(true, k);
    if ("error" in r) return r;
    const entry = {
      id: crypto.randomUUID(),
      label: label.trim() || `Key ${keys.length + 1}`,
      key: k,
      addedAt: Date.now(),
    };
    await store.set({ apiKeys: [...keys, entry] });
    pool.setKeys([...keys, entry]);
    return { ok: true };
  },

  async TEST_KEY({ id }) {
    const entry = pool.keys.find((k) => k.id === id);
    if (!entry) return { error: { kind: "other", message: "Unknown key" } };
    const r = await listModels(entry.key);
    if ("models" in r) {
      pool.record(id, "", { kind: "success" }, 200);
      return { ok: true };
    }
    const c = classify(r.status, r.body);
    pool.record(id, "", c, r.status);
    return { error: { kind: "other", message: "message" in c ? c.message : `HTTP ${r.status}` } };
  },

  async REFRESH_MODELS({ force }) {
    return refreshModels(force);
  },

  async VALIDATE_MODEL({ model }) {
    try {
      await gemini.validateModel(model);
      return { ok: true };
    } catch (e) {
      return { error: toApiError(e) };
    }
  },

  async PARSE_RESUME({ text }) {
    const ctx = await serviceCtx(undefined, "resume");
    if ("error" in ctx) return ctx;
    return { proposed: await parseResume(ctx, text) };
  },

  /** Asks Claude Code for a tiny reply with the autofill model; success marks Claude set up. */
  async CLAUDE_TEST({ restarted }, sender) {
    // Chromium builds chrome.runtime once per worker, leaving out methods it can't use yet, so a worker started
    // before the nativeMessaging grant never gets connectNative. Only a reload restarts it; that closes the options
    // page, so the new worker reopens it (see ready) to test again.
    if (
      !restarted &&
      typeof chrome.runtime.connectNative !== "function" &&
      (await chrome.permissions.contains({ permissions: ["nativeMessaging"] }))
    ) {
      const url = new URL(sender.url ?? chrome.runtime.getURL("src/options/index.html#/ai"));
      url.search = "?claude-restarted";
      await store.set({ claudeRestart: url.href });
      chrome.runtime.reload();
      return new Promise<never>(() => {});
    }
    const t0 = Date.now();
    try {
      const r = await claude.call(
        {
          system: VALIDATION_PROMPT,
          payload: '{"ping":true}',
          schema: VALIDATION_SCHEMA,
          validate: (d) => ValidationZ.parse(d),
          timeoutMs: 30000,
        },
        settings.claude.fill,
      );
      await store.set({ claudeReady: true });
      return { model: r.usedModel, ms: Date.now() - t0 };
    } catch (e) {
      return { error: toApiError(e) };
    }
  },

  /** Claude's REFRESH_MODELS: the models Claude Code offers, so new ones show up without an extension update. */
  async CLAUDE_MODELS({ force }) {
    if (!force && Date.now() - (await store.get("claudeModelsFetchedAt")) < 24 * 3600 * 1000) return { ok: true };
    try {
      await store.set({ claudeModels: await claude.listModels(), claudeModelsFetchedAt: Date.now() });
      return { ok: true };
    } catch (e) {
      return { error: toApiError(e) };
    }
  },

  ...yoloHandlers,
};

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse) => {
  const h = handlers[msg?.type] as Handler<Message["type"]> | undefined;
  if (!h) return false;
  ready
    .then(() => h(msg as never, sender))
    .then(sendResponse, (e) => {
      if (!(e instanceof BadRequestError)) console.warn("[AutoApply]", msg.type, (e as Error)?.message);
      sendResponse({ error: toApiError(e) });
    });
  return true;
});

// ---------- browser events ----------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ready;
  if (reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("src/options/index.html#/setup") });
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined && /^https?:/.test(tab.url ?? "")) void ensureContentScript(tab.id);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  if (command === "fill-page") {
    await ensureContentScript(tab.id);
    await sendToTab(tab.id, { type: "TRIGGER_FILL", force: true });
  } else if (command === "toggle-overlay") await sendToTab(tab.id, { type: "TOGGLE_OVERLAY" }, 0); // overlay lives in the top frame
});
