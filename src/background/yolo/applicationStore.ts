import { createStorage } from "../../shared/storage";
import type { Application } from "../../shared/yolo";
const store = createStorage("background");
let writing: Promise<unknown> = Promise.resolve();

/** A review's manual submission can arrive while another application finishes. Serialize both writes. */
export function updateApplications(change: (apps: Application[]) => Application[]) {
  const next = writing.then(async () => store.set({ applications: change(await store.get("applications")) }));
  writing = next.catch(() => undefined);
  return next;
}

export const recordApplication = (a: Application) =>
  updateApplications((apps) => [...apps.filter((x) => x.key !== a.key), a]);
