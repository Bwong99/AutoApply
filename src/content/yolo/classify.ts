// What a YOLO run's page shows, for the background to tell what kind of step it is (background/yolo/classify.ts).
import type { PageFacts } from "../../shared/messages";
import { collapse } from "../../shared/normalize";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { alertText, applyInfo, findApply, findNext, findSubmit } from "./nav";

/** ATS forms embedded in a company page: the run loads them on their own. Query text is never a frame's origin. */
function isEmbeddedFormUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    return (
      ((host === "greenhouse.io" || host.endsWith(".greenhouse.io")) &&
        (host === "boards.greenhouse.io" || /^\/embed(?:\/|$)/i.test(u.pathname))) ||
      host === "jobs.lever.co" ||
      host === "jobs.eu.lever.co" ||
      host === "jobs.ashbyhq.com" ||
      host.endsWith(".myworkdayjobs.com") ||
      /^(jobs|careers)\.smartrecruiters\.com$/.test(host) ||
      host === "icims.com" ||
      host.endsWith(".icims.com") ||
      host === "workable.com" ||
      host.endsWith(".workable.com")
    );
  } catch {
    return false;
  }
}

/** A job alert or talent community signup beside a posting, by its section's heading: not the application. */
export const RE_SIGNUP_BOX = /talent (community|network|pool)|job alerts?|newsletter|stay (connected|in touch)/i;

export const pageText = () => (document.body?.innerText ?? "").slice(0, 20000);

export function visiblePasswords(): HTMLInputElement[] {
  return deepQueryAll("input[type=password]").filter(isVisible) as HTMLInputElement[];
}

export function codeInput(): HTMLInputElement | null {
  return (
    (deepQueryAll("input").find(
      (i) =>
        isVisible(i) &&
        ((i as HTMLInputElement).autocomplete === "one-time-code" ||
          /code|otp|pin|token|verif/i.test(
            `${i.id} ${(i as HTMLInputElement).name} ${i.getAttribute("aria-label") ?? ""} ${(i as HTMLInputElement).placeholder}`,
          )),
    ) as HTMLInputElement | undefined) ?? null
  );
}

/** A challenge someone must solve: a visible image/checkbox frame, never the invisible score badge or one solved. */
function challenge(): HTMLIFrameElement | undefined {
  // A solved widget stays on the page; its response token says it's done.
  const tokens = deepQueryAll(
    '[name="g-recaptcha-response"],[name="h-captcha-response"],[name="cf-turnstile-response"]',
  );
  if (tokens.some((t) => (t as HTMLTextAreaElement).value)) return undefined;
  return (deepQueryAll("iframe") as HTMLIFrameElement[]).find((f) => {
    const shown =
      /recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com.*frame=challenge|challenges\.cloudflare\.com|captcha-delivery\.com\/captcha(?:\/|[?#]|$)/.test(
        f.src,
      ) ||
      (/recaptcha\/(api2|enterprise)\/anchor|hcaptcha\.com.*frame=checkbox/.test(f.src) &&
        !/size=invisible/.test(f.src));
    const r = f.getBoundingClientRect();
    // hCaptcha shows its challenge in a page-sized "enclave" frame (Lever's submit); otherwise that frame is tiny.
    const enclave = /hcaptcha\.com/.test(f.src) && r.width > 300 && r.height > 300;
    return (shown || enclave) && r.width > 100 && r.height > 60 && isVisible(f);
  });
}
export const captchaShown = () => !!challenge();

/** A score check is loaded, shown or not: an ATS sends its grade with the application and may file a low one as spam. */
export const scoreCheck = () =>
  deepQueryAll(
    'script[src*="/recaptcha/"],iframe[src*="/recaptcha/"],script[src*="hcaptcha.com"],iframe[src*="hcaptcha.com"],script[src*="challenges.cloudflare.com/turnstile"],iframe[src*="challenges.cloudflare.com"]',
  ).length > 0;

export function embeddedForm(): string | null {
  const f = deepQueryAll("iframe").find((f) => {
    const r = f.getBoundingClientRect();
    return isEmbeddedFormUrl((f as HTMLIFrameElement).src) && r.width > 300 && r.height > 200;
  }) as HTMLIFrameElement | undefined;
  return f?.src ?? null;
}

const headings = () =>
  collapse(
    deepQueryAll("h1,h2,h3,[role=heading],[data-automation-id=progressBarActiveStep]")
      .filter(isVisible)
      .map((h) => h.innerText)
      .join(" | "),
  ).slice(0, 300);

/** `fields`: how many fields the fill scan sees on the page. */
export function pageFacts({ fields, requiredFields }: Pick<PageFacts, "fields" | "requiredFields">): PageFacts {
  const apply = findApply();
  const applyDetails = applyInfo(apply);
  return {
    text: pageText().slice(0, 4000),
    title: document.title,
    path: location.pathname,
    headings: headings(),
    alerts: alertText().slice(0, 600),
    fields,
    passwords: visiblePasswords().length,
    codeInput: !!codeInput(),
    captcha: captchaShown(),
    scored: scoreCheck(),
    embedded: !!embeddedForm(),
    apply: applyDetails.kind !== "none",
    applyKind: applyDetails.kind,
    applyInForm: applyDetails.inForm,
    requiredFields,
    onward: !!(findNext() || findSubmit()),
  };
}
