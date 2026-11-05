// What the content script does with the AI review's verdicts (background/services/reviewForm.ts): which fields it
// may change, the fill each answer becomes, and the controls the scan missed adopted as fields of their own.
import { RE_FORBIDDEN_CLICK, RE_SKIP_LABEL } from "../../shared/constants";
import { normalize } from "../../shared/normalize";
import type { ReviewMissed } from "../../shared/review";
import type { FieldKind } from "../../shared/types";
import type { FillOp } from "../fill/engine";
import { isForbiddenClick } from "../fill/events";
import { isFreeText } from "../match/deterministic";
import type { Adopted, FieldHandle } from "../scan/fields";
import { HOST_TAG } from "../scan/traverse";

/** Notes of fields the fill leaves to the user on purpose (mapFields' policy rules, settings): the review keeps out. */
export const RE_POLICY_NOTE =
  /answer it yourself|how your name is pronounced|school email isn't|complete the exercise|sensitive|flag for me|needs your confirmation|write this yourself|no résumé uploaded|no cover letter uploaded/i;

const MULTI = new Set<FieldKind>(["multiselect", "checkbox_group"]);
const TEXTY = new Set<FieldKind>(["text", "email", "tel", "url", "number", "date", "month", "textarea"]);

/** The fill that enters `answer` in `h`; null when the answer can't be entered that way. */
export function opForAnswer(h: FieldHandle, answer: string, options?: string[]): FillOp | null {
  const k = h.desc.kind;
  if (k === "file") return null;
  if (k === "checkbox") {
    if (/^(checked|true|yes|ticked|selected)$/i.test(answer)) return { type: "checked", value: true };
    if (/^(unchecked|false|no|unticked|)$/i.test(answer)) return { type: "checked", value: false };
    return null;
  }
  if (answer === "") return TEXTY.has(k) || k === "select" ? { type: "clear" } : null;
  if (options?.length) {
    const multi = MULTI.has(k) || !!h.desc.multiple;
    const parts = multi ? answer.split(/\s*\|\s*/).filter(Boolean) : [answer];
    const texts = parts.map((p) => options.find((o) => normalize(o) === normalize(p)));
    if (texts.length && texts.every((t): t is string => !!t)) return { type: "options", texts };
    return { type: "intended", answer };
  }
  if (isFreeText(k) && k !== "typeahead") return { type: "text", value: answer };
  return { type: "intended", answer };
}

const editable = (el: Element) =>
  (el instanceof HTMLInputElement &&
    !/^(checkbox|radio|file|submit|button|reset|image|hidden|password)$/.test(el.type)) ||
  el instanceof HTMLTextAreaElement ||
  (el as HTMLElement).isContentEditable ||
  el.getAttribute("role") === "textbox";

const CHOICES =
  "input[type=radio],input[type=checkbox],[role=radio],[role=checkbox],[role=option],button,[aria-pressed]";

/**
 * A missed question the review found, as a control to adopt: its element and how to scan it. Never our own panel, a
 * password, a bot trap, or a navigation/submit button.
 */
export function adoption(m: ReviewMissed, refs: Map<string, HTMLElement>): [HTMLElement, Adopted] | null {
  const els = m.refs.map((r) => refs.get(r)).filter((e): e is HTMLElement => !!e?.isConnected);
  if (!els.length || RE_SKIP_LABEL.test(m.question)) return null;
  if (els.some((e) => e.closest(HOST_TAG) || (e instanceof HTMLInputElement && e.type === "password"))) return null;
  const base = { label: m.question, required: m.required };
  const first = els[0];
  if (m.kind === "radio_group" || m.kind === "checkbox_group") {
    const members = els.length > 1 ? els : [...first.querySelectorAll<HTMLElement>(CHOICES)];
    if (members.length < 2) return els.length === 1 ? [first, { ...base, kind: "checkbox" }] : null;
    // Pills that would submit or navigate are no answers.
    if (members.some((b) => isForbiddenClick(b) && !(b instanceof HTMLInputElement))) return null;
    return [members[0], { ...base, kind: m.kind, members }];
  }
  if (m.kind === "checkbox") return [first, { ...base, kind: "checkbox" }];
  if (m.kind === "file") {
    const input =
      first instanceof HTMLInputElement && first.type === "file" ? first : first.querySelector("input[type=file]");
    return input instanceof HTMLInputElement ? [input, { ...base, kind: "file" }] : null;
  }
  if (m.kind === "select" || m.kind === "multiselect") {
    const sel = first instanceof HTMLSelectElement ? first : first.querySelector("select");
    if (sel) return [sel, { ...base, kind: sel.multiple ? "multiselect" : "select" }];
    return [first, { ...base, kind: "dropdown" }];
  }
  if (TEXTY.has(m.kind) || m.kind === "contenteditable") {
    const box = editable(first)
      ? first
      : first.querySelector<HTMLElement>("input,textarea,[contenteditable=true],[role=textbox]");
    if (box && editable(box)) {
      const kind: FieldKind =
        box.isContentEditable || box.getAttribute("role") === "textbox" ? "contenteditable" : m.kind;
      return [box, { ...base, kind: box instanceof HTMLTextAreaElement ? "textarea" : kind }];
    }
    // What looks like a box but opens a list (a read-only date or place picker): a dropdown.
    return first.matches("[role=combobox],[aria-haspopup],[aria-expanded]")
      ? [first, { ...base, kind: "dropdown" }]
      : null;
  }
  // dropdown / typeahead
  if (first instanceof HTMLInputElement && editable(first)) return [first, { ...base, kind: "typeahead" }];
  if (isForbiddenClick(first)) return null;
  return [first, { ...base, kind: "dropdown" }];
}

/** A button the review would press to show more of this application's questions: never one that submits or leaves. */
export function revealable(el: HTMLElement | undefined): el is HTMLElement {
  if (!el?.isConnected || el.closest(HOST_TAG) || isForbiddenClick(el)) return false;
  const t = normalize(el.innerText || el.getAttribute("aria-label") || "");
  if (!t || t.length > 60) return false;
  if (/\b(delete|remove|cancel|back|previous|close|sign ?out|log ?out|withdraw)\b/.test(t)) return false;
  return !RE_FORBIDDEN_CLICK.test(t) || /^\+?\s*(add|show|view|more|expand)\b/.test(t);
}
