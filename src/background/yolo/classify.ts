// What kind of step a YOLO run's page is, from the facts its driver reads off it (content/yolo/classify.ts). The
// wording tests live here, out of the content script every page loads.
import { RE_APPLIED } from "../../shared/constants";
import type { PageFacts, StepKind } from "../../shared/messages";
import { collapse } from "../../shared/normalize";

const RE_BLOCKED =
  /just a moment|verify(ing)? (that )?you are (a )?human|access denied|attention required|unusual traffic|are you a robot|request unsuccessful|you have been blocked/i;
const RE_CLOSED =
  /no longer (accepting|available|open|active)|(job|position|posting|role|requisition|opening) (has been |is )?(closed|filled|expired|removed|unavailable)|(page|job) (you('re| are) looking for )?(can'?t|cannot|could not) be found|(page|job) you('re| are) looking for (doesn'?t|does not|no longer) exists?|\b(page|job) not found\b|this job has expired/i;
const RE_VERIFY =
  /verify your (email|account|identity)|(verification|confirmation|security) (code|email|link)|check your (email|inbox)|we('ve| have)? (just )?sent (you )?(an? )?(email|code|link)|enter the (\d+[- ]digit )?code|one[- ]time (pass)?code/i;
const RE_FORGOT = /forgot (your )?password|reset (your )?password/i;
/** A submission held until the emailed link opens ("Verify your email to complete your application"), not a mere notice. */
const RE_CONFIRM_FIRST =
  /\b(verify|confirm|activate) your (e-?mail|account|application|submission)( address)?\b[^.!\n]{0,40}\b(to|before|in order to) (complete|finish|submit|send|process)|\bto (complete|finish|submit) your (application|submission)\b[^.!\n]{0,40}\b(verify|confirm|click|follow|open)\b|\b(application|submission) (is|will) not (be )?(complete|submitted|sent|considered|processed|reviewed) until|\bwon'?t be (submitted|sent|considered|processed|reviewed) until/i;
/** The emailed link or code didn't take. */
const RE_VERIFY_FAILED =
  /\b(not|n't|unable to|failed to) (be |been )?(verified|confirmed|activated)|expired|invalid|no longer valid|already (been )?used|went wrong/i;
const RE_RESET = /(reset|new|change|create) (your )?password/i;
const RE_SIGNUP = /create (an |your )?account|sign ?up|register|new (user|candidate)/i;
const RE_SIGNUP_PATH = /(^|[/_-])(create[-_]?account|sign[-_]?up|register|registration)([/_.-]|$)/i;
/** "Report suspicious activity here" in a careers site's fraud banner (AMD) is not a flag on us. */
const RE_FLAGGED =
  /flagged as (possible )?spam|(detected|due to|because of) (some )?(unusual or )?suspicious activity|recaptcha (verification )?failed/i;
/** The site turned down our sign-up or sign-in: the address has an account whose password we don't hold. */
const RE_REFUSED =
  /already (exists|registered|in use|have an account)|account (with|for) this email|email (address )?is (already )?(taken|registered)|incorrect|invalid (email|password|credentials|username|login)|wrong (email|password|credentials)|account (might|may) be locked|not recognized/i;

/**
 * `hidden`: the run is in the hidden frame, where bot checks fail but a tab often passes them, or never shows them:
 * the frame is a cross-site one (the site's own cookies set by script are dropped, and Cloudflare's checks can't run)
 * in a document with no window or screen. Its bot checks are "blocked", for the tab retry. So is a step the run would
 * send while an invisible score check grades it: the frame's low score can file the application as spam unseen.
 */
export function kindOf(f: PageFacts, hidden: boolean): StepKind {
  const kind = stepKind(f, hidden);
  return hidden && f.scored && /^(job|form|signin|signup|reset)$/.test(kind) ? "blocked" : kind;
}

function stepKind(f: PageFacts, hidden: boolean): StepKind {
  if (f.captcha) return hidden ? "blocked" : "captcha";
  if (confirmFirst(f)) return "verify";
  if (
    f.fields < 3 &&
    (RE_APPLIED.test(f.text) || /\/(thanks|thank-you|confirmation|success|submitted)\b/i.test(f.path))
  )
    return "success";
  if (f.text.length < 2000 && (RE_BLOCKED.test(f.text) || RE_BLOCKED.test(f.title))) return "blocked";
  if (f.fields < 2 && RE_CLOSED.test(f.text)) return "closed";
  if (!f.fields && !f.onward && RE_FLAGGED.test(f.text)) return hidden ? "blocked" : "flagged";
  // Only a page the run can't get past otherwise: a code box, a "check your inbox" page with little else, or Workday's
  // sign-in turning an unverified account away with an alert over its form. A form merely mentioning email is a form.
  if ((RE_VERIFY.test(f.text) && (f.codeInput || (!f.passwords && f.fields < 3))) || RE_VERIFY.test(f.alerts))
    return "verify";
  if (!f.passwords && RE_FORGOT.test(f.headings)) return "verify";
  if (f.passwords >= 2) return RE_RESET.test(f.headings) ? "reset" : "signup";
  // TikTok's /create-account is headed "Sign in" like its login: the address says which it is.
  if (f.passwords === 1)
    return (RE_SIGNUP.test(f.headings) && !/sign ?in|log ?in/i.test(f.headings)) || RE_SIGNUP_PATH.test(f.path)
      ? "signup"
      : "signin";
  // An email-first sign-in (Eightfold's "Email · Continue · First time here? Create an account"): no password yet.
  // Its address box and a heading that is only "Sign in": Workday's step "Create Account/Sign In" heads its sign-up too,
  // which reads as no fields while it renders.
  if (
    !f.passwords &&
    f.fields === 1 &&
    /(^|\|)\s*(sign ?in|log ?in)\s*(\||$)/i.test(f.headings) &&
    RE_SIGNUP.test(f.text)
  )
    return "signin";
  // Not a page asking questions of its own (iCIMS's "Enter Your Information" email step beside an iframe): loading
  // the frame instead looped back to the posting.
  if (f.fields < 3 && !f.requiredFields && f.embedded) return "embedded";
  // A posting with a search box or two (Indeed's What / Where) is still a posting. More page chrome can produce
  // several scan-visible controls, so a real navigation link always opens the posting's application. A custom
  // entry CTA can do the same when there are no required application fields; native submits remain form steps so
  // validation/refills and the dry-run stop still apply.
  if (
    f.applyKind === "link" ||
    (f.applyKind === "entry" && !f.requiredFields && (f.fields < 3 || (!f.applyInForm && !f.onward)))
  )
    return "job";
  // A review step has nothing to fill, only the way on.
  if (f.fields > 0 || f.onward) return "form";
  return "unknown";
}

export const refused = (f: PageFacts) => RE_REFUSED.test(f.alerts);

/** A confirmation page that holds the application until its emailed link opens. */
export const confirmFirst = (f: PageFacts) => f.fields < 3 && !f.onward && RE_CONFIRM_FIRST.test(f.text);

/** The page after an emailed link or code says it didn't work (expired, already used). */
export const verifyFailed = (f: PageFacts) => RE_VERIFY_FAILED.test(f.text);

/** What tells one step from the next, for loop detection. */
export const signature = (kind: StepKind, f: PageFacts) => `${kind}|${f.path}|${f.headings}|${f.fields}`;

/** What a confirmation page says ("Thank you for applying…"): the lines from RE_APPLIED's match, else its headings. */
export function confirmation(f: PageFacts): string {
  const lines = f.text.split("\n").map(collapse).filter(Boolean);
  const i = lines.findIndex((l) => RE_APPLIED.test(l));
  return (i < 0 ? f.headings : lines.slice(i, i + 3).join(" ")).slice(0, 400);
}
