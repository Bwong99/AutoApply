// §11.5 grouping: radios, checkboxes, button-style choice groups, custom widgets → one Unit per question.
import { RE_NAV_BUTTON } from "../../shared/constants";
import { collapse } from "../../shared/normalize";
import type { FieldKind } from "../../shared/types";
import { labelElementFor, precedingText, textOf } from "./labels";
import type { Collected } from "./traverse";
import { isVisible, parentOf } from "./visibility";
import { isDropdownTrigger, isTextInput, wrapsSingleControl } from "./widgets";

export interface Unit {
  kind: FieldKind;
  /** Anchor element: the control, the dropdown trigger, or the first group member. */
  el: HTMLElement;
  members?: HTMLElement[];
  groupEl?: Element | null;
  buttonStyle?: boolean;
  searchInput?: HTMLInputElement;
  listbox?: HTMLElement;
  /** A date typed into separate Month / Day / Year boxes, in their order. */
  sections?: HTMLInputElement[];
}

/** Which part of a date a box holds, by its name: Workday's spinbuttons are "Month", "Day", "Year". */
export function datePart(el: HTMLInputElement): "m" | "d" | "y" | null {
  const n = (el.getAttribute("aria-label") || el.placeholder || "").trim();
  return /^(month|mm)$/i.test(n) ? "m" : /^(day|dd)$/i.test(n) ? "d" : /^(year|yyyy|yy)$/i.test(n) ? "y" : null;
}

const INPUT_KIND: Record<string, FieldKind | null> = {
  text: "text",
  "": "text",
  email: "email",
  tel: "tel",
  url: "url",
  number: "number",
  date: "date",
  month: "month",
  "datetime-local": "text",
  week: "text",
  time: "text",
  file: "file",
  search: null,
  password: null,
  hidden: null,
  submit: null,
  button: null,
  reset: null,
  image: null,
  range: null,
  color: null,
};

/** Text of a choice member (radio/checkbox input, role=radio element or button). */
export function memberText(m: HTMLElement): string {
  if (m instanceof HTMLInputElement) {
    const l = labelElementFor(m);
    const t = (l && textOf(l)) || m.getAttribute("aria-label") || "";
    if (t) return t;
    const next = m.nextSibling?.textContent?.trim();
    return next || m.value;
  }
  // Web components keep the text in a `label` attribute their shadow root renders (SmartRecruiters' <spl-radio>).
  return (
    m.getAttribute("aria-label") || textOf(m, "input,select,textarea,script,style") || m.getAttribute("label") || ""
  );
}

const choiceVisible = (m: HTMLElement) => {
  if (isVisible(m)) return true;
  const l = m instanceof HTMLInputElement ? labelElementFor(m) : null;
  return !!l && isVisible(l);
};

function groupBy<T>(items: T[], key: (t: T) => unknown): T[][] {
  const m = new Map<unknown, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return [...m.values()];
}

const scopeOf = (el: HTMLElement) => (el as HTMLInputElement).form ?? el.getRootNode();

/** The nearest ancestor holding another of `peers`: Gem wraps each nameless Yes / No / N/A radio on its own. */
function sharedParent(el: HTMLElement, peers: HTMLElement[]): Element | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
    if (peers.some((o) => o !== el && p.contains(o))) return p;
  return el.parentElement;
}

export function isQuestionContainer(parent: Element, first: Element): boolean {
  if (parent.getAttribute("aria-label") || parent.getAttribute("aria-labelledby")) return true;
  let c: Element | null = parent;
  for (let i = 0; i < 3 && c; i++, c = parentOf(c)) {
    const t = precedingText(c, first);
    if (t) return /\?\s*\*?$/.test(t);
  }
  return false;
}

/** A <label for> or an aria-labelledby target outside the control names it: a field, not a toolbar button. */
function labelledFromOutside(b: HTMLElement): boolean {
  const root = b.getRootNode() as Document | ShadowRoot;
  const ids = b.getAttribute("aria-labelledby")?.split(/\s+/).filter(Boolean) ?? [];
  if (
    ids.some((id) => {
      const n = root.getElementById?.(id);
      return !!n && !b.contains(n) && !!textOf(n);
    })
  )
    return true;
  return !!b.id && !!labelElementFor(b);
}

/** Popups (listboxes, menus) opened by a dropdown/combobox, found via aria-controls/aria-owns. */
function dropdownPopups(cands: HTMLElement[]): Element[] {
  const popups: Element[] = [];
  for (const el of cands) {
    if (!isDropdownTrigger(el) && el.getAttribute("role") !== "combobox") continue;
    const root = el.getRootNode() as Document | ShadowRoot;
    const ids = `${el.getAttribute("aria-controls") ?? ""} ${el.getAttribute("aria-owns") ?? ""}`;
    for (const id of ids.split(/\s+/).filter(Boolean)) {
      const p = root.getElementById(id);
      if (p && !p.contains(el)) popups.push(p);
    }
  }
  return popups;
}

export function buildUnits(c: Collected): Unit[] {
  const units: Unit[] = [];
  const taken = new Set<Element>();
  const take = (u: Unit) => {
    units.push(u);
    taken.add(u.el);
    u.members?.forEach((m) => taken.add(m));
  };
  // An open dropdown's popup belongs to its trigger, not a new question (else opening one triggers an AI call).
  const popups = dropdownPopups(c.candidates);
  const cands = c.candidates.filter((el) => !popups.some((p) => p.contains(el)));

  // 1. Custom dropdown triggers: outermost wins; an inner editable input becomes its search box.
  const triggers: HTMLElement[] = [];
  for (const el of cands) {
    if (!isDropdownTrigger(el) || !wrapsSingleControl(el) || !isVisible(el)) continue;
    if (triggers.some((t) => t.contains(el))) continue;
    if (el.getAttribute("role") === "radiogroup") continue;
    triggers.push(el);
  }
  for (const t of triggers) {
    const inner = t.querySelector<HTMLInputElement>("input:not([type=hidden])");
    take({ kind: "dropdown", el: t, searchInput: inner && !inner.readOnly ? inner : undefined });
    cands.filter((x) => t.contains(x)).forEach((x) => taken.add(x));
  }
  // A button[aria-expanded][aria-controls] under a question label also opens a list (Appendix C.3), as does a popup
  // button a label names (BambooHR's Fabric selects: their list renders elsewhere once opened, no aria-controls).
  for (const b of c.buttons) {
    if (taken.has(b) || !b.hasAttribute("aria-expanded") || !isVisible(b)) continue;
    const labelled = /^(true|listbox|menu)$/.test(b.getAttribute("aria-haspopup") ?? "") && labelledFromOutside(b);
    if (!b.hasAttribute("aria-controls") && !labelled) continue;
    if (RE_NAV_BUTTON.test(textOf(b)) || !b.parentElement) continue;
    // One keeping its pick in a named hidden input is a form's select (Jane Street: "Select your college").
    if (!labelled && !isQuestionContainer(b.parentElement, b) && !b.querySelector("input[type=hidden][name]")) continue;
    take({ kind: "dropdown", el: b });
  }

  // 2. Native radios grouped by name within the same form/root, else by radiogroup/fieldset.
  const radios = cands.filter((e): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === "radio");
  const freeRadios = radios.filter((r) => !taken.has(r));
  const nameless = freeRadios.filter((r) => !r.name);
  const byName = groupBy(
    freeRadios.filter((r) => r.name),
    scopeOf,
  ).flatMap((g) => groupBy(g, (r) => r.name));
  // Eightfold names each radio of one radiogroup apart ("…choice-0", "…choice-1"): still one question.
  const lone = byName.filter((g) => g.length === 1 && g[0].closest("[role=radiogroup]"));
  const radioGroups = [
    ...byName.filter((g) => !lone.includes(g)),
    ...groupBy(lone.flat(), (r) => r.closest("[role=radiogroup]")),
    ...groupBy(nameless, (r) => r.closest("[role=radiogroup],fieldset") ?? sharedParent(r, nameless)),
  ];
  for (const members of radioGroups) {
    // Not a fieldset around a whole section of questions: Pinpoint's legend "3.Questions" named each of its Yes/Nos.
    const g = members[0].closest("[role=radiogroup],fieldset");
    const own =
      g &&
      [...g.querySelectorAll("input:not([type=hidden]),select,textarea")].every((i) =>
        members.includes(i as HTMLInputElement),
      );
    if (members.some(choiceVisible)) take({ kind: "radio_group", el: members[0], members, groupEl: own ? g : null });
  }

  // 3. Native checkboxes: shared name, or a fieldset/[role=group] whose boxes share (or lack) a name.
  const boxes = cands.filter(
    (e): e is HTMLInputElement => e instanceof HTMLInputElement && e.type === "checkbox" && !taken.has(e),
  );
  // Split by question too: Ashby names boxes after their option, so each survey question's "I prefer not to answer"
  // shares one name (Sierra).
  const named = groupBy(
    boxes.filter((b) => b.name),
    (b) => b.name,
  ).flatMap((g) => groupBy(g, (b) => b.closest("fieldset,[role=group]") ?? scopeOf(b)));
  for (const g of named.filter((g) => g.length >= 2)) {
    if (g.some(choiceVisible))
      take({ kind: "checkbox_group", el: g[0], members: g, groupEl: g[0].closest("fieldset,[role=group]") });
  }
  const rest = boxes.filter((b) => !taken.has(b));
  for (const g of groupBy(rest, (b) => b.closest("fieldset,[role=group]") ?? b)) {
    const sameName = new Set(g.map((b) => b.name)).size === 1;
    // Ashby names each box of one question after its own option ("LinkedIn", "Glassdoor"; Harvey's "Open to Anything ").
    const namedByOption = g.every((b) => b.name && collapse(b.name) === collapse(memberText(b)));
    if (g.length >= 2 && (sameName || namedByOption) && g[0].closest("fieldset,[role=group]")) {
      if (g.some(choiceVisible))
        take({ kind: "checkbox_group", el: g[0], members: g, groupEl: g[0].closest("fieldset,[role=group]") });
    } else for (const b of g) if (choiceVisible(b)) take({ kind: "checkbox", el: b });
  }

  // 4. ARIA radiogroups and button-style groups.
  for (const rg of cands.filter((e) => e.getAttribute("role") === "radiogroup" && !taken.has(e))) {
    if (rg.querySelector("input[type=radio]")) continue;
    const members = [...rg.querySelectorAll<HTMLElement>("[role=radio],button[aria-pressed],[aria-checked]")];
    if (members.length && isVisible(rg))
      take({ kind: "radio_group", el: members[0], members, groupEl: rg, buttonStyle: true });
  }
  // Workable wraps each native radio in a role=radio div: the radios already make that question.
  const wrapsTaken = (e: Element) => [...e.querySelectorAll("input")].some((i) => taken.has(i));
  const looseChoices = cands.filter(
    (e) => !taken.has(e) && (e.getAttribute("role") === "radio" || e.matches("button[aria-pressed]")) && !wrapsTaken(e),
  );
  for (const members of groupBy(looseChoices, (e) => e.parentElement)) {
    if (members.length < 2 || !members.some(isVisible)) continue;
    take({ kind: "radio_group", el: members[0], members, groupEl: members[0].parentElement, buttonStyle: true });
  }
  // 2–8 plain sibling buttons under a question ("Yes" / "No" pills).
  for (const members of groupBy(
    c.buttons.filter((b) => !taken.has(b)),
    (b) => b.parentElement,
  )) {
    if (members.length < 2 || members.length > 8 || !members[0].parentElement) continue;
    const ok = members.every((b) => {
      const t = textOf(b);
      const submitting = b.form && b.getAttribute("type") !== "button";
      return (
        !submitting &&
        t &&
        t.length <= 40 &&
        !RE_NAV_BUTTON.test(t) &&
        !b.hasAttribute("aria-expanded") &&
        !b.hasAttribute("aria-haspopup") &&
        isVisible(b)
      );
    });
    if (ok && isQuestionContainer(members[0].parentElement, members[0]))
      take({ kind: "radio_group", el: members[0], members, groupEl: members[0].parentElement, buttonStyle: true });
  }

  // 5. A date split into Month / Day / Year boxes: one question, not a "Month" and a bare "Year" (Workday's expected
  // graduation got 08/2027 for May 2028).
  const parts = cands.filter(
    (e): e is HTMLInputElement => e instanceof HTMLInputElement && !taken.has(e) && !!datePart(e) && isVisible(e),
  );
  for (const g of groupBy(parts, (e) => e.closest("[role=group]") ?? sharedParent(e, parts))) {
    const kinds = g.map(datePart);
    // A lone Year spinbutton too (Workday's education "To"): "May 2028" typed into it read "2805".
    const lone = g.length === 1 && g[0].getAttribute("role") === "spinbutton";
    if ((g.length < 2 && !lone) || g.length > 3 || !kinds.includes("y") || new Set(kinds).size !== g.length) continue;
    take({ kind: "date", el: g[0], groupEl: g[0].closest("[role=group]") ?? sharedParent(g[0], g), sections: g });
    g.forEach((e) => taken.add(e));
  }

  // 6. Everything else, one unit per control.
  for (const el of cands) {
    if (taken.has(el)) continue;
    const role = el.getAttribute("role");
    if (el instanceof HTMLInputElement) {
      if (el.type === "radio" || el.type === "checkbox") continue;
      const kind = INPUT_KIND[el.type] ?? (el.type in INPUT_KIND ? null : "text");
      if (!kind) continue;
      if (kind !== "file" && !isVisible(el)) continue;
      take({ kind: role === "combobox" && isTextInput(el) ? "typeahead" : kind, el });
    } else if (el instanceof HTMLSelectElement) {
      if (isVisible(el)) take({ kind: el.multiple ? "multiselect" : "select", el });
    } else if (el instanceof HTMLTextAreaElement) {
      if (isVisible(el)) take({ kind: "textarea", el });
    } else if (role === "checkbox" || role === "switch") {
      if (isVisible(el)) take({ kind: "checkbox", el });
    } else if (role === "listbox") {
      if (isVisible(el) && el.querySelector("[role=option]")) take({ kind: "dropdown", el, listbox: el });
    } else if (el.isContentEditable || role === "textbox") {
      if (isVisible(el)) take({ kind: "contenteditable", el });
    }
  }

  return units.sort((a, b) => (c.order.get(a.el) ?? 0) - (c.order.get(b.el) ?? 0));
}
