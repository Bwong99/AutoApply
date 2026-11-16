import { createStorage, session } from "../../shared/storage";
import { isResumable } from "../../shared/yolo";

const store = createStorage("background");
const KEY = "yoloPendingResumes";
let changing: Promise<unknown> = Promise.resolve();

function change<T>(fn: () => Promise<T>): Promise<T> {
  const next = changing.then(fn);
  changing = next.catch(() => undefined);
  return next;
}

export const pendingResumeKeys = async () => (await session.get<string[]>(KEY)) ?? [];

/** Keep explicit resumes separate from discovery, including when YOLO is off. */
export const queuePendingResumes = (keys: string[]) =>
  change(async () => {
    const previous = await pendingResumeKeys();
    const queued = [...new Set([...previous, ...keys])];
    await session.set(KEY, queued);
    return queued.length - previous.length;
  });

/** Recheck outcomes at execution time: a queued application may have been submitted or forgotten. */
export const nextPendingResume = () =>
  change(async () => {
    const keys = await pendingResumeKeys();
    if (!keys.length) return null;
    const apps = new Map((await store.get("applications")).filter(isResumable).map((a) => [a.key, a]));
    const pending = keys.filter((key) => apps.has(key));
    await session.set(KEY, pending);
    return apps.get(pending[0]) ?? null;
  });

/** Remove only after starting successfully, so a worker restart does not lose the request. */
export const pendingResumeStarted = (key: string) =>
  change(async () =>
    session.set(
      KEY,
      (await pendingResumeKeys()).filter((k) => k !== key),
    ),
  );

/** Stop resume all: nothing queued starts. */
export const clearPendingResumes = () => change(() => session.set(KEY, []));
