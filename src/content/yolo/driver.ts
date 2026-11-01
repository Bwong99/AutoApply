// YOLO's driver: runs in the page a YOLO run loaded and takes it from posting to confirmation, one step at a time
// (Apply → account → each form page → Submit). A step that loads a new document ends this script there; the new
// page's driver asks the background where the run stands and carries on.
import { CAPTCHA_SELF_CLEAR_MS, CAPTCHA_WAIT_MS } from "../../shared/constants";
import { send, type StepKind, type YoloResult } from "../../shared/messages";
import { collapse } from "../../shared/normalize";
import type { Guess } from "../../shared/yolo";
import { sleep, waitFor } from "../fill/events";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { emailSignIn, forgotPassword, handleAuth, handleVerify, setLogin } from "./auth";
import { captchaShown, embeddedForm, pageFacts, pageText } from "./classify";
import { alertText, findApply, findNext, findSubmit, labelOf, press, validationErrors } from "./nav";

export interface FillReport {
  /** Required fields still empty after filling, by label. */
  unfilled: string[];
  /** Why this application can't go on (a required ID number, no résumé). */
  fatal?: string;
  /** The AI's quota or usage limit ran out; retry after this time. */
  retryAt?: number;
}

export interface DriverDeps {
  /** Field facts from the fill scan, including how many actually require an answer. */
  fieldStats(): { fields: number; requiredFields: number };
  /** Fills the page in YOLO mode, again for fields left over. */
  fill(): Promise<FillReport>;
  /** Fields inside these validation messages' containers are filled again on the next pass. */
  refill(errors: HTMLElement[]): void;
  guesses(): Guess[];
  /** The address the run applies with. */
  email(): string;
  /** Every field shown on the page and its answer, blank or not, keyed by document and field. */
  answers(): Record<string, Guess>;
  /** Debug logging is on: each page's answers go to the background's log of the run. */
  debug: boolean;
  /** Shares the posting's description and pay before the run leaves its page, for later pages' answers. */
  posting(): Promise<void>;
  /** The same for a posting the run went past, read from its address. */
  readPosting(url: string): Promise<void>;
}

/** A test build (VITE_YOLO_DRY=1) stops before the final submit and reports what it filled; others compile it out. */
const DRY = import.meta.env.VITE_YOLO_DRY === "1";

const RE_EASY_APPLY = /easily apply|easy apply|indeed apply|apply with (indeed|linkedin|glassdoor)/i;
/** The page's own timers run unthrottled while this is set (pageTimers.ts): a run waits on them between steps. */
const busy = (on: boolean) => document.dispatchEvent(new Event(on ? "autoapply-fill-start" : "autoapply-fill-end"));

/** Loaded, then no DOM change for 800 ms (or 8 s at most): single-page apps render their next step after load. */
async function settle(maxMs = 8000) {
  await waitFor(() => document.readyState === "complete", 15_000);
  let last = performance.now();
  const mo = new MutationObserver(() => (last = performance.now()));
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  for (const t0 = performance.now(); performance.now() - last < 800 && performance.now() - t0 < maxMs;)
    await sleep(200);
  mo.disconnect();
}

/** What a click should change: the address, the step's heading, or the set of fields. */
const snapshot = () => `${location.href}|${pageText().slice(0, 400)}|${deepQueryAll("input,select,textarea").length}`;

async function changed(before: string, ms: number): Promise<boolean> {
  return !!(await waitFor(() => snapshot() !== before || validationErrors().length > 0 || captchaShown(), ms));
}

function scrapeLinks() {
  const card = (a: HTMLElement) => {
    let n: HTMLElement | null = a;
    for (let i = 0; i < 6 && n; i++, n = n.parentElement)
      if ((n.innerText ?? "").length > 60) return n.innerText.slice(0, 600);
    return a.innerText;
  };
  return (deepQueryAll("a[href]") as HTMLAnchorElement[])
    .filter((a) => /^https?:/.test(a.href) && isVisible(a))
    .slice(0, 800)
    .map((a) => ({ href: a.href, text: collapse(a.innerText || a.textContent || ""), card: card(a) }));
}

let driving = false;

export async function drive(deps: DriverDeps) {
  if (driving) return;
  driving = true;
  const hello = await send({ type: "YOLO_HELLO", url: location.href }).catch(() => null);
  if (!hello) return void (driving = false);
  const result = (r: YoloResult) => void send({ type: "YOLO_RESULT", result: r }).catch(() => undefined);
  // The fill pipeline marks its own end; the run is still working after it.
  const fill = () => deps.fill().finally(() => busy(true));
  busy(true);
  try {
    if (hello.mode === "scrape") {
      await settle();
      await sleep(1500); // result lists often render after the page goes quiet
      return result({ status: "scraped", links: scrapeLinks() });
    }
    if (hello.posting) await deps.readPosting(hello.posting);
    let refills = 0;
    for (let i = 0; i < 30; i++) {
      await settle();
      const facts = pageFacts(deps.fieldStats());
      const step = await send({
        type: "YOLO_STEP",
        facts,
        url: location.href,
        guesses: deps.guesses(),
      });
      let kind: StepKind = step.kind;
      if (step.stop)
        return result({
          status: /already/i.test(step.stop) ? "skipped" : step.needs ? "needs" : "failed",
          // What the page says about it ("Verify your email first") is the likely why.
          reason: [step.stop, alertText().slice(0, 200)].filter(Boolean).join(": "),
          guesses: deps.guesses(),
        });
      const before = snapshot();
      const needs = (reason: string) => result({ status: "needs", reason, guesses: deps.guesses() });
      // A sign-in that opens on a choice of providers, before any field shows (Workday's, again after signing up).
      const viaEmail = !facts.passwords && facts.fields < 3 ? emailSignIn() : null;
      if (viaEmail) {
        press(viaEmail);
        await changed(before, 20_000);
        continue;
      }
      // A login inside the application form (iCIMS' Candidate Profile: résumé, contact details and a password): set
      // it, then fill and submit the page as a form step, with its checks and refills.
      if (kind === "signup" && facts.requiredFields > 3) {
        const r = await setLogin();
        if ("fail" in r) return needs(r.fail);
        kind = "form";
      }
      switch (kind) {
        case "success":
          return result({ status: "submitted", doneUrl: location.href, guesses: deps.guesses() });
        case "captcha":
          // Never solved by us. In a visible tab the user solves it and the run goes on. In a background tab, a check
          // that passes by itself (Cloudflare's "Verifying…") gets a moment first.
          if (!hello.visible) {
            if (await waitFor(() => !captchaShown(), CAPTCHA_SELF_CLEAR_MS)) continue;
            return needs("CAPTCHA");
          }
          // Everything else first, so the user only has the challenge left to do.
          if (facts.fields) await fill();
          await waitFor(() => !captchaShown(), CAPTCHA_WAIT_MS);
          continue;
        case "blocked":
          return result({ status: "blocked", reason: "The site's bot check stopped it" });
        case "closed":
          return result({ status: "skipped", reason: "Posting is closed" });
        case "flagged":
          location.reload(); // the step loop guard ends it after a few tries
          return;
        case "embedded":
          await deps.posting();
          location.href = embeddedForm()!;
          return;
        case "verify": {
          const r = await handleVerify(Date.now() - 15 * 60_000, deps.email());
          if ("fail" in r) return needs(r.fail);
          break;
        }
        case "signin":
        case "signup":
        case "reset": {
          // Refused before: the address has an account we hold no password for, so reset it by email.
          const r = step.refused ? await forgotPassword() : await handleAuth(kind, fill);
          if ("fail" in r) return needs(r.fail);
          break;
        }
        case "job": {
          const b = findApply()!;
          // A job board's own "Apply now" is its Easy Apply; only "Apply on company site" leads to the employer.
          const board = /(^|\.)(indeed|glassdoor|linkedin|ziprecruiter)\./.test(location.hostname);
          if (RE_EASY_APPLY.test(b.innerText) || (board && !/company|employer/i.test(labelOf(b))))
            return result({ status: "skipped", reason: "Easy Apply only (not supported yet)" });
          await deps.posting();
          press(b);
          break;
        }
        case "form": {
          const rep = await fill();
          // Now: a Submit that loads the confirmation page would take this page's guesses with it.
          await send({
            type: "YOLO_ANSWERS",
            answers: deps.debug ? deps.answers() : {},
            guesses: deps.guesses(),
          }).catch(() => undefined);
          if (rep.retryAt) return result({ status: "failed", reason: "AI usage limit reached", retryAt: rep.retryAt });
          if (rep.fatal) return needs(rep.fatal);
          if (rep.unfilled.length) return needs(`Couldn't fill: ${rep.unfilled.slice(0, 3).join(", ")}`);
          const next = findNext();
          const b = next ?? findSubmit();
          if (!b) return result({ status: "failed", reason: "No Next or Submit button", guesses: deps.guesses() });
          if (DRY && (!next || /submit/i.test(labelOf(b))))
            return needs(
              `Dry run before "${labelOf(b)}":\n${Object.values(deps.answers())
                .map((g) => `${g.q} = ${g.a}`)
                .join("\n")}`,
            );
          // Invisible CAPTCHAs score the page as it submits: it gets its own built-ins back first (pageTimers.ts).
          if (!next) busy(false);
          press(b);
          if (!(await changed(before, 20_000))) continue;
          const errors = validationErrors();
          if (errors.length) {
            if (refills++ >= 2) return needs(`Form rejected: ${collapse(errors[0].innerText).slice(0, 80)}`);
            deps.refill(errors);
          }
          continue;
        }
        default:
          // Still rendering (Oracle's next section takes several seconds), or a page we don't know: give up only once
          // it stops changing.
          if (await changed(before, 15_000)) continue;
          // Workday's "Something went wrong. Please refresh the page and then try again." (the step loop guard caps it)
          if (/\b(refresh|reload) the page\b/i.test(pageText())) {
            location.reload();
            return;
          }
          return result({ status: "failed", reason: "Unrecognized page", guesses: deps.guesses() });
      }
      await changed(before, 20_000);
    }
    return result({ status: "failed", reason: "Too many steps", guesses: deps.guesses() });
  } catch (e) {
    return result({ status: "failed", reason: (e as Error)?.message ?? String(e), guesses: deps.guesses() });
  } finally {
    busy(false);
    driving = false;
  }
}
