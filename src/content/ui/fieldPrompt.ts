// Fill this field: a card by the field the user right-clicked (or focused before pressing the shortcut), with an
// optional instruction and Generate. It stays open after a fill, so the answer can be refined with another instruction.
import { ellipsize } from "../../shared/normalize";
import { el, onOutsideClick, pinBelow, uiLayer } from "./root";

let current: { card: HTMLElement; listeners: AbortController; release: (() => void) | null } | null = null;

export function hideFieldPrompt() {
  if (!current) return;
  current.listeners.abort();
  current.release?.();
  current.card.remove();
  current = null;
}

/**
 * `generate` fills the field with the instruction typed (empty: the autofill's own answer) and resolves to what
 * happened. Without it the card only shows `message`: there was no field AutoApply can fill.
 */
export function showFieldPrompt(
  anchor: Element,
  label: string,
  generate?: (instruction: string) => Promise<string>,
  message = "",
) {
  hideFieldPrompt();
  const close = el("button", { className: "icon", type: "button", textContent: "×", title: "Close" });
  close.setAttribute("aria-label", "Close");
  close.onclick = hideFieldPrompt;
  const status = el("div", { className: "qa", textContent: message });
  status.setAttribute("aria-live", "polite");
  const card = el(
    "div",
    { className: "learn ask" },
    el("div", { className: "row" }, el("div", { className: "status", textContent: "Fill with AutoApply" }), close),
    ...(label ? [el("div", { className: "qa", textContent: `"${ellipsize(label, 110)}"` })] : []),
  );
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Fill with AutoApply");
  let input: HTMLTextAreaElement | undefined;
  if (generate) {
    const box = el("textarea", {
      rows: 2,
      placeholder: 'Optional: how to answer ("shorter", "mention my internship")',
    });
    box.setAttribute("aria-label", "How to answer (optional)");
    const go = el("button", { className: "btn primary", type: "button", textContent: "Generate" });
    const run = async () => {
      if (go.disabled) return;
      go.disabled = true;
      status.textContent = "Generating…";
      try {
        status.textContent = await generate(box.value.trim());
      } catch (e) {
        status.textContent = (e as Error)?.message || "Something went wrong";
      } finally {
        go.disabled = false;
      }
      box.select(); // the next instruction replaces this one
    };
    go.onclick = () => void run();
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void run();
      }
    });
    card.append(box, status, el("div", { className: "actions" }, go));
    input = box;
  } else card.append(status);
  // Keys typed here are ours: the page's shortcuts (and its own Escape handling) never see them.
  for (const ev of ["keydown", "keyup", "keypress"])
    card.addEventListener(ev, (e) => {
      e.stopPropagation();
      if (e.type === "keydown" && (e as KeyboardEvent).key === "Escape") hideFieldPrompt();
    });
  uiLayer().append(card);
  const listeners = new AbortController();
  const { signal } = listeners;
  const release = pinBelow(anchor, card, signal, card.offsetHeight + 10);
  current = { card, listeners, release };
  // Clicking into the field to read the answer keeps the card, for the next instruction.
  onOutsideClick([card, anchor], hideFieldPrompt, signal);
  (input ?? close).focus({ preventScroll: true });
}
