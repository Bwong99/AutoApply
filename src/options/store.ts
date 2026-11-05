// Options-page state: live storage values, debounced autosave (§8), and the "Saved" indicator.
import { useEffect, useRef, useState } from "preact/hooks";
import { createStorage, type LocalKey, type LocalValues } from "../shared/storage";
import type { Profile } from "../shared/types";

export const store = createStorage("options");

/** Subscribe to a storage key; returns undefined until loaded. */
export function useStored<K extends LocalKey>(key: K): LocalValues[K] | undefined {
  const [v, setV] = useState<LocalValues[K]>();
  useEffect(() => {
    void store.get(key).then(setV);
    return store.onChange([key], (c) => setV(c[key] as LocalValues[K]));
  }, [key]);
  return v;
}

let savedListeners: ((t: number) => void)[] = [];
export const onSaved = (fn: (t: number) => void) => {
  savedListeners.push(fn);
  return () => (savedListeners = savedListeners.filter((f) => f !== fn));
};
export const markSaved = () => savedListeners.forEach((f) => f(Date.now()));

export async function save(values: Partial<LocalValues>) {
  await store.set(values);
  markSaved();
}

/**
 * Profile editing with 400 ms debounced autosave. External changes (e.g. a learned answer saved
 * from a job page) are taken over only while there is no pending local edit.
 */
export function useProfile(): [Profile | undefined, (fn: (p: Profile) => void) => void] {
  const [profile, setProfile] = useState<Profile>();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<Profile>();
  useEffect(() => {
    void store.get("profile").then((p) => {
      latest.current = p;
      setProfile(p);
    });
    return store.onChange(["profile"], (c) => {
      if (pending.current || !c.profile) return;
      latest.current = c.profile;
      setProfile(c.profile);
    });
  }, []);
  const update = (fn: (p: Profile) => void) => {
    if (!latest.current) return;
    const next = structuredClone(latest.current);
    fn(next);
    latest.current = next;
    setProfile(next);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(async () => {
      pending.current = null;
      await store.set({ profile: latest.current! });
      markSaved();
    }, 400);
  };
  return [profile, update];
}

// ---------- dotted-path helpers ----------
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}

export function setPath(obj: object, path: string, value: unknown) {
  const keys = path.split(".");
  let o = obj as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  o[keys[keys.length - 1]] = value;
}

export const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every(isEmpty));

/** Leaf paths of an object; arrays are leaves. */
export function leaves(obj: unknown, prefix = ""): [string, unknown][] {
  if (obj && typeof obj === "object" && !Array.isArray(obj))
    return Object.entries(obj).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  return [[prefix, obj]];
}

// Fields that identify a list entry, so Prefill can tell a résumé entry the profile already has from a new one.
const ENTRY_KEY: Record<string, string[]> = {
  "personal.links.other": ["url"],
  education: ["school", "degree"],
  experience: ["company", "title"],
  projects: ["name"],
  extracurriculars: ["organization", "role"],
  "skills.languages": ["language"],
  "skills.certifications": ["name"],
};
const norm = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** Entries of `found` (the list at `path`) that `have` lacks: strings by value, objects by ENTRY_KEY (else every field). */
export function newEntries(path: string, have: unknown[], found: unknown[]): unknown[] {
  const key = (x: unknown) =>
    x && typeof x === "object"
      ? (ENTRY_KEY[path] ?? Object.keys(x)).map((k) => norm((x as Record<string, unknown>)[k])).join("|")
      : norm(x);
  const seen = new Set(have.map(key));
  return found.filter((x) => !isEmpty(x) && !seen.has(key(x)) && !!seen.add(key(x)));
}

/** §8.1 completeness: personal.*, each work-auth entry, first education entry, preferences.*. */
export function completeness(p: Profile): number {
  const items = [
    ...leaves(p.personal, "personal"),
    ...p.workAuthorization.entries.flatMap((e) => leaves(e)),
    ...(p.education[0] ? leaves(p.education[0]) : leaves({ school: "", degree: "", major: "" })),
    ...leaves(p.preferences, "preferences"),
  ];
  if (!p.workAuthorization.entries.length) items.push(["workAuthorization", ""]);
  return Math.round((100 * items.filter(([, v]) => !isEmpty(v)).length) / items.length);
}

export function useHash(): string {
  const [h, setH] = useState(location.hash.slice(1) || "/setup");
  useEffect(() => {
    const on = () => setH(location.hash.slice(1) || "/setup");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
}
