// §14.2–14.4 native controls: text-like, date, select, radio, checkbox, contenteditable.
import { collapse, normalize } from "../../shared/normalize";
import type { FieldHandle } from "../scan/fields";
import { datePart } from "../scan/groups";
import { labelElementFor } from "../scan/labels";
import { isVisible } from "../scan/visibility";
import { isPlaceholderOption, nativeOptions } from "../scan/widgets";
import { blur, dispatching, focus, realClick, setNativeValue, sleep, typeText } from "./events";
import { realFor, realType } from "../yolo/real";
import { isOn, readValue, sameValue } from "./verify";

export interface FillResult {
  outcome: "ok" | "mismatch" | "failed" | "flag";
  note?: string;
  shown?: string;
  /** File fields: the document uploaded, which may be a compatible substitute for the one asked for. */
  docId?: string;
}

const ok = (shown?: string): FillResult => ({ outcome: "ok", shown });

// ---------- dates (§14.3) ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function parseDate(v: string): { y: number; m: number; d?: number } | null {
  const t = v.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(t);
  if (m) return { y: +m[1], m: +m[2], d: m[3] ? +m[3] : undefined };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return { y: +m[3], m: +m[1], d: +m[2] };
  m = /^(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return { y: +m[2], m: +m[1] };
  m = /^([a-z]{3})[a-z]*\.?,? (\d{4})$/.exec(t);
  if (m && MONTHS.includes(m[1])) return { y: +m[2], m: MONTHS.indexOf(m[1]) + 1 };
  m = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(t);
  if (m && MONTHS.includes(m[1])) return { y: +m[3], m: MONTHS.indexOf(m[1]) + 1, d: +m[2] };
  return null;
}

/** A date in separate Month / Day / Year boxes (Workday): each part typed into its own box. */
async function fillDateSections(h: FieldHandle, raw: string): Promise<FillResult> {
  const yearOnly = h.sections!.every((s) => datePart(s) === "y") && /^\d{4}$/.test(raw.trim());
  const p = yearOnly ? { y: Number(raw.trim()), m: 1 } : parseDate(raw);
  if (!p) return { outcome: "flag", note: `Pick the date manually: ${raw}` };
  const want = { m: pad(p.m), d: pad(p.d ?? 1), y: String(p.y) };
  for (const s of h.sections!) {
    focus(s);
    setNativeValue(s, "");
    await typeText(s, want[datePart(s)!], 5);
    blur(s);
  }
  await sleep(0);
  const shown = readValue(h);
  return h.sections!.every((s) => Number(s.value) === Number(want[datePart(s)!]))
    ? ok(shown)
    : { outcome: "mismatch", note: `Expected "${raw}", shows "${shown}"` };
}

function sameDate(a: string, b: string): boolean {
  const x = parseDate(a);
  const y = parseDate(b);
  return !!x && !!y && x.y === y.y && x.m === y.m && (x.d === undefined || y.d === undefined || x.d === y.d);
}

const RE_DATE_PH = /^(mm|dd|yyyy|yy)([/.-])(mm|dd|yyyy|yy)(?:\2(mm|dd|yyyy|yy))?$/i;

/** Converts a value to what the input accepts: ISO for type=date/month, else the placeholder's format. */
export function formatDateFor(el: HTMLInputElement, value: string): string {
  const p = parseDate(value);
  if (!p) return value;
  if (el.type === "date") return `${p.y}-${pad(p.m)}-${pad(p.d ?? 1)}`;
  if (el.type === "month") return `${p.y}-${pad(p.m)}`;
  // react-datepicker (Ashby) reads ISO dates as UTC, a day early west of Greenwich; its default format is MM/DD/YYYY.
  const picker = el.closest(".react-datepicker__input-container") ? "MM/DD/YYYY" : "";
  const f = RE_DATE_PH.exec((el.placeholder || "").trim()) ?? RE_DATE_PH.exec(picker);
  if (!f) return value;
  const parts: Record<string, string> = {
    mm: pad(p.m),
    dd: pad(p.d ?? 1),
    yyyy: String(p.y),
    yy: String(p.y).slice(2),
  };
  return [f[1], f[3], f[4]]
    .filter(Boolean)
    .map((t) => parts[t.toLowerCase()])
    .join(f[2]);
}

const isDateField = (el: HTMLElement) =>
  el instanceof HTMLInputElement &&
  (el.type === "date" || el.type === "month" || RE_DATE_PH.test(el.placeholder.trim()));

/** Truncate at a word boundary to respect maxlength. */
export function fitLength(v: string, max?: number): string {
  if (!max || v.length <= max) return v;
  const cut = v.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}

// ---------- text-like ----------
export async function fillText(h: FieldHandle, raw: string): Promise<FillResult> {
  if (h.sections) return fillDateSections(h, raw);
  const el = h.el as HTMLInputElement | HTMLTextAreaElement;
  let value = el instanceof HTMLInputElement ? formatDateFor(el, raw) : raw;
  value = fitLength(value, h.desc.maxLength);
  const mode = h.desc.kind === "tel" ? "digits" : "text";
  focus(el);
  // YOLO on a page a bot check grades may type it for real (content/yolo/real.ts).
  if (!(realFor("typing") && (await realType(el, value)))) setNativeValue(el, value);
  blur(el);
  await sleep(0);
  if (sameValue(value, el.value, mode)) return ok(value);
  // Date widgets reformat what they are given (SmartRecruiters: "2026-08" → "08/2026").
  if (sameDate(value, el.value)) return ok(el.value);
  // Probably an input mask: clear and type it.
  focus(el);
  setNativeValue(el, "");
  await typeText(el, value, 5);
  blur(el);
  await sleep(0);
  if (sameValue(value, el.value, h.desc.kind === "tel" ? "digits" : "alnum")) return ok(el.value);
  // A date widget that misreads a month's name takes it in numbers (SmartRecruiters: "January 2026" → "08/2027").
  const p = parseDate(value);
  if (p && parseDate(el.value))
    for (const v of [p.d ? `${pad(p.m)}/${pad(p.d)}/${p.y}` : `${pad(p.m)}/${p.y}`, `${p.y}-${pad(p.m)}`]) {
      focus(el);
      setNativeValue(el, v);
      blur(el);
      await sleep(0);
      if (sameDate(v, el.value)) return ok(el.value);
    }
  if (isDateField(el)) return { outcome: "flag", note: `Pick the date manually: ${value}` };
  return el.value
    ? { outcome: "mismatch", note: `Expected "${value}", shows "${el.value}"` }
    : { outcome: "failed", note: "Field rejected the value" };
}

export async function fillContentEditable(h: FieldHandle, text: string): Promise<FillResult> {
  const el = h.el;
  focus(el);
  dispatching(() => {
    document.execCommand("selectAll");
    document.execCommand("insertText", false, text);
  });
  await sleep(0);
  if (!sameValue(text, el.innerText ?? "")) {
    dispatching(() => {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
    });
  }
  blur(el);
  return sameValue(text, el.innerText ?? el.textContent ?? "")
    ? ok(text)
    : { outcome: "failed", note: "Editor rejected the text" };
}

/** Empties a text box, or picks a native select's prompt option ("Month" left at "", iCIMS). */
export async function clearValue(h: FieldHandle): Promise<FillResult> {
  const el = h.el;
  if (el instanceof HTMLSelectElement) {
    const i = [...el.options].findIndex((o, k) => isPlaceholderOption(o, k));
    if (el.multiple || i < 0) return { outcome: "flag", note: "No empty option" };
    dispatching(() => {
      el.selectedIndex = i;
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return ok("");
  }
  if (h.sections || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement))
    return { outcome: "flag", note: "Clear it manually" };
  return fillText(h, "");
}

// ---------- choices ----------
const indexOfText = (h: FieldHandle, text: string) =>
  (h.desc.options ?? []).findIndex((o) => normalize(o) === normalize(text));

export async function fillSelect(h: FieldHandle, texts: string[]): Promise<FillResult> {
  const sel = h.el as HTMLSelectElement;
  // A select too long to scan has no option list: look the texts up among all its options.
  const els = (h.optionEls as HTMLOptionElement[] | undefined) ?? nativeOptions(sel, Infinity)?.els ?? [];
  const opts = texts.map((t) => els.find((o) => normalize(collapse(o.text)) === normalize(t)));
  if (!opts.every((o) => o !== undefined)) return { outcome: "failed", note: "Option not found" };
  dispatching(() => {
    if (sel.multiple) opts.forEach((o) => (o.selected = true));
    else sel.selectedIndex = opts[0].index;
    sel.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await sleep(0);
  const shown = readValue(h);
  return opts.every((o) => o.selected) ? ok(shown) : { outcome: "mismatch", note: `Expected ${texts.join(", ")}` };
}

function clickChoice(m: HTMLElement) {
  if (m instanceof HTMLInputElement && !isVisible(m)) {
    const l = labelElementFor(m);
    if (l) return realClick(l);
  }
  realClick(m);
}

export async function fillRadio(h: FieldHandle, text: string): Promise<FillResult> {
  const i = indexOfText(h, text);
  const m = h.members?.[i];
  if (!m) return { outcome: "failed", note: "Option not found" };
  if (isOn(m)) return ok(text);
  const before = m.className;
  clickChoice(m);
  await sleep(30);
  if (isOn(m)) return ok(text);
  // Button groups without ARIA state: a class change is the only signal; with none, assume success.
  const tracksState =
    m instanceof HTMLInputElement || ["aria-pressed", "aria-checked", "aria-selected"].some((a) => m.hasAttribute(a));
  if (!tracksState) return ok(text);
  return m.className !== before ? ok(text) : { outcome: "failed", note: "Choice did not register" };
}

export async function fillCheckbox(h: FieldHandle, checked: boolean): Promise<FillResult> {
  if (isOn(h.el) !== checked) {
    clickChoice(h.el);
    await sleep(20);
  }
  return isOn(h.el) === checked
    ? ok(checked ? "checked" : "unchecked")
    : { outcome: "failed", note: "Checkbox did not toggle" };
}

/**
 * Reach exactly the target set; only unchecks boxes we checked ourselves (§14.4, §18.8), or with `exact` (the AI
 * review's answer for the whole group) any box outside it, such as opt-ins the page ticked by default.
 */
export async function fillCheckboxGroup(
  h: FieldHandle,
  texts: string[],
  checkedByUs: Set<Element>,
  exact = false,
): Promise<FillResult> {
  const want = new Set(texts.map((t) => indexOfText(h, t)));
  if (want.has(-1)) return { outcome: "failed", note: "Option not found" };
  for (const [i, m] of (h.members ?? []).entries()) {
    const on = isOn(m);
    if (want.has(i) && !on) {
      clickChoice(m);
      checkedByUs.add(m);
    } else if (!want.has(i) && on && (exact || checkedByUs.has(m))) {
      clickChoice(m);
      checkedByUs.delete(m);
    }
  }
  await sleep(20);
  const okAll = [...want].every((i) => isOn(h.members![i]));
  return okAll ? ok(texts.join(", ")) : { outcome: "failed", note: "Some boxes did not toggle" };
}
