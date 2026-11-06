import { createStorage } from "../../shared/storage";
import type { Application, QueueItem } from "../../shared/yolo";
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
