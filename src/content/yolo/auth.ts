// Accounts on the employer's site (Workday needs one per company): sign in with stored credentials, else create
// them, then pass email verification with a link or code from the YOLO inbox.
import { RE_CONSENT, RE_OPTIONAL_CONSENT } from "../../shared/constants";
import { isErr, send } from "../../shared/messages";
import { setNativeValue, sleep, typeText } from "../fill/events";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { codeInput, visiblePasswords } from "./classify";
import { findButton, press } from "./nav";

const RE_SIGNIN_BTN = /^(sign ?in|log ?in|continue|next|submit)$/i;
const RE_SIGNUP_BTN = /^(create (an |my )?account|sign ?up|register|continue|next|submit)$/i;
const RE_TO_SIGNUP = /^(create (an |my )?account|sign ?up|register|new user\??|don'?t have an account\?.*)$/i;
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
      if (!toSignup) return { fail: "Needs an account it can't create" };
      press(toSignup);
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
  await sleep(300);
  const b = findButton(RE_SIGNUP_BTN, ['[data-automation-id="createAccountSubmitButton"]']);
  if (!b) return { fail: "No create-account button" };
  press(b);
  return { ok: true };
}

/** A sign-in that opens on a choice of providers (Workday's "Sign in with Apple / Google / email"): email shows the form. */
export const emailSignIn = () =>
  findButton(/^(sign ?in|log ?in|sign ?up|continue|register) with (your )?e-?mail( address)?$/i, [
    '[data-automation-id="SignInWithEmailButton"]',
  ]);

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
