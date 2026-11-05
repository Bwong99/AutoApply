// YOLO's real input (background/yolo/realInput.ts): on a page a bot check grades, in a tab, the run's clicks and typed
// answers go through Chrome's debugger, so the check sees a person's (trusted) events. Everything else, and every
// failure, stays with script input.
import { send, type RealOp } from "../../shared/messages";
import type { Yolo } from "../../shared/yolo";
import { IN_HOST } from "./frame";

let mode: Yolo["realInput"] = "off";
let graded = false;

/** The run's setting, from the background's hello ("off" where it can't apply). */
export const setRealMode = (m: Yolo["realInput"]) => void (mode = m);
/** Each step: whether a bot check grades this page. The points sent are the top frame's, so only it takes part. */
export const setGraded = (on: boolean) => void (graded = on && !IN_HOST && window.top === window);
export const realFor = (k: "clicks" | "typing") => mode !== "off" && graded && (mode === k || mode === "both");

const real = (op: RealOp) =>
  send({ type: "REAL_INPUT", op }).then(
    (r) => r.ok,
    () => false,
  );

const center = (r: DOMRect, spread = 0.4) => ({
  x: r.left + r.width * (0.5 + (Math.random() - 0.5) * spread),
  y: r.top + r.height * (0.5 + (Math.random() - 0.5) * spread),
});

/**
 * Passes over a few of the fields in view, as a person checking their answers does, then clicks `el` for real.
 * False when it didn't (a link opening a new window, which would show a tab, or no real input): press it as before.
 */
export async function realPress(el: HTMLElement): Promise<boolean> {
  if (el.closest("a[target=_blank]")) return false;
  el.scrollIntoView({ block: "center" });
  const seen = [...document.querySelectorAll("input,textarea,select")]
    .map((f) => f.getBoundingClientRect())
    .filter((r) => r.width > 4 && r.height > 4 && r.top >= 0 && r.bottom <= innerHeight)
    .sort(() => Math.random() - 0.5)
    .slice(0, 3);
  for (const r of seen) if (!(await real({ kind: "move", ...center(r) }))) return false;
  // A real click lands on whatever is on top there (a cookie banner over the button): then the script press, which
  // reaches the button itself, goes instead.
  const at = center(el.getBoundingClientRect());
  const top = document.elementFromPoint(at.x, at.y);
  if (!top || !(el.contains(top) || top.contains(el))) return false;
  return real({ kind: "click", ...at });
}

/** Types `text` over the focused box's content for real. False when it didn't: fill it by script. */
export function realType(el: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<boolean> | false {
  if (!text) return false;
  el.select(); // typing replaces what the box holds
  return real({ kind: "type", text });
}
