// YOLO's navigation: finding and pressing Apply / Next / Submit, the clicks a normal fill never makes.
import { RE_SKIP_LABEL } from "../../shared/constants";
import { defang, trapLabel } from "../../shared/injection";
import { collapse } from "../../shared/normalize";
import { honeypot } from "../review/snapshot";
import { pointerClick } from "../fill/events";
import { HOST_TAG, deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";

/** A job page's way into its application: "Apply for this job online" (iCIMS), "Apply to this job →". */
const APPLY_OPENING = String.raw`apply( now| today| here| online| manually| (for|to) (this |the )?(job|position|role|opportunity|opening|internship|posting|vacancy)( online| now)?)|i'?m interested|start (my |your )?application|apply on (the )?(company|employer)('s)? (site|website)`;
export const RE_APPLY = new RegExp(`^(apply|${APPLY_OPENING})(\\s*[→›»])?$`, "i");
/** Unlike a bare "Apply", these labels belong to a job detail page rather than a final form submission. */
export const RE_APPLY_OPENING = new RegExp(`^(${APPLY_OPENING})(\\s*[→›»])?$`, "i");
export type ApplyKind = "none" | "link" | "entry" | "submit";
export const RE_NEXT =
  /^(next( step| page)?|continue( to (the )?(next step|review|application))?|save (and|&) (continue|next)|proceed|review( (and|&) submit| (my |your )?application)?|go to review|i accept|i agree|(accept|agree) and continue|submit profile)(\s*[→›»])?$/i;
export const RE_SUBMIT =
  /^(submit( (my |your |the )?application)?|send( (my )?application)?|apply|complete( (my )?application)?|finish|submit and finish|confirm (and|&) submit)$/i;
/** Other ways in (third-party profiles, résumé parsers), and buttons that go back or out. */
const RE_AVOID =
  /linkedin|indeed|seek\b|google|facebook|apple|microsoft|github|autofill|use my last|parse|easy apply|quick apply|cancel|\bback\b|previous|save (for later|as draft|draft)|withdraw|sign out|log ?out/i;

/** Workday's controls by their stable ids: one handler covers every Workday tenant. */
const WORKDAY = {
  apply: ['[data-automation-id="applyManually"]', '[data-automation-id="adventureButton"]'],
  next: ['[data-automation-id="pageFooterNextButton"]', '[data-automation-id="bottom-navigation-next-button"]'],
};

const CLICKABLE = "button,input[type=submit],input[type=button],a[href],[role=button],[role=link]";

export const labelOf = (el: HTMLElement): string => {
  const own =
    (el instanceof HTMLInputElement ? el.value : el.innerText || el.textContent) || el.getAttribute("aria-label");
  // A custom element's inner button shows its host's slotted text (SmartRecruiters' <spl-button>Next</spl-button>).
  const host = (el.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
  return collapse(own ?? "") || collapse(host ? host.innerText || host.textContent || "" : "");
};

/**
 * Distinguishes a real job-page entrance from a final form action. A relative or absolute anchor can only navigate;
 * native submits must stay in the form path so validation/refills and YOLO dry runs still work, unless worded as an
 * entrance: a page-wide form (ASP.NET's) makes a posting's "Apply to this job" a submit. The step's required fields
 * still tell a form apart (background/yolo/classify.ts).
 */
export function applyInfo(el: HTMLElement | null): { kind: ApplyKind; inForm: boolean } {
  if (!el) return { kind: "none", inForm: false };
  const inForm = !!el.closest("form");
  const a = el.closest("a[href]") as HTMLAnchorElement | null;
  const href = a?.getAttribute("href")?.trim() ?? "";
  if (href && !/^(#|javascript:|mailto:|tel:)/i.test(href)) return { kind: "link", inForm };

  const control = el.closest("button,input") as HTMLButtonElement | HTMLInputElement | null;
  const nativeSubmit =
    control instanceof HTMLInputElement
      ? control.type === "submit" || control.type === "image"
      : !!control && control.type === "submit" && !!control.closest("form");
  const label = labelOf(el);
  if (nativeSubmit) return { kind: RE_APPLY_OPENING.test(label) ? "entry" : "submit", inForm };

  // A custom button outside a form is commonly a job-detail entry point. A generic Apply in a form is a submit.
  if (RE_APPLY_OPENING.test(label) || (RE_APPLY.test(label) && !inForm)) return { kind: "entry", inForm };
  return { kind: "submit", inForm };
}

const usable = (el: HTMLElement) =>
  isVisible(el) &&
  !el.closest(HOST_TAG) &&
  !(el as HTMLButtonElement).disabled &&
  el.getAttribute("aria-disabled") !== "true";

/** The visible, enabled control matching `re` that sits lowest on the page (a form's own buttons come last). */
export function findButton(re: RegExp, workday: string[] = []): HTMLElement | null {
  for (const sel of workday) {
    const w = deepQueryAll(sel).find(usable);
    if (w) return w;
  }
  const matches = deepQueryAll(CLICKABLE).filter((el) => {
    const t = labelOf(el);
    return t.length < 60 && re.test(t) && !RE_AVOID.test(t) && usable(el);
  });
  return matches.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom).pop() ?? null;
}

/**
 * A posting's Apply that is no control at all: a div, or a link without an href, with a click handler (React's
 * listen at the root). Only entrance wordings, on something that shows as clickable; the innermost such element.
 */
function looseApply(): HTMLElement | null {
  const matches = deepQueryAll("div,span,li,a:not([href])").filter((el) => {
    if (el.childElementCount > 3 || el.closest(HOST_TAG)) return false;
    const t = collapse(el.textContent ?? "");
    return (
      t.length < 60 &&
      RE_APPLY_OPENING.test(t) &&
      (el.matches("a,[onclick],[tabindex]") || getComputedStyle(el).cursor === "pointer") &&
      usable(el)
    );
  });
  return matches.find((el) => !matches.some((m) => m !== el && el.contains(m))) ?? null;
}

export const findApply = () => findButton(RE_APPLY, WORKDAY.apply) ?? looseApply();
export const findNext = () => findButton(RE_NEXT, WORKDAY.next);
export const findSubmit = () => findButton(RE_SUBMIT);

/**
 * Presses a control the way a pointer would: at its center, on what is topmost there (Workday lays a click-catching
 * overlay over its buttons). A link opening a new window loads in this frame instead.
 */
export function press(el: HTMLElement) {
  const a = el.closest("a[href]") as HTMLAnchorElement | null;
  if (a && a.target === "_blank" && /^https?:/.test(a.href)) {
    location.href = a.href;
    return;
  }
  el.scrollIntoView({ block: "center" });
  const r = el.getBoundingClientRect();
  const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const top = document.elementFromPoint(at.x, at.y) as HTMLElement | null;
  pointerClick(top && (el.contains(top) || el.parentElement?.contains(top)) ? top : el, at);
}

const ALERTS =
  '[role=alert],[aria-live=assertive],[data-automation-id*="error" i],[class*="error" i]:not(input):not(textarea):not(select)';

/** Visible messages the page shows about the last step (errors, banners), as one text. */
export const alertText = () =>
  deepQueryAll(ALERTS)
    .filter(isVisible)
    .map(labelOf)
    .filter((t) => t.length > 2 && t.length < 300)
    .join(" | ");

/** Visible validation messages: the page refused a step. */
export function validationErrors(): HTMLElement[] {
  return deepQueryAll(`[aria-invalid="true"],${ALERTS}`).filter((el) => {
    if (!usable(el)) return false;
    if (el.getAttribute("aria-invalid") === "true") return true;
    const t = labelOf(el);
    return t.length > 2 && t.length < 300 && /required|invalid|error|must|please|enter|select|missing|problem/i.test(t);
  });
}

/** What the navigator may never press: other sites' sign-ins and Easy Apply, parsers, ways back or out. */
const RE_NAV_AVOID =
  /\b(withdraw|delete|remove|sign ?out|log ?out|cancel|unsubscribe|back|previous)\b|save (for later|as (a )?draft|draft)|\b(sign|log) ?(in|up)? with\b|\b(apply|continue|connect) with\b|easy apply|quick apply|autofill|auto-fill|use my last|job alert/i;
/**
 * What the navigator names, pressed only if a person could: on the page, seen (not a honeypot button hidden for bots),
 * and not worded for bots or AI ("Automated applicants click here"), another site's sign-in or a way out.
 */
/** A control worded for bots or AI ("Automated applicants click here", "AI agents: apply"), not "Apply for AI Engineer". */
export const RE_FOR_BOTS =
  /\b(?:ai|a\.i\.|llms?|bots?|robots?|crawlers?|scrapers?)(?:\s+(?:agents?|tools?|assistants?|models?|applicants?))?\s*[:—–]|\b(?:automated|ai|bot|robot)\s+(?:applicants?|agents?|submissions?|applications?)\b|\bfor\s+(?:ai|bots?|robots?|machines?|automated\s+\w+)(?:\s+(?:agents?|tools?|only|use))?\s*(?:[.!:)]|$)|\bnot for humans\b|\bhumans?\s+(?:should(?:n'?t| not)|must not|do not|don'?t)\b/i;

export function pressable(el: HTMLElement | undefined): el is HTMLElement {
  if (!el?.isConnected || el.closest(HOST_TAG) || !isVisible(el) || honeypot(el)) return false;
  const label = labelOf(el);
  return (
    !RE_NAV_AVOID.test(label) &&
    !RE_SKIP_LABEL.test(label) &&
    !RE_FOR_BOTS.test(label) &&
    !trapLabel(label) &&
    defang(label) === label
  );
}
