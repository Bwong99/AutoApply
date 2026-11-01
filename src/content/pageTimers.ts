// Runs in the page's own (MAIN) world. In a hidden tab Chrome wakes the page's timers at most once a second, so a
// widget's search debounce or next-page loader would stall a fill the user left running in the background. While a
// fill runs there, short timers are also fired by the content script's unthrottled sleep (fill/events.ts); the
// page's own timer stays as the fallback. Outside a fill, or in a visible tab, nothing changes.
// YOLO's hidden host (an offscreen document's frame) throttles timers the same way while reporting itself visible.
// The page's own functions are replaced only while a fill runs (in the host, from the start: its pages need them as
// they load): bot checks (CAPTCHAs) take a patched built-in for a sign of automation.
const ao = location.ancestorOrigins;
const inHost = !!ao?.length && ao[ao.length - 1].startsWith("chrome-extension://");
let filling = false;
const w = window as unknown as Record<string, unknown>;
/** name → [our replacement, the page's own] */
const swaps: [string, unknown, unknown][] = [];
const patch = (name: string, fn: unknown) => swaps.push([name, fn, w[name]]);
const swap = (on: boolean) => {
  for (const [name, patched, orig] of swaps)
    if (on) w[name] = patched;
    else if (w[name] === patched) w[name] = orig; // unless the page replaced it meanwhile
};
document.addEventListener("autoapply-fill-start", () => {
  filling = true;
  swap(true);
});
document.addEventListener("autoapply-fill-end", () => {
  filling = false;
  if (!inHost) swap(false);
});

const pending = new Map<string, () => void>();
const set = window.setTimeout;
const clear = window.clearTimeout;

patch("setTimeout", function (handler: TimerHandler, ms = 0, ...args: unknown[]) {
  if (!filling || !(document.hidden || inHost) || typeof handler !== "function" || ms >= 1000)
    return set(handler, ms, ...args);
  const run = () => {
    pending.delete(key);
    clear(id); // whichever fires first cancels the other
    (handler as (...a: unknown[]) => void)(...args);
  };
  const id = set(run, ms);
  const key = String(id);
  pending.set(key, run);
  document.dispatchEvent(new CustomEvent("autoapply-timer", { detail: `${key}:${ms}` }));
  return id;
});

patch("clearTimeout", (id?: number) => {
  pending.delete(String(id));
  clear(id);
});

document.addEventListener("autoapply-timer-fire", (e) => pending.get((e as CustomEvent<string>).detail)?.());

// Ashby saves each answer as its own request and keeps only the last of overlapping ones: a fill waits for the ones
// in flight (fill/engine.ts), counted here where the page's own fetch runs.
if (/(^|\.)ashbyhq\.com$/.test(location.hostname)) {
  const f = window.fetch;
  let n = 0;
  const mark = () => document.documentElement?.setAttribute("data-autoapply-net", String(n));
  patch("fetch", function (this: unknown, ...a: Parameters<typeof fetch>) {
    n++;
    mark();
    return f.apply(this, a).finally(() => {
      n--;
      mark();
    });
  });
}
if (inHost) swap(true);

// The host renders no frames, so Chrome never has idle time to give: a page hydrating from an idle callback (Remix:
// Greenhouse's job boards) would never get its event handlers, and every dropdown stays dead. Run them on a timer.
// Animation frames never come either, and resize and intersection observers, which report from the rendering steps,
// never call back: a virtualized list (Workday's "How did you hear about us?") keeps two rows in a 1 px box forever.
// Stand-ins: a timer for frames, and observers that measure when observing starts and after the DOM changes.
if (inHost) {
  window.requestIdleCallback = ((cb: IdleRequestCallback) =>
    window.setTimeout(
      () => cb({ didTimeout: false, timeRemaining: () => 50 }),
      1,
    )) as typeof window.requestIdleCallback;
  window.cancelIdleCallback = (id: number) => window.clearTimeout(id);
  window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
  window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);

  type Watch = { el: Element; last: string; key: (r: DOMRect) => string; report: (r: DOMRect) => void };
  const watches = new Set<Watch>();
  let checking = false;
  const check = () => {
    if (checking) return;
    checking = true;
    window.setTimeout(() => {
      checking = false;
      for (const w of watches) {
        const r = w.el.getBoundingClientRect();
        const k = w.key(r);
        if (k !== w.last) {
          w.last = k;
          w.report(r);
        }
      }
    }, 30);
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true });
  addEventListener("scroll", check, true);

  /** One stand-in observer: its targets' watches, reported to `cb` when `key` of their box changes. */
  const observer = (key: Watch["key"], entry: (el: Element, r: DOMRect) => object) =>
    class {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      private mine = new Map<Element, Watch>();
      constructor(private cb: (entries: object[], o: unknown) => void) {}
      observe(el: Element) {
        if (this.mine.has(el)) return;
        const w: Watch = { el, last: "", key, report: (r) => this.cb([entry(el, r)], this) };
        this.mine.set(el, w);
        watches.add(w);
        check();
      }
      unobserve(el: Element) {
        const w = this.mine.get(el);
        if (w) watches.delete(w);
        this.mine.delete(el);
      }
      disconnect() {
        for (const w of this.mine.values()) watches.delete(w);
        this.mine.clear();
      }
      takeRecords() {
        return [];
      }
    };
  const shown = (r: DOMRect) => {
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return w > 0 && h > 0 ? (w * h) / (r.width * r.height || 1) : 0;
  };
  window.ResizeObserver = observer(
    (r) => `${r.width}x${r.height}`,
    (target, r) => {
      const size = [{ inlineSize: r.width, blockSize: r.height }];
      return { target, contentRect: r, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size };
    },
  ) as unknown as typeof ResizeObserver;
  window.IntersectionObserver = observer(
    (r) => String(shown(r) > 0),
    (target, r) => {
      const ratio = shown(r);
      const rootBounds = new DOMRect(0, 0, innerWidth, innerHeight);
      return {
        target,
        time: performance.now(),
        boundingClientRect: r,
        rootBounds,
        intersectionRect: r,
        isIntersecting: ratio > 0,
        intersectionRatio: ratio,
      };
    },
  ) as unknown as typeof IntersectionObserver;
}

// Greenhouse's embed script reads the page's address from window.top, the extension's page in the host: reading it
// throws, so a company page embedding a Greenhouse form (MongoDB's) never shows it. Give it the frame's own address,
// the top it would be in a tab.
if (inHost) {
  const own = (h: unknown) => {
    if (h && typeof h === "object") (h as { currentLocation: () => Location }).currentLocation = () => location;
  };
  let gh: unknown;
  Object.defineProperty(window, "Grnhse", {
    configurable: true,
    get: () => gh,
    set(v: unknown) {
      gh = v;
      if (!v || typeof v !== "object" || Object.getOwnPropertyDescriptor(v, "UriHelper")?.get) return;
      let helper = (v as { UriHelper?: unknown }).UriHelper;
      own(helper);
      Object.defineProperty(v, "UriHelper", {
        configurable: true,
        enumerable: true,
        get: () => helper,
        set(h: unknown) {
          helper = h;
          own(h);
        },
      });
    },
  });
}

// Anti-clickjacking (OWASP's, on SuccessFactors career sites) hides the body unless the page is the top window, which
// it never is in the host: the run saw a blank page. Its style goes once the page is parsed.
if (inHost)
  document.addEventListener("DOMContentLoaded", () => document.querySelector("style#antiClickjack")?.remove());

// In the hidden host, a page's popup (an "Apply" that opens the ATS in a new window) would be a visible tab: it
// loads in the same frame instead. The frame's name (src/offscreen/host.ts) tells it from other extensions' frames.
if (inHost && ao.length === 1 && window.name === "autoapply-yolo")
  window.open = ((url?: string | URL) => {
    if (url) location.href = String(url);
    return window;
  }) as typeof window.open;

export {};
