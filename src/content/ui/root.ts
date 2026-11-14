// §16: one <autoapply-root> per frame, open shadow root, own stylesheet, all: initial on the host.
import css from "./styles.css?inline";
import { HOST_TAG } from "../scan/traverse";

const layers = new Map<boolean, HTMLElement>(); // keyed by `under`
let evicted = false;
const TAKEOVER = "autoapply:takeover";

/**
 * Reloading/updating the extension orphans the running content script (its DOM and listeners survive, its
 * runtime is dead) and onInstalled injects a fresh one beside it, in another isolated world. The newest
 * instance owns the frame: it tells older ones to stand down (DOM events cross worlds) and drops their UI.
 */
export function claimFrame(onEvicted: () => void) {
  document.dispatchEvent(new Event(TAKEOVER));
  // Orphans from builds without this handshake can't hear it, so remove their layer directly.
  document.querySelectorAll(HOST_TAG).forEach((h) => h.remove());
  document.addEventListener(
    TAKEOVER,
    () => {
      evicted = true;
      layers.forEach((l) => (l.getRootNode() as ShadowRoot).host.remove());
      onEvicted();
    },
    { once: true },
  );
}

/** `under`: a layer first in tree order at z-index 1, so page popups, menus and modals paint over it. */
export function uiLayer(under = false): HTMLElement {
  if (evicted) return document.createElement("div"); // orphaned: in-flight work renders nowhere
  const cached = layers.get(under);
  if (cached?.isConnected) return cached;
  const host = document.createElement(HOST_TAG);
  host.style.cssText = `all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: ${under ? 1 : 2147483646}; pointer-events: none;`;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css;
  const layer = document.createElement("div");
  layer.className = "aa";
  shadow.append(style, layer);
  if (under) document.documentElement.prepend(host);
  else document.documentElement.append(host);
  layers.set(under, layer);
  return layer;
}

const FRAME_CLICK = "autoapply:frame-click";

/** Child frames: tell the top frame's UI about real clicks, which never cross the iframe boundary. */
export const relayClicksToTop = (signal: AbortSignal) =>
  addEventListener("pointerdown", (e) => e.isTrusted && window.top?.postMessage(FRAME_CLICK, "*"), {
    capture: true,
    signal,
  });

/**
 * Calls `fn` on a real click outside `inside` (isTrusted skips the fill engine's synthetic events). Window capture
 * runs before any page listener can stop it; clicks inside iframes never reach this window, so child frames relay.
 */
export function onOutsideClick(inside: Element | Element[], fn: () => void, signal?: AbortSignal) {
  const within = [inside].flat();
  addEventListener(
    "pointerdown",
    (e) => e.isTrusted && !e.composedPath().some((n) => within.includes(n as Element)) && fn(),
    {
      capture: true,
      signal,
    },
  );
  addEventListener("message", (e) => e.data === FRAME_CLICK && fn(), { signal });
}

const RUN = Math.random().toString(36).slice(2, 8); // keeps names unique beside an orphaned instance's leftovers
let anchors = 0;
/**
 * Ties `els` (already in a uiLayer) to `target` with CSS anchor positioning, so the compositor moves them in the
 * same frame the page scrolls; JS repositioning on scroll events always lands a frame or more behind. Anchor names
 * are tree-scoped: a position-anchor declared in our shadow tree can't see a name set on a page element, so it is
 * declared by a ::part() rule in the document tree instead. Names inside page shadow trees can't be reached from
 * outside at all, so those anchor to their document-tree host when it is the control itself (anchorable). Returns
 * null when nothing can be anchored (and without browser support), else the release function.
 */
export function anchorTo(target: Element, ...els: HTMLElement[]): (() => void) | null {
  if (evicted) return () => {};
  const anchor = anchorable(target);
  if (!(anchor instanceof HTMLElement) || anchor.getRootNode() !== document || !CSS.supports("anchor-name", "--a"))
    return null;
  const part = `${HOST_TAG}-${RUN}-${anchors++}`;
  const own = getComputedStyle(anchor).getPropertyValue("anchor-name"); // keep the page's own anchors working
  anchor.style.setProperty("anchor-name", own === "none" ? `--${part}` : `${own}, --${part}`);
  for (const e of els) e.part.add(part);
  // In our host's light DOM: a document-tree stylesheet that leaves with the host.
  const rule = el("style", { textContent: `${HOST_TAG}::part(${part}) { position-anchor: --${part}; }` });
  (els[0].getRootNode() as ShadowRoot).host.append(rule);
  return () => {
    rule.remove();
    const rest = anchor.style
      .getPropertyValue("anchor-name")
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n && n !== `--${part}`);
    if (rest.length) anchor.style.setProperty("anchor-name", rest.join(", "));
    else anchor.style.removeProperty("anchor-name");
  };
}

/**
 * Shows `card` (already in a uiLayer) below `anchor`, clamped to the viewport, keeping that offset as the page
 * scrolls: in CSS when the anchor can be CSS-anchored (returns the release), else re-applied on scroll until `signal`.
 */
export function pinBelow(anchor: Element, card: HTMLElement, signal: AbortSignal, room = 120): (() => void) | null {
  const r = anchor.getBoundingClientRect();
  const dx = Math.max(8, Math.min(r.left, innerWidth - 316)) - r.left;
  const dy = Math.min(r.bottom + 6, innerHeight - room) - r.top;
  const release = anchorTo(anchor, card);
  if (release) {
    card.style.left = `calc(anchor(left) + ${dx}px)`;
    card.style.top = `calc(anchor(top) + ${dy}px)`;
    return release;
  }
  const follow = () => {
    const a = anchor.getBoundingClientRect();
    card.style.left = `${a.left + dx}px`;
    card.style.top = `${a.top + dy}px`;
  };
  follow();
  addEventListener("scroll", follow, { capture: true, passive: true, signal });
  addEventListener("resize", follow, { passive: true, signal });
  return null;
}

/**
 * `target`, or for one inside page shadow trees its outermost host, if that host is the control's own box (SuccessFactors'
 * ui5-date-picker: input plus calendar icon) rather than a container of other fields (a form rendered in one shadow
 * root), which would outline the wrong thing.
 */
export function anchorable(target: Element): Element | null {
  let host = target;
  for (let root = target.getRootNode(); root instanceof ShadowRoot; root = host.getRootNode()) host = root.host;
  if (host === target) return target;
  const a = target.getBoundingClientRect();
  const b = host.getBoundingClientRect();
  return b.width <= a.width * 1.5 && b.height <= a.height * 1.5 ? host : null;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}
