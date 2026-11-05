// Accounts on the employer's site (Workday needs one per company): sign in with stored credentials, else create
// them, then pass email verification with a link or code from the YOLO inbox.
import { RE_CONSENT, RE_OPTIONAL_CONSENT } from "../../shared/constants";
import { isErr, send } from "../../shared/messages";
import { setNativeValue, sleep, typeText, waitFor } from "../fill/events";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { codeInput, visiblePasswords } from "./classify";
import { findButton, press } from "./nav";

const RE_SIGNIN_BTN = /^(sign ?in|log ?in|continue|next|submit)$/i;
const RE_SIGNUP_BTN = /^(create (an |a |my |your )?(new )?account|sign ?up|register|continue|next|submit)$/i;
// Avature (National Bank): "Don't have a profile yet? … Create profile".
const RE_TO_SIGNUP =
  /^(create (an |a |my |your )?(new )?(account|profile)|sign ?up|register|new user\??|don'?t have an account\?.*)$/i;
const RE_TO_SIGNIN = /^(sign ?in|log ?in|already have an account\?.*)$/i;
const RE_FORGOT = /forgot (your )?password|reset (your )?password/i;
const RE_VERIFY_BTN =
  /^(verify|confirm|continue|next|submit|sign ?in|send( (me )?(a |the )?(reset )?(link|email|code))?|reset( (my |your )?password)?)$/i;

/** The account a site's applications share: a Workday tenant's, else the site's own. */
export function siteKey(): string {
  const h = location.hostname.toLowerCase();
  return /\.myworkday(jobs|site)\.com$/.test(h) ? `workday:${h.split(".")[0]}` : h.replace(/^www\./, "");
}

const emailInputs = () =>
  deepQueryAll("input").filter(
    (i) =>
      isVisible(i) &&
      ((i as HTMLInputElement).type === "email" ||
        /e-?mail|user ?name|login/i.test(
          `${i.id} ${(i as HTMLInputElement).name} ${i.getAttribute("aria-label") ?? ""} ${i.getAttribute("data-automation-id") ?? ""} ${(i as HTMLInputElement).placeholder}`,
        )),
  ) as HTMLInputElement[];

async function type(el: HTMLInputElement, value: string) {
  el.focus();
  setNativeValue(el, "");
  await typeText(el, value, 0);
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

async function fillCredentials(email: string, password: string) {
  for (const e of emailInputs()) await type(e, email);
  for (const p of visiblePasswords()) await type(p, password);
}

/** The account form's required agreements ("I agree to the terms"), never its marketing opt-ins. */
function tickConsents() {
  for (const c of deepQueryAll("input[type=checkbox]") as HTMLInputElement[]) {
    const label = c.labels?.[0]?.innerText ?? c.closest("label")?.innerText ?? c.getAttribute("aria-label") ?? "";
    const shown = isVisible(c) || isVisible(c.closest("label") ?? c);
    if (!c.checked && shown && (c.required || RE_CONSENT.test(label)) && !RE_OPTIONAL_CONSENT.test(label)) c.click();
  }
}

const RE_NOTICE = /\b(acknowledge|privacy (notice|policy|statement)|data privacy|terms (of use|and conditions))\b/i;
// Westinghouse's SuccessFactors notice: "Acknowledge · Decline · Print".
const RE_ACCEPT_BTN = /^(i )?(accept|agree|acknowledge)( (and|&) continue)?$/i;
const accepted = new WeakSet<Element>();

/**
 * A required notice the page opens in a dialog to accept, with no box to tick: SuccessFactors' sign-up refused to go
 * on until "Acknowledge that you have read the Applicant Privacy Notice" was opened and accepted.
 */
export async function acceptNotices() {
  for (const opener of deepQueryAll('[aria-haspopup="dialog"]') as HTMLElement[]) {
    const label = `${opener.getAttribute("aria-label") ?? ""} ${opener.innerText}`;
    if (accepted.has(opener) || !isVisible(opener) || !RE_NOTICE.test(label) || RE_OPTIONAL_CONSENT.test(label))
      continue;
    accepted.add(opener);
    press(opener);
    // A press while the dialog still opens can miss (Westinghouse's stayed open): again until it goes.
    for (let k = 0; k < 3; k++) {
      const accept = await waitFor(() => findButton(RE_ACCEPT_BTN), 3000);
      if (!accept) break;
      await sleep(300);
      press(accept);
      if (await waitFor(() => !accept.isConnected || !isVisible(accept), 1500)) break;
    }
    await sleep(300);
  }
}

export type AuthOutcome = { ok: true } | { fail: string };

/** One sign-in, sign-up or password-reset page. The next page tells the driver how it went. */
export async function handleAuth(
  kind: "signin" | "signup" | "reset",
  fillRest: () => Promise<unknown>,
): Promise<AuthOutcome> {
  const site = siteKey();
  const stored = await send({ type: "YOLO_CREDENTIAL", site, create: false });
  if (kind === "signin") {
    if (!stored) {
      const toSignup = findButton(RE_TO_SIGNUP, ['[data-automation-id="createAccountLink"]']);
      if (toSignup) {
        press(toSignup);
        return { ok: true };
      }
      // A first-time applicant's résumé upload beside the login (EA's Avature): no account needed.
      const guest = (deepQueryAll("input[type=file]") as HTMLInputElement[]).some(
        (f) => !f.closest("form")?.querySelector("input[type=password]"),
      );
      if (!guest) return { fail: "Needs an account it can't create" };
      await fillRest();
      const go = findButton(/^(continue|next)$/i);
      if (!go) return { fail: "Couldn't upload a résumé as a first-time applicant" };
      press(go);
      return { ok: true };
    }
    await fillCredentials(stored.email, stored.password);
    const b = findButton(RE_SIGNIN_BTN, ['[data-automation-id="signInSubmitButton"]']);
    if (!b) return { fail: "No sign-in button" };
    press(b);
    return { ok: true };
  }
  // An account we made before: sign in rather than sign up again.
  if (kind === "signup" && stored) {
    const toSignin = findButton(RE_TO_SIGNIN, ['[data-automation-id="signInLink"]']);
    if (toSignin) {
      press(toSignin);
      return { ok: true };
    }
  }
  const creds = await send({ type: "YOLO_CREDENTIAL", site, create: true });
  if (!creds) return { fail: "Couldn't store a password" };
  await fillCredentials(creds.email, creds.password);
  await fillRest(); // name, country and the like on longer sign-up forms
  tickConsents();
  await acceptNotices();
  await sleep(300);
  const b = findSignup();
  if (!b) return { fail: "No create-account button" };
  press(b);
  return { ok: true };
}

/** A sign-in that opens on a choice of providers (Workday's "Sign in with Apple / Google / email"): email shows the form. */
export const emailSignIn = () =>
  findButton(/^(sign ?in|log ?in|sign ?up|continue|register) with (your )?e-?mail( address)?$/i, [
    '[data-automation-id="SignInWithEmailButton"]',
  ]);

/** A login asked for inside the application form itself (iCIMS' Candidate Profile): set it; the rest is a form. */
/** A sign-up form's create-account button. */
export const findSignup = () => findButton(RE_SIGNUP_BTN, ['[data-automation-id="createAccountSubmitButton"]']);

export async function setLogin(): Promise<AuthOutcome> {
  const creds = await send({ type: "YOLO_CREDENTIAL", site: siteKey(), create: true });
  if (!creds) return { fail: "Couldn't store a password" };
  await fillCredentials(creds.email, creds.password);
  return { ok: true };
}

/** "This email is already registered" with no password stored: reset it through the inbox. */
export async function forgotPassword(): Promise<AuthOutcome> {
  const link = findButton(RE_FORGOT, ['[data-automation-id="forgotPasswordLink"]']);
  if (!link) return { fail: "Account exists; no password reset" };
  press(link);
  return { ok: true };
}

/** A "check your inbox" page: follows the emailed link, or types the emailed code. */
export async function handleVerify(since: number, email: string): Promise<AuthOutcome> {
  const input = codeInput();
  // "Forgot password" asks for the address first.
  const ask = emailInputs().find((e) => !e.value);
  if (ask && !input) {
    await type(ask, email);
    const b = findButton(RE_VERIFY_BTN);
    if (!b) return { fail: "No button to send the reset email" };
    press(b);
    return { ok: true };
  }
  const r = await send({ type: "YOLO_WAIT_EMAIL", since, want: input ? "code" : "link" });
  if (isErr(r)) return { fail: r.error.message };
  if (r.link) {
    location.href = r.link;
    return { ok: true };
  }
  if (!input || !r.code) return { fail: "No verification code" };
  await type(input, r.code);
  const b = findButton(RE_VERIFY_BTN);
  if (b) press(b);
  return { ok: true };
}
