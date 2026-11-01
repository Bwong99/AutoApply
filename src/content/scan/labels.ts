// §11.5 label / hint / section extraction.
import { computeAccessibleDescription, computeAccessibleName } from "dom-accessibility-api";
import { RE_HELPER_CLASS } from "../../shared/constants";
import { cleanLabel, clip, collapse, humanize } from "../../shared/normalize";

const NON_LABEL = "input,select,textarea,option,[role=option],[role=listbox],button,script,style";

/** Text as rendered: <slot>s show their assigned nodes (SmartRecruiters' buttons and headings). */
export function shownText(n: Node): string {
  if (n instanceof HTMLSlotElement) return n.assignedNodes({ flatten: true }).map(shownText).join("");
  if (n instanceof Element) return [...n.childNodes].map(shownText).join("");
  return n.nodeType === Node.TEXT_NODE ? (n.textContent ?? "") : "";
}

/** Text content without nested controls/options, or descendants hidden in a shown element (Lever's status text). */
export function textOf(el: Element, exclude = NON_LABEL): string {
  // A label whose text is slotted in from its host's light DOM (SmartRecruiters' <spl-input>'s question).
  if (el.querySelector("slot")) return collapse(shownText(el));
  const all = el.querySelectorAll("*");
  const shown = typeof el.checkVisibility === "function" && all.length && el.checkVisibility();
  const hidden = shown ? [...all].map((n) => !n.checkVisibility()) : [];
  if (!el.querySelector(exclude) && !hidden.includes(true)) return collapse(el.textContent ?? "");
  const clone = el.cloneNode(true) as Element;
  const copies = clone.querySelectorAll("*");
  hidden.forEach((h, i) => h && copies[i].remove());
  clone.querySelectorAll(exclude).forEach((n) => n.remove());
  return collapse(clone.textContent ?? "");
}

const rootOf = (el: Element) => el.getRootNode() as Document | ShadowRoot;
const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

/** `outside`: only elements outside `el`, not its own value (select2's combobox names its selection's container). */
function byIds(el: Element, attr: string, outside = false): string {
  const ids = el.getAttribute(attr)?.split(/\s+/).filter(Boolean) ?? [];
  const root = rootOf(el);
  return collapse(
    ids
      .map((id) => root.getElementById?.(id) ?? document.getElementById(id))
      .filter((n): n is HTMLElement => !!n && !(outside && el.contains(n)))
      .map((n) => textOf(n))
      .join(" "),
  );
}

/** <label for=id> in the same root, else a wrapping <label>. */
export function labelElementFor(el: HTMLElement): HTMLLabelElement | null {
  if (el.id) {
    const l = rootOf(el).querySelector<HTMLLabelElement>(`label[for="${esc(el.id)}"]`);
    if (l) return l;
  }
  return el.closest("label");
}

/** Steps 1–3 of §11.5 for a single control. */
export function controlLabel(el: HTMLElement): string {
  return ownName(el) || wrapperLabel(el);
}

/** A <label for> naming the control's wrapper: Ashby's "Start Date" labels the div holding month and year selects. */
function wrapperLabel(el: HTMLElement): string {
  for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
    const l = p.id ? rootOf(el).querySelector(`label[for="${esc(p.id)}"]`) : null;
    if (l && textOf(l)) return textOf(l);
  }
  return "";
}

function ownName(el: HTMLElement): string {
  const lb = byIds(el, "aria-labelledby", true);
  if (lb) return lb;
  const l = labelElementFor(el);
  if (l) {
    const t = textOf(l);
    if (t) return t;
  }
  if (/^(checkbox|switch|radio)$/.test(el.getAttribute("role") ?? "")) {
    const t = el.getAttribute("aria-label") || textOf(el);
    if (t) return collapse(t);
  }
  // Buttons/divs used as dropdown triggers would yield their current value as "name"; only trust explicit names.
  const nameFromContent = el.tagName === "BUTTON" || !/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
  if (nameFromContent && !el.getAttribute("aria-label") && !el.getAttribute("title")) return "";
  try {
    const name = collapse(computeAccessibleName(el));
    if (unseenPlaceholder(el) && name === collapse(el.getAttribute("placeholder") ?? "")) return "";
    // Workday's questionnaire triggers name only their value: aria-label " Select One Required" on "Select One".
    return nameFromContent && name.replace(/\s*\b(required|optional)$/i, "") === textOf(el) ? "" : name;
  } catch {
    return "";
  }
}

/** Step 4: label of a radio/checkbox/button group. */
export function groupLabel(groupEl: Element | null): string {
  if (!groupEl) return "";
  const lb = byIds(groupEl, "aria-labelledby");
  if (lb) return lb;
  const al = groupEl.getAttribute("aria-label");
  if (al) return collapse(al);
  const legend = legendOf(groupEl);
  return legend ? textOf(legend) : "";
}

/** The fieldset's <legend>, or the first <label> Ashby titles it with ("Race", followed by long descriptions). */
export function legendOf(groupEl: Element | null): Element | null {
  const fs = groupEl?.tagName === "FIELDSET" ? groupEl : groupEl?.closest("fieldset");
  // Not a fieldset around a whole section: Eightfold's sr-only "Application questions" named every question in it.
  const others = (f: Element) =>
    [...f.querySelectorAll("input:not([type=hidden]),select,textarea")].some((i) => !groupEl!.contains(i));
  if (fs && fs !== groupEl && others(fs)) return null;
  return (
    fs?.querySelector(":scope > legend") ??
    (fs?.firstElementChild?.tagName === "LABEL" && !fs.firstElementChild.querySelector("input,select,textarea")
      ? fs.firstElementChild
      : null)
  );
}

/**
 * Step 5: visible text in `container` preceding `control`, excluding `skip` subtrees. Last 300 chars, or the first
 * <label>'s text when longer: Ashby's Yes/No pills follow their <label> and a long note, and the cut kept the note.
 */
export function precedingText(container: Element, control: Element, skip: Element[] = []): string {
  const parts: string[] = [];
  let label = "";
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (control.contains(n)) break;
    if (control.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) break;
    const p = n.parentElement;
    if (!p || p.closest("option,[role=option],select,textarea,script,style,[hidden]")) continue;
    if (skip.some((s) => s.contains(n))) continue;
    const t = n.textContent?.trim();
    if (!t) continue;
    parts.push(t);
    const l = p.closest("label");
    if (!label && l && container.contains(l)) label = textOf(l);
  }
  const text = collapse(parts.join(" "));
  if (text.length <= 300) return text;
  return label || text.slice(-300).replace(/^\S*\s/, "");
}

/**
 * A date box draws its own "mm/dd/yyyy", never its placeholder: Breezy's start and end dates both carry "Company".
 */
export const unseenPlaceholder = (el: Element) =>
  el instanceof HTMLInputElement && /^(date|month|week|time|datetime-local)$/.test(el.type);

const CONTROLS = "input:not([type=hidden]),select,textarea,button";

/** Text since the previous control, beside a box (Breezy's "Start date" / "End date" spans). */
function textBefore(el: Element): string {
  const parts: string[] = [];
  for (
    let n = el.previousElementSibling;
    n && !n.matches(CONTROLS) && !n.querySelector(CONTROLS);
    n = n.previousElementSibling
  )
    parts.unshift(textOf(n));
  return collapse(parts.join(" "));
}

/** Step 6. */
export function fallbackLabel(el: HTMLElement): string {
  const shown = unseenPlaceholder(el)
    ? textBefore(el)
    : el.getAttribute("placeholder") || el.getAttribute("aria-placeholder");
  if (shown) return collapse(shown);
  const title = el.getAttribute("title");
  if (title) return collapse(title);
  const name = el.getAttribute("name") || el.id;
  return name ? humanize(name) : "";
}

export function finishLabel(s: string): string {
  return clip(cleanLabel(s), 300);
}

// Long enough for the facts a description lists last (Waymo's export-control countries end near 400 characters).
const HINT_MAX = 600;

export function hintFor(el: HTMLElement, container: Element): string {
  const d = byIds(el, "aria-describedby");
  if (d) return clip(d, HINT_MAX);
  try {
    const desc = collapse(computeAccessibleDescription(el));
    if (desc) return clip(desc, HINT_MAX);
  } catch {
    // dom-accessibility-api can throw on exotic markup; fall through to helper classes
  }
  const helpers = [...container.querySelectorAll<HTMLElement>("[class]")].filter(
    (n) => RE_HELPER_CLASS.test(typeof n.className === "string" ? n.className : "") && !el.contains(n),
  );
  const after = (n: Element) => !!(el.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING);
  // Text after the control first; else a description between its label and it (Waymo's "described below").
  const label = labelElementFor(el);
  const between = (n: Element) =>
    !after(n) &&
    !n.contains(el) &&
    !n.querySelector("label") &&
    !!label &&
    !label.contains(n) &&
    !!(label.compareDocumentPosition(n) & 4);
  for (const n of [...helpers.filter(after), ...helpers.filter(between)]) {
    const t = textOf(n);
    if (t) return clip(t, HINT_MAX);
  }
  return "";
}

/**
 * Nearest preceding h1–h6 / [role=heading] in traversal order, or the legend of a fieldset holding the field.
 * Greenhouse's phone fieldset legend ("Phone") used to title every later field. A heading-less block classed
 * "education…"/"employment…" (Greenhouse's .education--container) names its fields' section.
 */
export function sectionFor(el: Element, order: Map<Element, number>, headings: HTMLElement[]): string {
  const pos = order.get(el) ?? 0;
  let best: HTMLElement | null = null;
  for (const h of headings) {
    if ((order.get(h) ?? Infinity) >= pos) break;
    if (h.tagName !== "LEGEND" || h.parentElement?.contains(el)) best = h;
  }
  for (let n = el.parentElement; n && !(best && n.contains(best)); n = n.parentElement) {
    const m = `${n.id} ${typeof n.className === "string" ? n.className : ""}`.match(/(?:^|\s)(education|employment)/i);
    if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  }
  return best ? clip(textOf(best) || collapse(shownText(best)), 120) : "";
}
