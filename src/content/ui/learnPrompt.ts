// §16.3 "Save this answer for future applications?" card. One at a time, auto-dismiss after 12 s or on outside click.
import { ellipsize } from "../../shared/normalize";
import { el, onOutsideClick, pinBelow, uiLayer } from "./root";

let current: {
  card: HTMLElement;
  timer: ReturnType<typeof setTimeout>;
  listeners: AbortController;
  release: (() => void) | null;
} | null = null;

export function hideLearnPrompt() {
  if (!current) return;
  clearTimeout(current.timer);
  current.listeners.abort();
  current.release?.();
  current.card.remove();
  current = null;
}

export function showLearnPrompt(anchor: Element, label: string, answer: string, onSave: () => void, title?: string) {
  hideLearnPrompt();
  const save = el("button", { className: "btn primary", type: "button", textContent: "Save" });
  const later = el("button", { className: "btn", type: "button", textContent: "Not now" });
  const card = el(
    "div",
    { className: "learn" },
    el("div", { className: "status", textContent: title ?? "Save this answer for future applications?" }),
    el("div", { className: "qa", textContent: `"${ellipsize(label, 110)}" → "${ellipsize(answer, 120)}"` }),
    el("div", { className: "actions" }, save, later),
  );
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Save answer");
  uiLayer().append(card);
  const listeners = new AbortController();
  const { signal } = listeners;
  const release = pinBelow(anchor, card, signal);
  save.onclick = () => {
    onSave();
    hideLearnPrompt();
  };
  later.onclick = hideLearnPrompt;
  current = { card, timer: setTimeout(hideLearnPrompt, 12000), listeners, release };
  onOutsideClick(card, hideLearnPrompt, signal);
}
