// Only live tabs are retained. No form contents, file payloads, or browser tab ids enter exports.
import { RE_APPLIED } from "../../shared/constants";
import { createStorage, session } from "../../shared/storage";
import type { Application } from "../../shared/yolo";
import { updateApplications } from "./applicationStore";
import { closeTab } from "./host";
import { pendingReview } from "./submissionReview";

const store = createStorage("background");
const KEY = "yoloReviewTabs";
const REFILLS = "yoloReviewRefills";
const STARTING = "yoloReviewRefillStarting";
interface ReviewTab {
  tabId: number;
  ready: boolean;
  attempted?: boolean;
  attemptUrl?: string;
}
type Tabs = Record<string, ReviewTab>;
let tabs: Tabs = {};
let resumePump: () => void = () => undefined;
let listening = false;
let saving: Promise<unknown> = Promise.resolve();
const persist = () => {
  const snapshot = structuredClone(tabs);
  const next = saving.then(() => session.set(KEY, snapshot));
  saving = next.catch(() => undefined);
  return next;
};

function watch() {
  const needed = Object.keys(tabs).length > 0;
  if (needed === listening) return;
  listening = needed;
  if (needed) {
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.onUpdated.addListener(updated);
  } else {
    chrome.tabs.onRemoved.removeListener(removed);
    chrome.tabs.onUpdated.removeListener(updated);
  }
}

function removed(tabId: number) {
  const keys = Object.keys(tabs).filter((key) => tabs[key].tabId === tabId);
  if (!keys.length) return;
  for (const key of keys) delete tabs[key];
  void persist();
  watch();
}

function updated(tabId: number, info: chrome.tabs.OnUpdatedInfo) {
  const entry = Object.entries(tabs).find(([, t]) => t.tabId === tabId);
  if (!entry) return;
  const [key, t] = entry;
  if (info.status === "loading" || info.discarded) {
    t.ready = false;
    void persist();
    void chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => undefined);
  }
  if (info.status === "complete") {
    // Tracking only. A reload or native Back must never reattach YOLO's driver.
    void chrome.tabs
      .sendMessage(tabId, { type: "YOLO_REVIEW_CONTEXT", key, ready: false }, { frameId: 0 })
      .catch(() => undefined);
    if (t.attempted) void checkConfirmation(key, tabId);
  }
}

export async function initReviewTabs(pump: () => void) {
  resumePump = pump;
  tabs = (await session.get<Tabs>(KEY)) ?? {};
  watch();
}

export async function retainReview(key: string, tabId: number, documentId?: string) {
  const held: ReviewTab = { tabId, ready: false };
  tabs[key] = held;
  await persist();
  watch();
  await chrome.tabs.update(tabId, { autoDiscardable: false });
  const tab = await chrome.tabs.get(tabId);
  // Reuse a single review group per window; don't move a foreground tab out from under the user.
  const groups = await chrome.tabGroups.query({ title: "AutoApply Review", windowId: tab.windowId });
  const groupId = await chrome.tabs.group({ tabIds: tabId, ...(groups[0] ? { groupId: groups[0].id } : {}) });
  await chrome.tabGroups.update(groupId, {
    title: "AutoApply Review",
    ...(!groups[0] && !tab.active ? { collapsed: true } : {}),
  });
  await chrome.tabs.sendMessage(
    tabId,
    { type: "YOLO_REVIEW_CONTEXT", key, ready: true },
    { frameId: 0, ...(documentId ? { documentId } : {}) },
  );
  held.ready = true;
  await persist();
}

export async function releaseReview(key: string, close = false) {
  const t = tabs[key];
  delete tabs[key];
  await persist();
  watch();
  if (!t) return;
  if (close) await closeTab(t.tabId);
  else {
    await chrome.tabs.update(t.tabId, { autoDiscardable: true }).catch(() => undefined);
    await chrome.tabs.ungroup(t.tabId).catch(() => undefined);
  }
}

export async function reviewList() {
  const live: string[] = [];
  let stale = false;
  await Promise.all(
    Object.entries(tabs).map(async ([key, t]) => {
      if (!t.ready) return;
      const reply = await chrome.tabs
        .sendMessage(t.tabId, { type: "YOLO_REVIEW_PING", key }, { frameId: 0 })
        .catch(() => null);
      if (reply?.ready) live.push(key);
      else {
        t.ready = false;
        stale = true;
      }
    }),
  );
  if (stale) await persist();
  const starting = await session.get<string>(STARTING);
  return {
    live,
    refilling: [...new Set([...(starting ? [starting] : []), ...((await session.get<string[]>(REFILLS)) ?? [])])],
  };
}

export async function openReview(key: string): Promise<boolean> {
  const held = tabs[key];
  if (!held?.ready) return false;
  const live = await chrome.tabs
    .sendMessage(held.tabId, { type: "YOLO_REVIEW_PING", key }, { frameId: 0 })
    .catch(() => null);
  if (!live?.ready) {
    held.ready = false;
    await persist();
    return false;
  }
  const tab = await chrome.tabs.get(held.tabId).catch(() => null);
  if (!tab?.id) return false;
  if (tab.groupId >= 0) await chrome.tabGroups.update(tab.groupId, { collapsed: false });
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  return true;
}

let refilling: Promise<unknown> = Promise.resolve();
export function queueReviewRefill(key: string) {
  const next = refilling.then(async () => {
    if ((await session.get<string>(STARTING)) === key) return;
    const keys = (await session.get<string[]>(REFILLS)) ?? [];
    await session.set(REFILLS, [...new Set([...keys, key])]);
  });
  refilling = next.catch(() => undefined);
  return next;
}

export function nextReviewRefill(): Promise<Application | null> {
  const next = refilling.then(async () => {
    const starting = await session.get<string>(STARTING);
    const keys = [...new Set([...(starting ? [starting] : []), ...((await session.get<string[]>(REFILLS)) ?? [])])];
    if (!keys.length) return null;
    const apps = await store.get("applications");
    const a = keys.map((key) => apps.find((a) => a.key === key && pendingReview(a))).find(Boolean);
    if (a) await session.set(STARTING, a.key);
    else await session.remove(STARTING);
    await session.set(REFILLS, a ? keys.filter((k) => k !== a.key) : []);
    return a ?? null;
  });
  refilling = next.catch(() => undefined);
  return next;
}

export const reviewRefillStarted = () => session.remove(STARTING);

export async function submitReview(key: string, doneUrl?: string) {
  const t = tabs[key];
  if (t?.attemptUrl) await session.set(`reviewSubmitted:${t.tabId}`, { url: t.attemptUrl, at: Date.now() });
  await updateApplications((apps) =>
    apps.map((a) =>
      a.key === key && pendingReview(a)
        ? {
            ...a,
            status: "submitted",
            submittedBy: "user",
            at: Date.now(),
            doneUrl: doneUrl ?? "",
            reason: doneUrl ? "" : "Marked submitted by you",
          }
        : a,
    ),
  );
  await releaseReview(key);
  resumePump();
}

export async function dismissReview(key: string) {
  await updateApplications((apps) =>
    apps.map((a) =>
      a.key === key && pendingReview(a)
        ? {
            ...a,
            status: "skipped",
            reason: "Dismissed without submitting",
            at: Date.now(),
          }
        : a,
    ),
  );
  await releaseReview(key, true);
  resumePump();
}

const confirmed = (pattern: string) =>
  new RegExp(pattern, "i").test(document.body?.innerText ?? "") ? location.href : null;
async function checkConfirmation(key: string, tabId: number) {
  if (tabs[key]?.tabId !== tabId || !tabs[key].attempted) return;
  const results = await chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: confirmed, args: [RE_APPLIED.source] })
    .catch(() => []);
  const done = results.find((r) => r.result)?.result;
  if (done && tabs[key]?.tabId === tabId) await submitReview(key, done);
}

/** Returns true when this attempt belongs to a held application, keeping its original identity and metadata. */
export async function reviewAttempt(sender: chrome.runtime.MessageSender, doneUrl?: string): Promise<boolean> {
  const entry = Object.entries(tabs).find(([, t]) => t.tabId === sender.tab?.id);
  if (!entry) {
    // Both an SPA confirmation and a navigation probe can report the same successful click.
    const completed = await session.get<{ url: string; at: number }>(`reviewSubmitted:${sender.tab?.id}`);
    return !!completed && completed.url === sender.url && Date.now() - completed.at < 60_000;
  }
  const [key, t] = entry;
  if (doneUrl) await submitReview(key, doneUrl);
  else {
    t.attempted = true;
    t.attemptUrl = sender.url;
    await persist();
    setTimeout(() => void checkConfirmation(key, t.tabId), 6000);
  }
  return true;
}
