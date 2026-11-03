// "Edit with AI": a button beside the focused answer, and the box that asks what to change. The rewrite is shown here
// first; the field changes only on "Use this".
import { ellipsize } from "../../shared/normalize";
import { anchorTo, el, uiLayer } from "./root";

export interface AiEditorOptions {
  label: string;
  /** The field's answer now. */
  current: () => string;
  /** Rewrites `answer`; a string is the new text, `{ error }` what went wrong. */
  rewrite: (instruction: string, answer: string) => Promise<string | { error: string }>;
  stop: () => void;
  /** Puts the text in the field; returns what went wrong, if anything. */
  apply: (text: string) => Promise<string | null>;
  onClose: () => void;
}

let button: { el: HTMLElement; off: AbortController; release: (() => void) | null; target: Element } | null = null;
let card: HTMLElement | null = null;

/** Whether an event's path runs through this UI, so focusing it doesn't count as leaving the field. */
export const inAiEditor = (path: EventTarget[]) =>
  (!!card && path.includes(card)) || (!!button && path.includes(button.el));

export function hideEditButton() {
  if (!button) return;
  button.off.abort();
  button.release?.();
  button.el.remove();
  button = null;
}

export function showEditButton(target: Element, onClick: () => void) {
  if (card || button?.target === target) return;
  hideEditButton();
  const b = el("button", { className: "edit-ai", type: "button", textContent: "✦ Edit with AI" });
  b.onclick = () => {
    hideEditButton();
    onClick();
  };
  uiLayer().append(b);
  const off = new AbortController();
  const release = anchorTo(target, b);
  if (!release) {
    const follow = () => {
      const r = target.getBoundingClientRect();
      b.style.left = `${r.right - 4}px`;
      b.style.top = `${r.bottom + 4}px`;
    };
    follow();
    addEventListener("scroll", follow, { capture: true, passive: true, signal: off.signal });
    addEventListener("resize", follow, { passive: true, signal: off.signal });
  }
  button = { el: b, off, release, target };
}

export function closeAiEditor() {
  card?.remove();
  card = null;
}

export function openAiEditor(anchor: Element, o: AiEditorOptions) {
  closeAiEditor();
  const ask = el("textarea", {
    className: "ask",
    rows: 2,
    placeholder: "What should change? e.g. shorter, more about my embedded work",
  });
  ask.setAttribute("aria-label", "What should change");
  const result = el("textarea", { className: "result", rows: 7, hidden: true });
  result.setAttribute("aria-label", "Rewritten answer");
  const error = el("div", { className: "error", hidden: true });
  error.setAttribute("role", "alert");
  const use = el("button", { className: "btn primary", type: "button", textContent: "Use this", hidden: true });
  const go = el("button", { className: "btn primary", type: "button", textContent: "Rewrite" });
  const cancel = el("button", { className: "btn", type: "button", textContent: "Cancel" });
  const box = el(
    "div",
    { className: "aiedit" },
    el("div", { className: "status", textContent: "Edit with AI" }),
    el("div", { className: "qa", textContent: ellipsize(o.label, 110) }),
    ask,
    error,
    result,
    el("div", { className: "actions" }, use, go, cancel),
  );
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Edit with AI");
  // The page's own shortcuts and validators don't get what is typed here.
  for (const ev of ["keydown", "keyup", "keypress", "input", "change"])
    box.addEventListener(ev, (e) => e.stopPropagation());

  let busy = 0; // which request is running; 0 for none, so a stopped one's late answer is dropped
  const showError = (m: string) => {
    error.textContent = m;
    error.hidden = !m;
  };
  const close = () => {
    if (busy) o.stop();
    busy = 0;
    closeAiEditor();
    o.onClose();
  };
  const run = async () => {
    const instruction = ask.value.trim();
    if (busy) return;
    if (!instruction) return ask.focus();
    showError("");
    const mine = (busy = Date.now());
    go.disabled = use.disabled = true;
    go.textContent = "Rewriting…";
    // Asked again, it changes the last rewrite, as the user sees it, and not the field's text.
    const r = await o.rewrite(instruction, result.hidden ? o.current() : result.value);
    if (busy !== mine) return;
    busy = 0;
    go.disabled = use.disabled = false;
    if (typeof r !== "string") {
      go.textContent = "Rewrite";
      return showError(r.error);
    }
    result.value = r;
    result.hidden = use.hidden = false;
    go.textContent = "Try again";
    go.className = "btn";
    position();
  };
  go.onclick = () => void run();
  cancel.onclick = close;
  use.onclick = async () => {
    const text = result.value.trim();
    if (!text) return;
    use.disabled = true;
    const problem = await o.apply(text);
    use.disabled = false;
    if (problem) return showError(problem);
    close();
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "Enter" && !e.shiftKey && e.target === ask) {
      e.preventDefault();
      void run();
    }
  });

  uiLayer().append(box);
  card = box;
  // Fixed where it opened, so the page can be read beside it: right of the field, so its answer stays in view, else
  // below it. Clamped into the frame, however short.
  const position = () => {
    const a = anchor.getBoundingClientRect();
    const { width, height } = box.getBoundingClientRect();
    const beside = a.right + 8 + width + 8 <= innerWidth;
    box.style.left = `${beside ? a.right + 8 : Math.max(8, Math.min(a.left, innerWidth - width - 8))}px`;
    box.style.top = `${Math.max(8, Math.min(beside ? a.top : a.bottom + 6, innerHeight - height - 8))}px`;
  };
  position();
  ask.focus();
}
