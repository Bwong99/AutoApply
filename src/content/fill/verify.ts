// §14.9 read-back and verification.
import { alnum, collapse, digitsOnly, normalize } from "../../shared/normalize";
import { shownText } from "../scan/labels";
import { isPlaceholderOption } from "../scan/widgets";
import type { FieldHandle } from "../scan/fields";

export type VerifyOutcome = "ok" | "mismatch" | "failed";

const ariaOn = (el: Element) =>
  ["aria-checked", "aria-pressed", "aria-selected"].some((a) => el.getAttribute(a) === "true");

export const isOn = (el: Element): boolean =>
  (el as HTMLInputElement).checked === true ||
  ariaOn(el) ||
  // Workable leaves its hidden radio unchecked and marks the role=radio wrapper around it.
  (el instanceof HTMLInputElement && ariaOn(el.parentElement?.closest("[role=radio],[role=checkbox]") ?? el));

/** Visible text of a custom dropdown, ignoring placeholder elements and the search box. */
export function dropdownText(h: FieldHandle): string {
  if (h.listbox)
    return [...h.listbox.querySelectorAll("[role=option][aria-selected=true]")]
      .map((o) => collapse(o.textContent ?? ""))
      .join(" | ");
  const clone = h.el.cloneNode(true) as HTMLElement;
  // A closed list kept in the widget is no value: Carvana's hidden Yes/No options read as already chosen.
  const lists = clone.querySelectorAll("[role=listbox]");
  h.el.querySelectorAll("[role=listbox]").forEach((l, i) => !l.getClientRects().length && lists[i]?.remove());
  clone.querySelectorAll('input,select,[class*="placeholder" i],script,style').forEach((n) => n.remove());
  // Screen-reader descriptions are not the value: Workday's empty prompt describes itself as "0 items selected".
  for (const id of [h.el, h.searchInput].flatMap((n) => n?.getAttribute("aria-describedby")?.split(/\s+/) ?? []))
    if (id) clone.querySelector(`#${CSS.escape(id)}`)?.remove();
  // A trigger inside a shadow root shows its value through a <slot> (SmartRecruiters' phone country: "+1").
  const text = collapse(clone.textContent ?? "") || (h.el.querySelector("slot") ? collapse(shownText(h.el)) : "");
  if (text) return text;
  // A transparent trigger laid over the box showing the pick (Greenhouse's web-ui selects): the box's own text.
  const box = h.el.parentElement;
  if (box && Number(getComputedStyle(h.el).opacity || 1) <= 0.05) {
    const shown = box.cloneNode(true) as HTMLElement;
    shown.querySelectorAll('button,input,select,[role=listbox],[class*="placeholder" i]').forEach((n) => n.remove());
    const t = collapse(shown.textContent ?? "");
    if (t) return t;
  }
  if (h.hiddenSelect && h.hiddenSelect.selectedIndex >= 0) {
    const o = h.hiddenSelect.options[h.hiddenSelect.selectedIndex];
    if (!isPlaceholderOption(o, h.hiddenSelect.selectedIndex)) return collapse(o.text);
  }
  // A read-only input opening the list (Workable) shows the pick as its own value.
  return (h.searchInput ?? (h.el instanceof HTMLInputElement ? h.el : undefined))?.value ?? "";
}

export function readValue(h: FieldHandle): string {
  const el = h.el;
  if (h.sections) {
    const parts = h.sections.map((s) => s.value.trim());
    return parts.some(Boolean) ? parts.join("/") : "";
  }
  switch (h.desc.kind) {
    case "select":
    case "multiselect": {
      const s = el as HTMLSelectElement;
      return Array.from(s.options)
        .filter((o, i) => o.selected && !isPlaceholderOption(o, i))
        .map((o) => collapse(o.text))
        .join(" | ");
    }
    case "radio_group":
    case "checkbox_group":
      return (h.members ?? [])
        .map((m, i) => (isOn(m) ? h.desc.options?.[i] : ""))
        .filter(Boolean)
        .join(" | ");
    case "checkbox":
      return isOn(el) ? "true" : "";
    case "dropdown":
      return dropdownText(h);
    case "contenteditable":
      return collapse(el.innerText ?? el.textContent ?? "");
    case "file":
      return (el as HTMLInputElement).files?.[0]?.name ?? "";
    default:
      return (el as HTMLInputElement).value ?? "";
  }
}

/** Compare normalized; phone and masked fields by digits/alphanumerics only. */
export function sameValue(expected: string, actual: string, mode: "text" | "digits" | "alnum" | "contains" = "text") {
  if (mode === "digits") {
    const [e, a] = [digitsOnly(expected), digitsOnly(actual)];
    // A phone widget may move the country code into its own picker ("+1 2365180162" shows "236-518-0162", Workable).
    return e !== "" && (e === a || (a.length >= 7 && e.length - a.length <= 3 && e.endsWith(a)));
  }
  if (mode === "alnum") return alnum(expected) === alnum(actual);
  if (mode === "contains") return normalize(actual).includes(normalize(expected));
  return normalize(expected) === normalize(actual);
}
