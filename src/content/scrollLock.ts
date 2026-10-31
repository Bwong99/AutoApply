// Runs in the page's own (MAIN) world. Our synthetic events make page widgets call focus()/scrollIntoView()/
// scrollTo() themselves, which jerks the viewport around; while a fill runs, those calls must not scroll.
// The user's own wheel/keyboard/scrollbar scrolling never goes through these APIs, so it is untouched.
// The isolated-world content script toggles the lock with DOM events (they cross worlds). The page's functions are
// replaced only while locked: bot checks (CAPTCHAs) take a patched built-in for a sign of automation.
type Fn = (this: unknown, ...args: unknown[]) => unknown;
const noop = () => () => undefined;
const patches: [object, string, (orig: Fn) => Fn][] = [
  [
    HTMLElement.prototype,
    "focus",
    (orig) =>
      function (this: unknown, opts?: unknown) {
        orig.call(this, { ...(opts as FocusOptions), preventScroll: true });
      },
  ],
  [Element.prototype, "scrollIntoView", noop],
  [Element.prototype, "scrollIntoViewIfNeeded", noop],
  [window, "scroll", noop],
  [window, "scrollTo", noop],
  [window, "scrollBy", noop],
];

let undo: (() => void)[] = [];
document.addEventListener("autoapply-scroll-lock", () => {
  if (undo.length) return;
  for (const [target, name, wrap] of patches) {
    const t = target as Record<string, unknown>;
    const orig = t[name];
    if (typeof orig !== "function") continue;
    const patched = wrap(orig as Fn);
    t[name] = patched;
    undo.push(() => t[name] === patched && (t[name] = orig)); // unless the page replaced it meanwhile
  }
});
document.addEventListener("autoapply-scroll-unlock", () => {
  for (const u of undo) u();
  undo = [];
});

export {};
