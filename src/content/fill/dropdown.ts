// §14.5 custom dropdowns: open, harvest (incl. virtualized lists), select, verify, sync hidden select.
import { OPTION_SELECTORS, RE_NO_OPTIONS, RE_PLACEHOLDER_OPTION } from "../../shared/constants";
import { collapse, normalize } from "../../shared/normalize";
import type { FieldHandle } from "../scan/fields";
import { deepQueryAll, shadowOf } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { isTextInput } from "../scan/widgets";
import { dispatching, focus, key, realClick, setNativeValue, sleep, typeText, waitFor } from "./events";
import type { FillResult } from "./native";
import { dropdownText, isOn, sameValue } from "./verify";
import { throttled } from "../yolo/frame";

// Not an icon's <title>: Epic Games' country options read "CanadaCanada+1" with their flag's.
export const optText = (o: Element) => {
  if (!o.querySelector("svg")) return collapse(o.textContent ?? "");
  const clone = o.cloneNode(true) as Element;
  clone.querySelectorAll("svg").forEach((n) => n.remove());
  return collapse(clone.textContent ?? "");
};
// react-select's "No options" / "Loading…" notice sits in its listbox in place of options, worded as the site likes
// (Greenhouse's school search: "Start typing…"), as do select2 3.x's ("Please enter 1 or more character").
const RE_NOTICE_CLASS = /menu-notice|NoOptionsMessage|LoadingMessage|select2-(no-results|searching|more-results)/;
const isRealOption = (o: HTMLElement) => {
  const t = optText(o);
  return (
    !!t &&
    !RE_NO_OPTIONS.test(t) &&
    !RE_PLACEHOLDER_OPTION.test(t) &&
    !RE_NOTICE_CLASS.test(o.getAttribute("class") ?? "") &&
    o.getAttribute("aria-disabled") !== "true"
  );
};

/** Options slotted into a listbox from the light DOM, their role in their own shadow root (SmartRecruiters' spl-select). */
const slotted = (c: Element) =>
  [...c.querySelectorAll("slot")]
    .flatMap((s) => s.assignedElements({ flatten: true }))
    .filter(
      (e): e is HTMLElement =>
        e instanceof HTMLElement && (e.matches(OPTION_SELECTORS) || !!shadowOf(e)?.querySelector("[role=option]")),
    );

export function optionElements(c: Element): HTMLElement[] {
  // Innermost match only: Workday's [role=option] row ignores clicks; its promptOption label inside takes them.
  let els = [...c.querySelectorAll<HTMLElement>(OPTION_SELECTORS)].filter((o) => !o.querySelector(OPTION_SELECTORS));
  if (!els.length) els = slotted(c);
  if (!els.length && c.getAttribute("role") === "listbox") els = [...c.querySelectorAll<HTMLElement>(":scope > *")];
  // A suggestion grid (Oracle's city and postal code lookups): one gridcell per suggestion.
  if (!els.length && c.getAttribute("role") === "grid") els = [...c.querySelectorAll<HTMLElement>("[role=gridcell]")];
  // Plain list rows in a popup its button controls (Jane Street's li.dropdown-row).
  if (!els.length) els = [...c.querySelectorAll<HTMLElement>("li")].filter((o) => !o.querySelector("li"));
  return els.filter((o) => isVisible(o) && isRealOption(o));
}

export interface Snapshot {
  boxes: Set<Element>;
  options: Set<Element>;
}

export const snapshot = (): Snapshot => ({
  boxes: new Set(deepQueryAll("[role=listbox]").filter(isVisible)),
  options: new Set(deepQueryAll(OPTION_SELECTORS).filter(isVisible)),
});

function controlledBy(els: (Element | undefined)[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of els) {
    for (const attr of ["aria-controls", "aria-owns"]) {
      for (const id of el?.getAttribute(attr)?.split(/\s+/) ?? []) {
        const t = id && ((el!.getRootNode() as Document).getElementById?.(id) ?? document.getElementById(id));
        if (t) out.push(t);
      }
    }
  }
  return out;
}

/** The options container that appeared for this widget (§14.5.1 step 2). */
export function findOptionsContainer(h: FieldHandle, before: Snapshot): HTMLElement | null {
  for (const c of controlledBy([h.el, h.searchInput, h.el.querySelector("[aria-controls],[aria-owns]") ?? undefined]))
    if (isVisible(c) && optionElements(c).length) return c;
  for (const lb of deepQueryAll("[role=listbox]"))
    if (lb !== h.listbox && !before.boxes.has(lb) && isVisible(lb) && optionElements(lb).length) return lb;
  const fresh = deepQueryAll(OPTION_SELECTORS).filter(
    (o) => !before.options.has(o) && !h.el.contains(o) && isVisible(o) && isRealOption(o),
  );
  const parents = new Map<Element, number>();
  for (const o of fresh) if (o.parentElement) parents.set(o.parentElement, (parents.get(o.parentElement) ?? 0) + 1);
  for (const [p, n] of parents) if (n >= 2 || fresh.length === 1) return p as HTMLElement;
  return null;
}

const triggerOf = (h: FieldHandle) =>
  h.el.matches("[role=combobox],[aria-haspopup]")
    ? h.el
    : (h.el.querySelector<HTMLElement>("[role=combobox]:not(input),[aria-haspopup]") ?? h.el);

export async function openDropdown(h: FieldHandle): Promise<HTMLElement | null> {
  if (h.listbox) return h.listbox;
  const before = snapshot();
  const t = triggerOf(h);
  realClick(t);
  let c = await waitFor(() => findOptionsContainer(h, before), 300);
  // Some sites drop a click that lands soon after another popup closed (Amazon's Select2: 250 ms); retry once.
  if (!c && t.getAttribute("aria-expanded") === "false") {
    realClick(t);
    c = await waitFor(() => findOptionsContainer(h, before), 300);
  }
  // A list empty until searched (iCIMS's schools): its search box shows beside the trigger, controlling the list.
  if (!c && t.getAttribute("aria-expanded") === "true") {
    const search = [...(t.parentElement?.querySelectorAll<HTMLInputElement>("input[aria-controls]") ?? [])].find(
      (i) => i !== h.searchInput && isTextInput(i) && isVisible(i),
    );
    const list = search && controlledBy([search]).find(isVisible);
    if (list) return list;
  }
  // Opened and settled with no options ("No results found" until a parent field is set): nothing more will come.
  const popups = controlledBy([t]).filter(isVisible);
  if (!c && t.getAttribute("aria-expanded") === "true" && popups.length && !busy(popups)) {
    await closeDropdown(h, popups[0]);
    return null;
  }
  // Workday's prompt opens from its search box, not from the wrapper the trigger selectors match. Not when the
  // widget says it is open: a second click would toggle a slow-loading list shut.
  if (!c && h.searchInput && ![t, h.searchInput].some((e) => e.getAttribute("aria-expanded") === "true")) {
    realClick(h.searchInput);
    c = await waitFor(() => findOptionsContainer(h, before), 300);
  }
  if (!c) {
    const target = h.searchInput ?? t;
    focus(target);
    key(target, "ArrowDown");
    c = await waitFor(() => findOptionsContainer(h, before), 900);
  }
  if (c) await settle(c);
  return c;
}

/**
 * False while a virtualized list (Workday) shows fewer rows than it declares and is still laying out: its popup
 * collapsed (1px tall) or with room left for rows it has yet to paint.
 */
function painted(c: HTMLElement): boolean {
  const els = optionElements(c);
  const last = els.at(-1);
  if (!last || !(Number(last.closest("[aria-setsize]")?.getAttribute("aria-setsize")) > els.length)) return true;
  const r = last.getBoundingClientRect();
  const box = c.getBoundingClientRect();
  return box.height >= r.height && r.bottom + r.height > box.bottom;
}

/** Workday paints two rows of a fresh list first and the rest up to ~300 ms later; reading early loses options. */
export async function settle(c: HTMLElement) {
  if (!painted(c)) await waitFor(() => painted(c), 1000);
}

export async function closeDropdown(h: FieldHandle, c: HTMLElement | null) {
  if (h.listbox || !c) return;
  key(h.searchInput ?? triggerOf(h), "Escape");
  await sleep(30);
  // A modal menu (MUI's Popover) hears Escape from inside it, and a click on the invisible backdrop covering the
  // page, not on the body beneath: left open, the backdrop took the form's Submit (Dover).
  if (c.isConnected && isVisible(c)) {
    key(c, "Escape");
    await sleep(30);
  }
  if (c.isConnected && isVisible(c)) {
    const at = document.elementFromPoint(1, 1);
    realClick(
      at && !at.closest("a,button,input,select,textarea,[role=button],[role=link]")
        ? (at as HTMLElement)
        : document.body,
      { x: 1, y: 1 },
    );
  }
}

// Virtualized lists re-render from scroll events, which fire on the next rendering frame. Hidden tabs render no
// frames, so there the event is ours, fired at once, and nothing waits on frames.
function scrollTo(s: HTMLElement, top: number) {
  s.scrollTop = top;
  if (throttled()) s.dispatchEvent(new Event("scroll"));
}
const settleScroll = () =>
  sleep(50).then(() =>
    throttled()
      ? undefined
      : Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
          sleep(100),
        ]),
  );

function scroller(c: HTMLElement): HTMLElement | null {
  for (const el of [c, ...c.querySelectorAll<HTMLElement>("*")])
    if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible") return el;
  return null;
}

// Infinite-scroll lists fetch their next page once scrolled to the very bottom: react-select-async-paginate
// (Greenhouse) checks the scroll position every 300 ms, then shows a spinner until the page arrives. A list is
// complete once it stays quiet (no growth, no spinner) this long; a harvest budget cannot cut this wait, or no
// scrollable list would ever fit in one.
const QUIET_MS = 500;
export const PAGE_MAX_MS = 5000;
const BUSY = "[aria-busy=true],[class*=loading i],[class*=spinner i]";
export const busy = (roots: Element[]) =>
  roots.some((r) => [r, ...r.querySelectorAll(BUSY)].some((el) => el.matches(BUSY) && isVisible(el)));

// Workday loads its list in pages as it scrolls, with no spinner, so rows can be skipped; its rows declare the
// list's size (aria-setsize), so a short harvest is known to be incomplete.
const declared = (seen: Map<string, HTMLElement>) =>
  Number([...seen.values()].at(-1)?.closest("[aria-setsize]")?.getAttribute("aria-setsize"));

/**
 * Collect option texts, scrolling virtualized lists until nothing new appears twice and the list stays quiet at
 * the bottom. Returns null if `deadline` passes before the list is complete, if it found fewer options than the list
 * declares, or for 500+ options.
 */
export async function collectOptions(
  c: HTMLElement,
  widget: Element,
  stopAt?: (text: string) => boolean,
  deadline = Infinity,
): Promise<Map<string, HTMLElement> | null> {
  const seen = new Map<string, HTMLElement>();
  const add = () => {
    let added = 0;
    for (const o of optionElements(c)) {
      const t = optText(o);
      if (!seen.has(t)) {
        seen.set(t, o);
        added++;
      } else seen.set(t, o);
    }
    return added;
  };
  add();
  const s = scroller(c);
  if (!s || [...seen.keys()].some((t) => stopAt?.(t))) return seen;
  scrollTo(s, 0);
  await settleScroll();
  add();
  let idle = 0;
  while (seen.size < 500) {
    scrollTo(s, s.scrollTop + s.clientHeight);
    await settleScroll();
    idle = add() ? 0 : idle + 1;
    if ([...seen.keys()].some((t) => stopAt?.(t))) return seen;
    if (Date.now() > deadline) return null;
    if (idle < 2) continue;
    const end = s.scrollHeight;
    scrollTo(s, end);
    const start = Date.now();
    let quiet = start;
    while (s.scrollHeight <= end) {
      const now = Date.now();
      if (busy([c, widget])) {
        quiet = now;
        if (now > deadline || now - start > PAGE_MAX_MS) return null;
      } else if (now - quiet >= QUIET_MS) return declared(seen) > seen.size ? null : seen;
      await sleep(50);
    }
    idle = 0;
  }
  return null;
}

/** Harvest options of a closed dropdown (§14.5.1); null if it cannot open or exceeds `budgetMs`. */
export async function harvestOptions(h: FieldHandle, budgetMs = Infinity): Promise<string[] | null> {
  const deadline = Date.now() + budgetMs;
  const c = await openDropdown(h);
  if (!c) return null;
  // A row still loading (Select2's "Loading more results…") means another page plus QUIET_MS: past a short budget.
  const loading =
    budgetMs < QUIET_MS && [...c.querySelectorAll(OPTION_SELECTORS)].some((o) => /^loading/i.test(optText(o)));
  const all = loading ? null : await collectOptions(c, h.el, undefined, deadline);
  await closeDropdown(h, c);
  const texts = all ? [...all.keys()] : [];
  return texts.length ? texts : null;
}

// Select2 keeps its search box in the popup, focused on open and tied to the list by aria-controls.
function searchBoxOf(h: FieldHandle, c: HTMLElement): HTMLInputElement | undefined {
  const a = document.activeElement;
  const searches = (i: Element | null): i is HTMLInputElement =>
    !!i && isTextInput(i) && !i.readOnly && controlledBy([i]).includes(c);
  if (h.searchInput) return h.searchInput;
  if (searches(a)) return a;
  // Not focused in a page without focus (YOLO's hidden frame): iCIMS's box sits near the results it controls.
  for (let p = c.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
    const box = [...p.querySelectorAll("input")].find((x) => searches(x) && isVisible(x));
    if (box) return box;
  }
  return undefined;
}

/** Workday's prompts search only on Enter, as their box declares; in filter-as-you-type boxes Enter picks an option. */
export function submitSearch(search: HTMLInputElement) {
  if (search.getAttribute("enterkeyhint") === "search") key(search, "Enter");
}

/** Types `query` into the open list's search box; waits until `want` finds something in the (re-rendered) list. */
async function searchList<T>(
  h: FieldHandle,
  c: HTMLElement,
  search: HTMLInputElement,
  query: string,
  want: (box: HTMLElement) => T | undefined,
): Promise<{ box: HTMLElement; hit: T | undefined }> {
  // A list re-rendered for the search is new; other fields' lists on the page are not it (Workday's skills chips).
  const before = snapshot();
  focus(search);
  setNativeValue(search, "");
  await typeText(search, query, 0);
  submitSearch(search);
  let box = c;
  const found = () => {
    const b = box.isConnected ? box : findOptionsContainer(h, before);
    if (b) box = b;
    return b ? want(b) : undefined;
  };
  // Remote search (Select2 AJAX, Workday) can take over a second: keep waiting while the list's spinner shows or
  // its popup is gone, still to be replaced.
  const pending = () => !box.isConnected || busy([box, h.el]);
  let hit: T | undefined = (await waitFor(found, 800)) ?? undefined;
  if (!hit && pending()) {
    await waitFor(() => found() || !pending(), PAGE_MAX_MS);
    hit = found();
  }
  return { box, hit };
}

/**
 * Options a dropdown lists for `query` in its popup search box, for remote lists too long to harvest (EA's
 * colleges: thousands, 100 per page). Null if it has no search box or nothing matches.
 */
export async function searchOptions(h: FieldHandle, query: string): Promise<string[] | null> {
  const c = await openDropdown(h);
  if (!c) return null;
  const search = searchBoxOf(h, c);
  if (!search) {
    await closeDropdown(h, c);
    return null;
  }
  const stale = new Set(optionElements(c));
  const { box, hit } = await searchList(h, c, search, query, (b) => {
    const els = optionElements(b);
    // "Searching…" is a spinner, not an empty result; the unfiltered list may linger until the search starts.
    if (!els.length && busy([b, h.el])) return undefined;
    return els.length !== stale.size || els.some((o) => !stale.has(o)) ? els : undefined;
  });
  if (hit?.length) await settle(box);
  const texts = hit?.length ? optionElements(box).map(optText) : [];
  await closeDropdown(h, box);
  return texts.length ? texts : null;
}

/**
 * A short answer shown as a word of its own: "No" is not picked when the box shows "Not applicable" or "None". The
 * next letter may be a capital (a remove button's text run on: "NoRemove").
 */
export function showsWord(shown: string, text: string): boolean {
  const t = collapse(text).toLowerCase();
  const lower = shown.toLowerCase();
  if (!t) return false;
  for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) {
    const before = shown[i - 1] ?? " ";
    const after = shown[i + t.length] ?? " ";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{Ll}\p{N}]/u.test(after)) return true;
  }
  return false;
}

const shows = (h: FieldHandle, text: string) => {
  const shown = dropdownText(h);
  if (!sameValue(text, shown, "contains")) return false;
  return collapse(text).length > 3 || showsWord(shown, text);
};
// Some widgets display only part of the picked option: Greenhouse's phone country shows "+1" for "Canada +1".
const showsPart = (h: FieldHandle, text: string) => {
  const shown = dropdownText(h);
  return !!normalize(shown) && sameValue(shown, text, "contains");
};

async function pickOne(h: FieldHandle, text: string, within?: string): Promise<boolean> {
  if (shows(h, text)) return true;
  let c = await openDropdown(h);
  if (!c) return false;
  const match = (t: string) => normalize(t) === normalize(text);
  let el = optionElements(c).find((o) => match(optText(o)));
  const search = searchBoxOf(h, c);
  if (!el && search)
    ({ box: c, hit: el } = await searchList(h, c, search, text, (b) =>
      optionElements(b).find((o) => match(optText(o))),
    ));
  if (!el) {
    const all = await collectOptions(c, h.el, match);
    const k = all && [...all.keys()].find(match);
    el = k ? all.get(k) : undefined;
  }
  if (!el) {
    await closeDropdown(h, c);
    return false;
  }
  const index = optionElements(c).indexOf(el);
  const before = dropdownText(h);
  // A partial display that did not change ("+1" preset by the phone input) may be another +1 country:
  // the reopened list's aria-selected option says which one is picked.
  const selected = async () => {
    const box = await openDropdown(h);
    const on = !!box && optionElements(box).some((o) => match(optText(o)) && isOn(o));
    await closeDropdown(h, box);
    return on;
  };
  const took = async () => shows(h, text) || (showsPart(h, text) && (dropdownText(h) !== before || (await selected())));
  const listed = optionElements(c);
  const pre = snapshot();
  realClick(el);
  await sleep(40);
  if (await took()) return true;
  if (index < 0) return false;
  // A category that opened its own list (Workday's "How Did You Hear About Us?") is no pick, and keys pressed now
  // land in that list: a UBC student got "WaterlooWorks".
  // Workday replaces its popup to show the category's own list.
  const box = c.isConnected ? c : within ? await waitFor(() => findOptionsContainer(h, pre), 1500) : null;
  const now = box && isVisible(box) ? optionElements(box) : null;
  if (now && (now.length !== listed.length || now.some((o, i) => o !== listed[i]))) {
    // Unless it was picked for an answer it lists, else its one or "Other" choice: GM's "Internet Job Board / Job
    // Search" › "Other", for LinkedIn.
    if (!within) return false;
    const sub =
      now.find((o) => normalize(optText(o)) === normalize(within)) ??
      (now.length === 1 ? now[0] : now.find((o) => /^other\b/i.test(optText(o))));
    if (!sub) return false;
    const pick = optText(sub);
    realClick(sub);
    await sleep(40);
    return shows(h, pick) || showsPart(h, pick) || shows(h, text);
  }
  // Keyboard-driven widgets: ArrowDown to the option, then Enter.
  const t = h.searchInput ?? triggerOf(h);
  focus(t);
  for (let i = 0; i <= index; i++) key(t, "ArrowDown");
  key(t, "Enter");
  await sleep(40);
  return took();
}

/** `within`: the answer to pick in the list a picked category opens (Workday's hierarchical prompts). */
export async function fillDropdown(h: FieldHandle, texts: string[], within?: string): Promise<FillResult> {
  if (h.listbox) {
    for (const text of texts) {
      const o = optionElements(h.listbox).find((x) => normalize(optText(x)) === normalize(text));
      if (!o) return { outcome: "failed", note: `Option not found: ${text}` };
      if (o.getAttribute("aria-selected") !== "true") realClick(o);
    }
    await sleep(20);
    return texts.every((t) => shows(h, t))
      ? { outcome: "ok", shown: texts.join(", ") }
      : { outcome: "mismatch", note: `Expected ${texts.join(", ")}` };
  }
  for (const text of texts) {
    if (!(await pickOne(h, text, within))) {
      const c = findOptionsContainer(h, { boxes: new Set(), options: new Set() });
      await closeDropdown(h, c);
      return { outcome: "failed", note: `Could not select "${text}"` };
    }
  }
  if (h.hiddenSelect) {
    const sel = h.hiddenSelect;
    dispatching(() => {
      for (const o of sel.options) if (texts.some((t) => normalize(t) === normalize(o.text))) o.selected = true;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  const open = findOptionsContainer(h, { boxes: new Set(), options: new Set() });
  if (open) await closeDropdown(h, open);
  return texts.every((t) => shows(h, t) || showsPart(h, t))
    ? { outcome: "ok", shown: dropdownText(h) }
    : { outcome: "mismatch", note: `Expected ${texts.join(", ")}, shows "${dropdownText(h)}"` };
}
