import { createStorage } from "../../shared/storage";
import { isResumable, type Application, type QueueItem } from "../../shared/yolo";
const store = createStorage("background");

/** Runs each change after the one before it, so every read-modify-write sees the last one's write. */
function serial() {
  let last: Promise<unknown> = Promise.resolve();
  return (fn: () => Promise<void>) => {
    const next = last.then(fn);
    last = next.catch(() => undefined);
    return next;
  };
}
const apps = serial();
const queue = serial();

/** A review's manual submission can arrive while another application finishes. Serialize both writes. */
export const updateApplications = (change: (apps: Application[]) => Application[]) =>
  apps(async () => store.set({ applications: change(await store.get("applications")) }));

/** Discovery, the pump and requeues change the queue across awaits: each change applies to the queue as it is then. */
export const updateQueue = (change: (queue: QueueItem[]) => QueueItem[]) =>
  queue(async () => store.set({ yoloQueue: change(await store.get("yoloQueue")) }));

export const recordApplication = (a: Application) =>
  updateApplications((apps) => [...apps.filter((x) => x.key !== a.key), a]);

/** Record a submission without losing the original job, answers, or review metadata. */
export async function markApplicationSubmitted(
  key: string,
  doneUrl?: string,
  eligible: (a: Application) => boolean = (a) => a.status !== "submitted",
): Promise<Application | null> {
  let submitted: Application | null = null;
  await updateApplications((apps) =>
    apps.map((a) => {
      if (a.key !== key) return a;
      submitted = eligible(a)
        ? {
            ...a,
            status: "submitted",
            submittedBy: "user",
            at: Date.now(),
            doneUrl: doneUrl ?? a.doneUrl,
            reason: doneUrl ? "" : "Marked submitted by you",
          }
        : a;
      return submitted;
    }),
  );
  return submitted;
}

/** Record that the user won't submit an unfinished application, keeping its job, answers, and review metadata. */
export async function markApplicationSkipped(key: string): Promise<Application | null> {
  let skipped: Application | null = null;
  await updateApplications((apps) =>
    apps.map((a) => {
      if (a.key !== key) return a;
      skipped = isResumable(a) ? { ...a, status: "skipped", at: Date.now(), reason: "Marked skipped by you" } : a;
      return skipped;
    }),
  );
  return skipped;
}
