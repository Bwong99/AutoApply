// The page as a person sees it, as text: what the AI review (and YOLO's navigator) reads instead of our scan's
// field list. Every control on the page gets a ref, scanned or not, so the review can name what the scan missed.
import { collapse } from "../../shared/normalize";
import { stealthy } from "../jobContextExtract";
import { labelElementFor } from "../scan/labels";
import { HOST_TAG, shadowOf } from "../scan/traverse";
import { clippedShut, concealed } from "../scan/visibility";

export interface SnapshotDeps {
  /** The scan's field id for an element (its control, a choice, its search box), if it is one. */
  fieldOf(el: Element): string | undefined;
  /** What the field shows, as our verify step reads it. */
  shown(fieldId: string): string;
  /** Why the scan left a control out. */
  excluded(el: Element): string | undefined;
  /** Fields whose picked state the page doesn't expose (button pills): what we picked, if anything. */
  unknownState(fieldId: string): string | undefined;
}

export interface Snapshot {
  text: string;
  /** Ref ("c12") → element. */
  refs: Map<string, HTMLElement>;
  /** Field id → its refs, in page order. */
  fieldRefs: Map<string, string[]>;
  /** Refs of controls no scanned field covers (and not excluded on purpose). */
  unscanned: string[];
  truncated: boolean;
}

const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "SVG", "HEAD", "META", "LINK", "OPTION", "DATALIST"]);
const BLOCK = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "DD",
  "DETAILS",
  "DIALOG",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LEGEND",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);
const HEADING = /^H[1-6]$/;
const RE_BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root)$/;

/** Starts a line of its own: by its display where the page sets one (pills are inline-block divs), else its tag. */
function isBlock(el: HTMLElement, tag: string): boolean {
  if (tag === "BR" || tag === "HR") return true;
  const d = el.style.display || getComputedStyle(el).display;
  return d ? RE_BLOCK_DISPLAY.test(d) : BLOCK.has(tag);
}
const CONTROL_ROLES =
  /^(combobox|listbox|option|radio|radiogroup|checkbox|switch|textbox|searchbox|spinbutton|slider|button|link|menuitem|menuitemradio|menuitemcheckbox|tab)$/;
const ALERT =
  '[role=alert],[aria-live=assertive],[class*="error" i],[class*="invalid" i],[data-automation-id*="error" i]';
const CHROME = "nav,[role=navigation],footer,[role=contentinfo]";
/** Links and buttons in site chrome worth a ref: the way into an application or an account. */
const RE_CHROME_ACTION = /apply|sign ?in|log ?in|sign ?up|register|account|continue|next|submit|start/i;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const q = (s: string) => `"${clip(collapse(s), 160).replace(/"/g, "'")}"`;

/** Laid out and not hidden by style: `isVisible` without its aria-hidden rule (a modal's aria-hidden app root). */
function rendered(el: Element): boolean {
  if (typeof el.checkVisibility === "function")
    return el.checkVisibility({ visibilityProperty: true, opacityProperty: true } as CheckVisibilityOptions);
  return el.getClientRects().length > 0;
}

/** Laid out at all (descendants of an element hidden by visibility can still show). */
const laidOut = (el: Element) =>
  el.getClientRects().length > 0 || getComputedStyle(el).display === "contents" || el.tagName === "SLOT";

function roleOf(el: HTMLElement): string | null {
  const role = el.getAttribute("role");
  if (role && CONTROL_ROLES.test(role)) return role;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (t === "hidden") return null;
    if (/^(submit|button|reset|image)$/.test(t)) return "button";
    if (t === "checkbox" || t === "radio" || t === "file" || t === "password" || t === "range") return t;
    return "textbox";
  }
  if (el instanceof HTMLSelectElement) return el.multiple ? "multiselect" : "select";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLButtonElement) return "button";
  if (el instanceof HTMLAnchorElement && el.hasAttribute("href")) return "link";
  if (el.isContentEditable && !el.parentElement?.isContentEditable) return "editor";
  return null;
}

/**
 * A div or span that acts as a control: focusable or clicked, shown with a pointer, and small (a card with a
 * pointer cursor is a container, not a control). Only the outermost of nested ones.
 */
function clickable(el: HTMLElement, parentPointer: boolean): boolean {
  if (parentPointer || !/^(DIV|SPAN|LI|LABEL|I|P|IMG)$/.test(el.tagName)) return false;
  // A label around its own box (a radio's) is that box's caption: the box is the control.
  if (el.querySelector("input,select,textarea,button,a[href],[role],[contenteditable]")) return false;
  if (!(el.hasAttribute("tabindex") || el.hasAttribute("onclick") || getComputedStyle(el).cursor === "pointer"))
    return false;
  return (el.innerText ?? "").length <= 120;
}

function valueOf(el: HTMLElement, role: string): string {
  if (el instanceof HTMLSelectElement) return [...el.selectedOptions].map((o) => collapse(o.text)).join(" | ");
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return "";
    if (el.type === "file") return [...(el.files ?? [])].map((f) => f.name).join(", ");
    if (el.type === "password") return el.value ? "••••" : "";
    return el.value;
  }
  if (el instanceof HTMLTextAreaElement) return el.value;
  if (role === "editor" || role === "textbox" || role === "searchbox") return el.innerText ?? "";
  if (role === "combobox" || role === "spinbutton" || role === "slider")
    return el.getAttribute("aria-valuetext") ?? el.getAttribute("aria-valuenow") ?? (el.innerText || "");
  return "";
}

function stateOf(el: HTMLElement): string[] {
  const out: string[] = [];
  const on =
    (el as HTMLInputElement).checked === true ||
    ["aria-checked", "aria-selected", "aria-pressed"].some((a) => el.getAttribute(a) === "true");
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"))
    out.push(on ? "checked" : "unchecked");
  else if (["aria-checked", "aria-selected", "aria-pressed"].some((a) => el.hasAttribute(a)))
    out.push(on ? "selected" : "unselected");
  const exp = el.getAttribute("aria-expanded");
  if (exp) out.push(exp === "true" ? "expanded" : "collapsed");
  if ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
  if ((el as HTMLInputElement).required || el.getAttribute("aria-required") === "true") out.push("required");
  if (el.getAttribute("aria-invalid") === "true") out.push("invalid");
  const v = (el as HTMLInputElement).validity;
  // A box the page refused beyond being empty (a format it wants): its own message says how.
  if (v && !v.valid && !v.valueMissing && (el as HTMLInputElement).validationMessage)
    out.push(`invalid=${q((el as HTMLInputElement).validationMessage)}`);
  return out;
}

/** The text a control shows for itself (a button's caption, a choice's option text). */
function ownText(el: HTMLElement): string {
  const t = collapse(el instanceof HTMLInputElement ? el.value || "" : el.innerText || el.textContent || "");
  return t || collapse(el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "");
}

/** Name hints for a control the scan doesn't know: its attributes say what it asks when the text around it doesn't. */
function hintsOf(el: HTMLElement): string[] {
  const out: string[] = [];
  for (const a of ["aria-label", "placeholder", "title", "name"]) {
    const v = el.getAttribute(a);
    if (v && collapse(v)) out.push(`${a}=${q(v)}`);
  }
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = by
      .split(/\s+/)
      .map((id) => (el.getRootNode() as Document | ShadowRoot).getElementById?.(id)?.textContent ?? "")
      .join(" ");
    if (collapse(t)) out.push(`labelledby=${q(t)}`);
  }
  return out;
}

/**
 * A box only a bot would fill: positioned or sized out of sight (concealed), or kept from keyboard and screen reader
 * alike (tabindex -1 inside aria-hidden). Honeypots look like this; real questions don't.
 */
export function honeypot(el: HTMLElement): boolean {
  if (el.getAttribute("tabindex") === "-1" && el.closest('[aria-hidden="true"]')) return true;
  return concealed(el) || clippedShut(el);
}

export function snapshot(deps: SnapshotDeps, maxChars = 60_000, root: Element | null = document.body): Snapshot {
  // Text people can't see (planted instructions for AI, hidden requirements) never reaches the review.
  const memo = new Map<Element, boolean>();
  const unseen = (el: Element): boolean => {
    let h = memo.get(el);
    if (h === undefined) memo.set(el, (h = !rendered(el) || stealthy(el, document.body) || clippedShut(el)));
    return h;
  };
  /** An element's text as shown: its text nodes whose element people can see. */
  const seenText = (el: Element): string => {
    let out = "";
    const walk = (n: Node) => {
      for (const k of n.childNodes) {
        if (k.nodeType === Node.TEXT_NODE) {
          if (k.parentElement && !unseen(k.parentElement)) out += k.textContent ?? "";
        } else if (k instanceof Element && !SKIP.has(k.tagName.toUpperCase())) walk(k);
      }
    };
    walk(el);
    return collapse(out);
  };
  /** A control nobody could see or reach: a choice box counts by its visible label (custom-styled ones hide it). */
  const unreachable = (el: HTMLElement): boolean => {
    if (el instanceof HTMLInputElement && /^(radio|checkbox|file)$/.test(el.type)) {
      const label = labelElementFor(el);
      const shown = label ? !unseen(label) && !honeypot(label) : rendered(el) && !honeypot(el);
      return !shown || (el.getAttribute("tabindex") === "-1" && !!el.closest('[aria-hidden="true"]'));
    }
    return !rendered(el) || honeypot(el);
  };
  const refs = new Map<string, HTMLElement>();
  const fieldRefs = new Map<string, string[]>();
  const unscanned: string[] = [];
  const lines: { text: string; control: boolean }[] = [];
  let line = "";
  let lineControl = false;
  let n = 0;
  const flush = () => {
    const t = collapse(line);
    if (t) lines.push({ text: t, control: lineControl });
    line = "";
    lineControl = false;
  };
  const shownFor = new Set<string>();

  const control = (el: HTMLElement, role: string, inChrome: boolean) => {
    const caption = () => (el instanceof HTMLInputElement ? ownText(el) : seenText(el) || ownText(el));
    const text = role === "button" || role === "link" || role === "clickable" ? caption() : "";
    if (inChrome && (role === "link" || role === "button") && !RE_CHROME_ACTION.test(text)) {
      line += ` ${text}`;
      return;
    }
    const ref = `c${++n}`;
    refs.set(ref, el);
    const field = deps.fieldOf(el);
    const parts = [ref, role];
    if (el instanceof HTMLInputElement && role === "textbox" && el.type !== "text") parts.push(`type=${el.type}`);
    if (text) parts.push(q(text));
    if (role === "radio" || role === "checkbox" || role === "option" || role === "switch") {
      const t = el instanceof HTMLInputElement ? "" : caption();
      if (t) parts.push(q(t));
    }
    parts.push(...stateOf(el));
    if (field) {
      parts.push(`field=${field}`);
      const list = fieldRefs.get(field) ?? [];
      list.push(ref);
      fieldRefs.set(field, list);
      // The field's value once, on its first control: a group's shows on its first choice.
      if (!shownFor.has(field)) {
        shownFor.add(field);
        const v = deps.shown(field);
        if (v && !/^(radio|checkbox)$/.test(role)) parts.push(`value=${q(v)}`);
        const unknown = deps.unknownState(field);
        if (unknown !== undefined) parts.push(`state=unknown${unknown ? ` (we picked ${q(unknown)})` : ""}`);
      }
    } else {
      const why = deps.excluded(el);
      if (why) parts.push(`excluded=${q(why)}`);
      else if (!/^(button|link|clickable|tab|menuitem)$/.test(role)) {
        parts.push("unscanned");
        unscanned.push(ref);
      }
      const v = valueOf(el, role);
      if (v) parts.push(`value=${q(v)}`);
      parts.push(...hintsOf(el));
    }
    if (el instanceof HTMLSelectElement) {
      const opts = [...el.options].map((o) => collapse(o.text)).filter(Boolean);
      if (!field) parts.push(`options=[${opts.slice(0, 40).map(q).join(", ")}${opts.length > 40 ? ", …" : ""}]`);
    }
    line += ` [${parts.join(" ")}]`;
    lineControl = true;
  };

  const visit = (el: Element, pointer: boolean, inChrome: boolean) => {
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || tag === HOST_TAG.toUpperCase() || !(el instanceof HTMLElement)) return;
    if (tag === "IFRAME") {
      if (rendered(el)) {
        flush();
        const src = (el as HTMLIFrameElement).src;
        const host = src ? new URL(src, location.href).host : "";
        line = `[frame ${q(el.title || el.getAttribute("name") || "")} ${host} — reviewed on its own]`;
        flush();
      }
      return;
    }
    if (!laidOut(el)) return;
    const block = isBlock(el, tag);
    if (block) flush();
    const chrome = inChrome || el.matches(CHROME);
    if (HEADING.test(tag) || el.getAttribute("role") === "heading") line += " #";
    const field = deps.fieldOf(el);
    const role = roleOf(el) ?? (field ? "control" : null);
    if (role) {
      // A field we scanned shows either way; anything else only if people could see and reach it (no honeypots).
      if (!field && unreachable(el)) return;
      control(el, role, chrome);
      // A group's choices and a list's options are controls of their own; anything else's text was its caption.
      if (role !== "radiogroup" && role !== "listbox") {
        if (block) flush();
        return;
      }
    } else if (clickable(el, pointer) && rendered(el) && !honeypot(el) && !unseen(el)) {
      control(el, "clickable", chrome);
      if (block) flush();
      return;
    }
    // An error message: not a wrapper that holds the field it is about ("has-error" form groups).
    if (el.matches(ALERT) && !el.querySelector("input,select,textarea,button,[role],[contenteditable]")) {
      const t = rendered(el) ? seenText(el) : "";
      if (t.length > 1 && t.length < 300) {
        flush();
        line = `! ${t}`;
        flush();
        return;
      }
    }
    const pointerHere = pointer || (!!el.parentElement && getComputedStyle(el).cursor === "pointer");
    const sr = shadowOf(el);
    // A host's light children render through its shadow root's slots: the root first, then them.
    for (const k of [...(sr ? sr.childNodes : []), ...el.childNodes]) {
      if (k.nodeType === Node.TEXT_NODE) {
        const t = k.textContent ?? "";
        if (!t.trim() || unseen(el)) continue;
        line += ` ${chrome ? clip(collapse(t), 80) : t}`;
      } else if (k instanceof Element) visit(k, pointerHere, chrome);
    }
    if (block) flush();
  };
  if (root) visit(root, false, false);
  flush();

  // Over budget: text far from any control goes first (a long description), then the end is cut.
  let out = lines.map((l) => l.text);
  let truncated = false;
  if (out.join("\n").length > maxChars) {
    truncated = true;
    const near = (i: number) => lines.slice(Math.max(0, i - 3), i + 4).some((l) => l.control);
    out = lines.map((l, i) => (l.control || near(i) || /^#/.test(l.text) ? l.text : clip(l.text, 80)));
    let text = out.join("\n");
    if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (page continues)`;
    return { text, refs, fieldRefs, unscanned: unscanned.filter((r) => text.includes(`[${r} `)), truncated };
  }
  return { text: out.join("\n"), refs, fieldRefs, unscanned, truncated };
}
