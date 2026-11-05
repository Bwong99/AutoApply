// §11.3 visibility rules.

export function isVisible(el: Element): boolean {
  if (!el.getClientRects().length) return false;
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.visibility === "collapse" || cs.display === "none") return false;
  let opacity = 1;
  for (let n: Element | null = el; n && opacity > 0.05; n = parentOf(n)) {
    if (n.getAttribute("aria-hidden") === "true") return false;
    opacity *= Number(getComputedStyle(n).opacity || 1);
  }
  if (opacity <= 0.05) return false;
  const r = el.getBoundingClientRect();
  return !(r.right + scrollX < -1000 || r.bottom + scrollY < -1000);
}

/**
 * A box that passes isVisible yet no one could see or type in: (nearly) zero-size, left of or above the page, or
 * clipped away by an overflow-hidden ancestor. Bot traps (honeypots) hide their inputs this way.
 */
export function concealed(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 1 || r.height <= 1 || r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return true;
  const hides = (o: string) => o === "hidden" || o === "clip";
  for (let n = parentOf(el); n; n = parentOf(n)) {
    const cs = getComputedStyle(n);
    const x = hides(cs.overflowX);
    const y = hides(cs.overflowY);
    if (!x && !y) continue;
    const p = n.getBoundingClientRect();
    if (x && Math.min(r.right, p.right) - Math.max(r.left, p.left) <= 1) return true;
    if (y && Math.min(r.bottom, p.bottom) - Math.max(r.top, p.top) <= 1) return true;
  }
  return false;
}

/**
 * Clipped to nothing: inside a box of 1 px or less that hides its overflow (the screen-reader-only pattern), or cut by
 * `clip: rect(0…)` / `clip-path: inset(50%)`. A scroll box or a collapsed "Show more" (bigger than that) doesn't count.
 */
export function clippedShut(el: Element): boolean {
  for (let n: Element | null = el; n && n !== document.body; n = parentOf(n)) {
    const cs = getComputedStyle(n);
    if (/^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(cs.clip) || /inset\(\s*50%|circle\(\s*0/.test(cs.clipPath))
      return true;
    const hides = (o: string) => o === "hidden" || o === "clip";
    const x = hides(cs.overflowX || cs.overflow);
    const y = hides(cs.overflowY || cs.overflow);
    if (!x && !y) continue;
    const r = n.getBoundingClientRect();
    if ((x && r.width <= 1) || (y && r.height <= 1)) return true;
  }
  return false;
}

/**
 * Unmistakably out of sight: 1 px or less, left of or above the page, or clipped shut. Unlike concealed(), never a box
 * a bigger one merely scrolls or clips out of view (a scroll container's lower rows, a carousel's next step), which can
 * be a real question; so this alone marks a required box as a honeypot.
 */
export function outOfSight(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width <= 1 || r.height <= 1 || r.right + scrollX <= 0 || r.bottom + scrollY <= 0 || clippedShut(el);
}

/** Parent element, crossing shadow-root boundaries. */
export function parentOf(n: Element): Element | null {
  if (n.parentElement) return n.parentElement;
  const root = n.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** `a` contains `n`, crossing shadow-root boundaries. */
export function composedContains(a: Element, n: Element): boolean {
  for (let x: Element | null = n; x; x = parentOf(x)) if (x === a) return true;
  return false;
}
