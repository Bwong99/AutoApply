// Repeatable sections (Workday "Work Experience" → Add / Add Another): open as many entries as the profile has,
// before the scan, so their fields get filled. A section the profile has nothing for is never added to. Entries that
// open as an editor with its own Save (SmartRecruiters) are saved once filled; nothing else is ever saved.
import { RE_FORBIDDEN_CLICK } from "../../shared/constants";
import { collapse } from "../../shared/normalize";
import type { EntryCounts } from "../../shared/types";
import { shownText } from "../scan/labels";
import { deepQueryAll, shadowOf } from "../scan/traverse";
import { composedContains, concealed, isVisible, parentOf } from "../scan/visibility";
import { dispatching, holdScroll, isForbiddenClick, waitFor } from "./events";

type Kind = keyof EntryCounts;
const KINDS: [Kind, RegExp][] = [
  ["certifications", /certific|licen[cs]e/i],
  ["languages", /^(add )?(spoken )?languages?\b/i],
  ["education", /education|academic|schools?\b|degrees?\b/i],
  ["experience", /^(?!.*volunteer).*(experience|employment|work history)/i],
  ["projects", /^(add )?projects?\b/i],
  ["websites", /websites?|\blinks?\b|portfolio/i],
];
const HEADINGS = "h1,h2,h3,h4,h5,h6,[role=heading]";
const RE_ADD = /^\+?\s*add\b/i;
/** An Add button that names nothing ("Add", "Add Another"): its section heading says what it adds. */
const RE_BARE_ADD = /^\+?\s*add( another| more| new)?( entry| item)?$/i;
/** An entry editor's own Save. "Save and continue" / "Save & Next" move the application on and never match. */
const RE_SAVE = /^save$/i;
const BUTTONS = "button,[role=button]";

/** Rendered text: SmartRecruiters' buttons and headings show theirs through <slot>s. Icon-font glyphs (Private Use
 * Area: SuccessFactors' U+E1F6 before "Add") are no text. */
const textOf = (el: Element) =>
  collapse(shownText(el).replace(/\p{Co}/gu, "")) || collapse(el.getAttribute("aria-label") ?? "");

/** Elements in document order, through shadow roots (SmartRecruiters' sections live in them). */
function* deepElements(root: ParentNode): Generator<Element> {
  for (const el of root.children) {
    yield el;
    const sr = shadowOf(el);
    if (sr) yield* deepElements(sr);
    yield* deepElements(el);
  }
}

interface Adder {
  kind: Kind;
  button: HTMLElement;
  section: Element;
  count: number;
}

const kindOf = (text: string) => KINDS.find(([, re]) => re.test(text))?.[0];

/** Workday's Add buttons sit in no <form> and default to type=submit, which submits nothing: only the text guard
 * of isForbiddenClick applies to such a button. */
const clickable = (el: HTMLElement, label: string) =>
  el instanceof HTMLButtonElement && !el.form
    ? !RE_FORBIDDEN_CLICK.test(`${label} ${el.getAttribute("aria-label") ?? ""}`)
    : !isForbiddenClick(el);

/**
 * Entries already there: numbered entry headings ("Education 2"), saved entries' Delete buttons plus open editors'
 * Save buttons, or an always-open first entry.
 */
function entryCount(section: Element): number {
  const numbered = deepQueryAll(HEADINGS, section).filter((h) => /\s\d+$/.test(textOf(h))).length;
  const buttons = deepQueryAll(BUTTONS, section).map(textOf);
  // SmartRecruiters names the entry: "Delete experience Software Engineer Intern FORM Swim".
  const entries = buttons.filter((t) => /^(delete|remove)\b/i.test(t) || RE_SAVE.test(t)).length;
  const open = deepQueryAll("input:not([type=hidden]),textarea,select", section).length ? 1 : 0;
  return Math.max(numbered, entries, open);
}

/** Entries can render beside the heading's own wrapper (SmartRecruiters): the section runs to the next such heading. */
function widen(section: Element, head: Element): Element {
  const same = head.matches("[role=heading]") ? "[role=heading]" : head.tagName;
  for (let p = parentOf(section); p && p !== document.body; p = parentOf(p)) {
    if (deepQueryAll(same, p).some((h) => h !== head && !composedContains(section, h))) break;
    section = p;
  }
  return section;
}

/** Would submit a form: an entry Save never does, the application's own button may. */
const submitsForm = (b: Element) => b instanceof HTMLButtonElement && b.type === "submit" && !!b.form;

const saveButtons = () =>
  deepQueryAll(BUTTONS).filter((b) => RE_SAVE.test(textOf(b)) && !submitsForm(b) && isVisible(b));

/** The first visible Add button per kind, named by its own text or the nearest heading before it. */
function findAdders(): Adder[] {
  const out: Adder[] = [];
  let heading: Element | null = null;
  for (const el of deepElements(document.body)) {
    if (el.matches(HEADINGS)) {
      heading = el;
      continue;
    }
    if (!(el instanceof HTMLElement) || !el.matches(`${BUTTONS},a`)) continue;
    const label = textOf(el);
    if (!RE_ADD.test(label) || label.length > 40) continue;
    const head = heading;
    heading = null; // a heading names only the first Add button after it
    const kind = RE_BARE_ADD.test(label) ? head && kindOf(textOf(head)) : kindOf(label);
    if (!kind || out.some((a) => a.kind === kind) || !clickable(el, label) || !isVisible(el)) continue;
    let section: Element | null = parentOf(head ?? el);
    while (section && !composedContains(section, el)) section = parentOf(section);
    section ??= document.body;
    if (head) section = widen(section, head);
    out.push({ kind, button: el, section, count: entryCount(section) });
  }
  return out;
}

/** What a collapsed section hides that the scan or findAdders needs: fields, or its Add button. */
const CONTROLS = `input:not([type=hidden]),textarea,select,[role=combobox],${BUTTONS}`;

/**
 * Opens collapsed sections that hide form controls (SuccessFactors shows only its first section; the rest, Add buttons
 * included, are display:none), so the scan and findAdders see them. The ARIA accordion pattern: an aria-expanded
 * toggle in the section's heading. Sections holding no controls (a job description's FAQ) stay as they are.
 */
export async function expandSections(signal: AbortSignal): Promise<void> {
  const toggles = deepQueryAll(`[aria-expanded="false"]`).filter((t) => {
    const head = t.closest(HEADINGS);
    const section = head && parentOf(head);
    return (
      !!section &&
      t.matches(BUTTONS) &&
      !t.hasAttribute("aria-haspopup") &&
      !isForbiddenClick(t) &&
      isVisible(t) &&
      // Clipped shut (height 0) too: the scan skips an optional text box no one could see, as it would a honeypot.
      deepQueryAll(CONTROLS, section).some((c) => !composedContains(head, c) && (!isVisible(c) || concealed(c)))
    );
  });
  if (!toggles.length) return;
  // Pages may scroll to the section they open.
  await holdScroll(async () => {
    // One at a time: a page may re-render its sections on each toggle.
    for (const t of toggles) {
      if (signal.aborted) break;
      dispatching(() => t.click());
      await waitFor(() => !t.isConnected || t.getAttribute("aria-expanded") === "true", 2000);
    }
  });
}

/**
 * Clicks Add until each section holds as many entries as the profile; resolves once they are on the page, with the
 * Save buttons of the entry editors those clicks opened (for saveEntries).
 */
export async function addEntries(want: EntryCounts, signal: AbortSignal): Promise<HTMLElement[]> {
  if (!Object.values(want).some(Boolean)) return [];
  let adders = findAdders().filter((a) => a.count < want[a.kind]);
  if (!adders.length) return [];
  const before = new Set(saveButtons());
  // Pages may focus or scroll to the new entry.
  await holdScroll(async () => {
    // One click at a time: SmartRecruiters opens each entry as an editor outside the Add button's section, so only a
    // new Save button shows which click it answers.
    for (const kind of adders.map((a) => a.kind)) {
      let adder = adders.find((a) => a.kind === kind);
      for (let have = adder?.count ?? 0; adder && have < want[kind] && !signal.aborted; have++) {
        const { button, section, count } = adder;
        const editors = saveButtons().length;
        dispatching(() => button.click());
        const grew = await waitFor(
          () => !section.isConnected || entryCount(section) > count || saveButtons().length > editors,
          3000,
        );
        // A click that added nothing countable (opened a dialog, unknown markup) is never repeated.
        if (!grew) break;
        // Workday re-renders its sections: Add becomes "Add Another".
        adders = findAdders();
        adder = adders.find((a) => a.kind === kind);
      }
    }
  });
  return saveButtons().filter((b) => !before.has(b));
}

// ---------- résumé entries a site's parser wrote (YOLO) ----------
export type EntryKind = "experience" | "education";
export interface Entry {
  kind: EntryKind;
  /** The number its Delete names it by (iCIMS: "Delete Experience (2)"), else its place among its kind's, from 1. */
  n: number;
  box: Element;
  remove: HTMLElement;
}

const RE_REMOVE = /^(delete|remove)\b/i;
/** A file's own Remove (iCIMS's "Delete File"), not an entry's. */
const RE_FILE_WORD = /\b(files?|resumes?|résumés?|cvs?|attachments?|documents?|photos?)\b/i;
const RE_SCHOOL_WORD = /\b(schools?|institution|university|college|degree|major|field of study|specialization)\b/i;
const RE_JOB_WORD = /\b(company|employer|job title|position)\b/i;
const FIELDS = "input:not([type=hidden]),textarea,select";

/**
 * Named by its Delete (iCIMS: "Delete Experience (2)"), else by what its
 * fields ask: labels and placeholders (Breezy names its boxes only by placeholders), then its text. School words first:
 * Breezy's education dates carry the placeholder "Company".
 */
function entryKind(box: Element, remove: HTMLElement): EntryKind | null {
  const named = /^(?:delete|remove) (experience|education)\b/i.exec(textOf(remove))?.[1];
  if (named) return named.toLowerCase() as EntryKind;
  const fields = deepQueryAll(FIELDS, box);
  if (fields.some((f) => (f as HTMLInputElement).type === "file")) return null;
  const asked = [
    ...deepQueryAll("label", box).map(textOf),
    ...fields.map((f) => `${f.getAttribute("placeholder") ?? ""} ${f.getAttribute("aria-label") ?? ""}`),
  ].join(" ");
  for (const t of [asked, textOf(box)]) {
    if (RE_SCHOOL_WORD.test(t)) return "education";
    if (RE_JOB_WORD.test(t)) return "experience";
  }
  return null;
}

/**
 * Work and education entries that each have their own Delete or Remove (Breezy, Avature, iCIMS), in page order. An
 * entry is the widest box around its Delete that holds no other Delete, nor, once it holds fields, an Add button
 * (iCIMS keeps an "Add more (Experience)" just outside each entry).
 */
export function resumeEntries(): Entry[] {
  const removes: HTMLElement[] = [];
  const adds: HTMLElement[] = [];
  for (const el of deepElements(document.body)) {
    if (!(el instanceof HTMLElement) || !el.matches(`${BUTTONS},a`)) continue;
    const t = textOf(el);
    if (RE_ADD.test(t)) adds.push(el);
    else if (RE_REMOVE.test(t) && !RE_FILE_WORD.test(t) && isVisible(el)) removes.push(el);
  }
  const count = { experience: 0, education: 0 };
  return removes.flatMap((remove) => {
    let box: Element = remove;
    for (let p = parentOf(box); p && p !== document.body; p = parentOf(p)) {
      if (removes.some((r) => r !== remove && composedContains(p, r))) break;
      if (deepQueryAll(FIELDS, box).length && adds.some((a) => composedContains(p, a))) break;
      box = p;
    }
    const kind = entryKind(box, remove);
    if (!kind) return [];
    count[kind]++;
    const named = /^(?:delete|remove) (?:experience|education) \((\d+)\)$/i.exec(textOf(remove))?.[1];
    return [{ kind, n: named ? Number(named) : count[kind], box, remove }];
  });
}

/**
 * YOLO: deletes the entries a site's résumé parser added past the profile's (Breezy listed 7 jobs for 2, projects
 * among them), latest first. Entries `ours` holds (filled by us) stay.
 */
export async function trimEntries(
  want: EntryCounts,
  ours: (box: Element) => boolean,
  signal: AbortSignal,
): Promise<void> {
  const next = () =>
    resumeEntries().findLast((e) => e.n > want[e.kind] && !ours(e.box) && clickable(e.remove, textOf(e.remove)));
  let e = next();
  if (!e) return;
  await holdScroll(async () => {
    for (let i = 0; e && i < 30 && !signal.aborted; i++, e = next()) {
      const { remove } = e;
      dispatching(() => remove.click());
      // A Delete that removed nothing is never pressed again. iCIMS only hides the entry.
      if (!(await waitFor(() => !remove.isConnected || !isVisible(remove), 2000))) break;
    }
  });
}

/**
 * Saves the entries addEntries opened, once their fields are filled. Only those editors' own Save buttons: never the
 * application's Save/Submit/Next, and never a button that would submit a form.
 */
export async function saveEntries(saves: HTMLElement[]): Promise<void> {
  await holdScroll(async () => {
    for (const b of saves) {
      if (!b.isConnected || !isVisible(b) || submitsForm(b)) continue;
      dispatching(() => b.click());
      // An editor that fails validation stays open, its fields badged for the user.
      await waitFor(() => !b.isConnected || !isVisible(b), 2000);
    }
  });
}
