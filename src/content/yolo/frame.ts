// Where this frame is. YOLO's hidden host is an offscreen document: Chrome renders no frames there and wakes its
// timers once a second, like a background tab's, though the page reports itself visible.
const ao = location.ancestorOrigins;
// runtime?: undefined where this script landed without live extension bindings (main() then bails).
export const IN_HOST = !!ao?.length && ao[ao.length - 1] === `chrome-extension://${chrome.runtime?.id}`;
/** The host's own frame: it drives the application. Frames inside it fill only as part of its page. */
export const DRIVER_FRAME = IN_HOST && ao.length === 1;
/** Timers are throttled and no animation frames come: a hidden tab, or the YOLO host. */
export const throttled = () => document.hidden || IN_HOST;

/**
 * Where nothing renders, CSS transitions never finish: a menu fading in stays at opacity 0, invisible to the fill
 * (Workday's dropdowns). The run's page gets its styles' end states at once instead.
 */
export function endTransitions() {
  const s = document.createElement("style");
  s.textContent =
    "*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}";
  (document.head ?? document.documentElement).append(s);
  return () => s.remove();
}
