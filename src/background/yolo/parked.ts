// Tabs held for the user: the filled form waits there, the queue goes on, and opening the application later drives
// the same page on (index.ts adopt) instead of starting over. A resumed run's tab (`waiting`) carries on only once the
// user presses Continue YOLO in it (`go`).
import { session } from "../../shared/storage";
import type { Run } from "./runner";

const KEY = "yoloParked";
/** Each holds a live application page in memory. */
export const MAX_PARKED = 3;
type Entry = Run & { waiting?: string; go?: boolean };
type Parked = Record<string, Entry>;
let changing: Promise<unknown> = Promise.resolve();

function change<T>(fn: (p: Parked) => Promise<T>): Promise<T> {
  const next = changing.then(async () => fn((await session.get<Parked>(KEY)) ?? {}));
  changing = next.catch(() => undefined);
  return next;
}

const release = (tabId?: number) =>
  tabId === undefined ? undefined : chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => undefined);

/** Drops the entries whose tabs were closed since. */
async function prune(p: Parked) {
  for (const [k, r] of Object.entries(p))
    if (r.tabId === undefined || !(await chrome.tabs.get(r.tabId).catch(() => null))) delete p[k];
}

/** The parked run, no longer held: a plain Run again. */
async function take(p: Parked, key: string | undefined): Promise<Run | null> {
  const entry = key === undefined ? undefined : p[key];
  if (!entry) return null;
  delete p[key!];
  await session.set(KEY, p);
  await release(entry.tabId);
  const { waiting: _w, go: _g, ...run } = entry;
  return run;
}

const read = async () => Object.entries((await session.get<Parked>(KEY)) ?? {});

export const parkedKeys = async () => Object.keys((await session.get<Parked>(KEY)) ?? {});

/** Holds the run's tab for the user; false at the limit (tabs closed since don't count). `waiting`: what it waits for. */
export const park = (key: string, run: Run, waiting?: string) =>
  change(async (p) => {
    await prune(p);
    if (run.tabId === undefined || (!p[key] && Object.keys(p).length >= MAX_PARKED)) {
      await session.set(KEY, p);
      return false;
    }
    // Never a Continue pressed for an earlier wait.
    p[key] = { ...run, waiting, go: false };
    await session.set(KEY, p);
    // Chrome's memory saver would reload it, losing the form.
    await chrome.tabs.update(run.tabId, { autoDiscardable: false }).catch(() => undefined);
    return true;
  });

/** The parked run for this application, no longer held. */
export const takeParked = (key: string) => change((p) => take(p, key));

export const dropParked = (key: string) => takeParked(key).then(() => undefined);

/** Every place is taken by a tab still open. */
export const parkedFull = () =>
  change(async (p) => {
    await prune(p);
    await session.set(KEY, p);
    return Object.keys(p).length >= MAX_PARKED;
  });

/** The application's tab waiting for the user to press Continue YOLO, and what for. */
export const waitingFor = async (key: string) => {
  const e = (await read()).find(([k, r]) => k === key && r.waiting)?.[1];
  return e?.tabId === undefined ? null : { tabId: e.tabId, waiting: e.waiting! };
};

/** What this tab waits for, if it is a waiting one. */
export const waitingText = async (tabId: number) => (await read()).find(([, r]) => r.tabId === tabId)?.[1].waiting;

/** Continue YOLO pressed in this tab: its run is driven on once the run slot is free. Its key, or null. */
export const continueParked = (tabId: number) =>
  change(async (p) => {
    const key = Object.keys(p).find((k) => p[k].tabId === tabId && p[k].waiting);
    if (!key) return null;
    p[key].go = true;
    await session.set(KEY, p);
    return key;
  });

/** The first run the user pressed Continue YOLO for, no longer held. */
export const takeContinued = () =>
  change((p) =>
    take(
      p,
      Object.keys(p).find((k) => p[k].go),
    ),
  );
