// §11.5 custom widget classification (generic heuristics, Appendix C.3).
import { DROPDOWN_TRIGGER_SELECTORS, RE_PLACEHOLDER_OPTION, RE_TYPEAHEAD_HINT } from "../../shared/constants";
import { collapse } from "../../shared/normalize";
import { isVisible } from "./visibility";

const TEXT_TYPES = /^(text|email|tel|url|number|search|)$/;

export const isTextInput = (el: Element): el is HTMLInputElement =>
  el instanceof HTMLInputElement && TEXT_TYPES.test(el.type);

export function isDropdownTrigger(el: HTMLElement): boolean {
  if (el instanceof HTMLInputElement && !el.readOnly) return false;
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return false;
  const role = el.getAttribute("role");
  const popup = el.getAttribute("aria-haspopup");
  return (
    el.matches(DROPDOWN_TRIGGER_SELECTORS) ||
    popup === "listbox" ||
    (popup === "true" && el.hasAttribute("aria-expanded")) ||
    role === "combobox"
  );
}

/** A wrapper counts as one dropdown only if it holds at most one real native control. */
export function wrapsSingleControl(el: HTMLElement): boolean {
  return (
    el.querySelectorAll("input:not([type=hidden]),textarea").length <= 1 && el.querySelectorAll("select").length <= 1
  );
}

export function isTypeaheadInput(input: HTMLInputElement, label: string): boolean {
  if (input.readOnly) return false;
  const ac = input.getAttribute("aria-autocomplete");
  if (input.getAttribute("role") === "combobox" || ac === "list" || ac === "both") return true;
  const cls = typeof input.className === "string" ? input.className : "";
  return (
    (RE_TYPEAHEAD_HINT.test(label) || RE_TYPEAHEAD_HINT.test(cls)) &&
    (input.hasAttribute("aria-controls") || input.hasAttribute("aria-owns") || keepsPick(input))
  );
}

/**
 * A hidden sibling input stores the picked suggestion (Lever: "location" → "selectedLocation"), or the picked place's
 * coordinates (legacy Greenhouse: latitude, longitude).
 */
function keepsPick(input: HTMLInputElement): boolean {
  const name = input.name.toLowerCase();
  return (
    !!name &&
    [...(input.parentElement?.children ?? [])].some(
      (s) =>
        s instanceof HTMLInputElement &&
        s.type === "hidden" &&
        (s.name.toLowerCase().includes(name) || /\b(latitude|longitude)\b|\[(lat|lng)\]/i.test(s.name)),
    )
  );
}

export function isPlaceholderOption(o: HTMLOptionElement, index: number): boolean {
  const text = collapse(o.text);
  if (!text) return true;
  if (!o.value && RE_PLACEHOLDER_OPTION.test(text)) return true;
  // Dashes answer nothing, whatever their value (IXL: <option value="--">--</option>).
  if (/^[-–—\s]+$/.test(text)) return true;
  // A leading option with an explicitly empty value is a prompt, whatever it says (Lever: "Click Here (If you …").
  if (index === 0 && o.value === "" && o.hasAttribute("value")) return true;
  return index === 0 && o.disabled && o.defaultSelected;
}

/** Non-placeholder options of a native select. More than `max` (default 300) → unknown (§11.5). */
export function nativeOptions(sel: HTMLSelectElement, max = 300): { texts: string[]; els: HTMLOptionElement[] } | null {
  const els = Array.from(sel.options).filter((o, i) => !isPlaceholderOption(o, i));
  if (els.length > max) return null;
  return { texts: els.map((o) => collapse(o.text)), els };
}

/** Hidden native <select> backing a custom widget, within its container. */
export function findHiddenSelect(container: Element): HTMLSelectElement | null {
  for (const s of container.querySelectorAll("select")) if (!isVisible(s)) return s;
  return null;
}
