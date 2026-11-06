// YOLO's driver: runs in the page a YOLO run loaded and takes it from posting to confirmation, one step at a time
// (Apply → account → each form page → Submit). A step that loads a new document ends this script there; the new
// page's driver asks the background where the run stands and carries on.
import { CAPTCHA_SELF_CLEAR_MS, CAPTCHA_WAIT_MS } from "../../shared/constants";
import { send, type PageFacts, type StepKind, type YoloResult } from "../../shared/messages";
import type { NavReply } from "../../background/gemini/schemas";
import { collapse } from "../../shared/normalize";
import type { Guess } from "../../shared/yolo";
import { sleep, waitFor } from "../fill/events";
import { deepQueryAll } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { acceptNotices, emailSignIn, findSignup, forgotPassword, handleAuth, handleVerify, setLogin } from "./auth";
import { botWall, captchaShown, embeddedForm, pageFacts, pageText, scoreCheck } from "./classify";
import { IN_HOST } from "./frame";
import { realFor, realPress, setGraded, setRealMode } from "./real";
import {
  alertText,
  findApply,
  findButton,
  findNext,
  findSubmit,
  labelOf,
  press,
  pressable,
  RE_APPLY,
  RE_NEXT,
  RE_SUBMIT,
  validationErrors,
} from "./nav";

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
  hasGuessedAnswers?(): boolean;
  handoff?(): void;
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
  /** The AI navigator's next step on this page (background/services/navigate.ts), with the control it names. */
  navigate(why: string, facts: PageFacts): Promise<{ reply: NavReply; el?: HTMLElement } | null>;
}

/** Navigator calls per page load: it is the way out of a stuck step, not a loop of its own. */
const MAX_NAV = 6;

/** A test build (VITE_YOLO_DRY=1) stops before the final submit and reports what it filled; others compile it out. */
const DRY = import.meta.env.VITE_YOLO_DRY === "1";

const RE_UPLOAD_WAY = /^(from (device|(my )?computer)|upload (a |your )?(cv|resume|résumé)( file)?)$/i;
const RE_EASY_APPLY = /easily apply|easy apply|indeed apply|apply with (indeed|linkedin|glassdoor)/i;
/** The page's own timers run unthrottled while this is set (pageTimers.ts): a run waits on them between steps. */
const busy = (on: boolean) => document.dispatchEvent(new Event(on ? "autoapply-fill-start" : "autoapply-fill-end"));

/**
 * Holds a final Submit until the page has been open about as long as a person filling it would take: 3 s a field,
 * 20–90 s. A plain timer: nothing runs meanwhile, and it keeps no service worker awake.
 */
async function dwell(fields: number) {
  const ms = Math.min(90_000, Math.max(20_000, fields * 3000)) - performance.now();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

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

/**
 * The result card around a link: its nearest ancestor with text beyond the link's own. A long title is never its own
 * card, which lost company and location for Indeed titles past 60 characters (live, 2026-11-04).
 */
export function cardText(a: HTMLElement): string {
  const min = Math.max(60, (a.innerText ?? "").length + 20);
  let n: HTMLElement | null = a;
  for (let i = 0; i < 6 && n; i++, n = n.parentElement)
    if ((n.innerText ?? "").length > min) return n.innerText.slice(0, 600);
  return a.innerText;
}

function scrapeLinks() {
  return (deepQueryAll("a[href]") as HTMLAnchorElement[])
    .filter((a) => /^https?:/.test(a.href) && isVisible(a))
    .slice(0, 800)
    .map((a) => ({ href: a.href, text: collapse(a.innerText || a.textContent || ""), card: cardText(a) }));
}

let driving = false;
/**
 * Set once the page starts to unload: a press whose page posts on before leaving (SuccessFactors' Apply) changes the
 * page first, and pressing again meanwhile read as a stuck step. The next page's run goes on.
 */
let leaving = false;
addEventListener("beforeunload", () => (leaving = true));

export async function drive(deps: DriverDeps) {
  if (driving) return;
  driving = true;
  const hello = await send({ type: "YOLO_HELLO", url: location.href }).catch(() => null);
  if (!hello) return void (driving = false);
  setRealMode(hello.realInput);
  const result = (r: YoloResult) =>
    void send({ type: "YOLO_RESULT", result: r, runId: hello.runId }).catch(() => undefined);
  // The fill pipeline marks its own end; the run is still working after it.
  const fill = () => deps.fill().finally(() => busy(true));
  /** Every protected final action must receive explicit permission from the current run. */
  const beforeSubmit = async (ambiguous = false): Promise<boolean> => {
    if (!hello.submissionReview) return true;
    const permission = await send({
      type: "YOLO_BEFORE_SUBMIT",
      runId: hello.runId,
      ambiguous,
      hasGuessedAnswers: deps.hasGuessedAnswers?.() ?? false,
      guesses: deps.guesses(),
    }).catch(() => null);
    if (permission?.action === "submit") return true;
    busy(false);
    setRealMode("off");
    deps.handoff?.();
    if (permission?.action !== "held")
      result({ status: "needs", reason: "Submission permission could not be verified; nothing was submitted." });
    return false;
  };
  const dryStop = (label: string) =>
    result({
      status: "needs",
      reason: `Dry run before "${label}":\n${Object.values(deps.answers())
        .map((g) => `${g.q} = ${g.a}`)
        .join("\n")}`,
      guesses: deps.guesses(),
    });
  let navCalls = 0;
  /**
   * When the wording rules are stuck, the navigator reads the page and names the next step, which is checked before
   * it is pressed. "moved": the page changed; "fill": it has questions to answer first; "end": the run's result is
   * sent; null: no way on.
   */
  const navigateOn = async (
    why: string,
    facts: PageFacts,
    before: string,
  ): Promise<"moved" | "fill" | "end" | null> => {
    if (!hello.aiNavigation || navCalls >= MAX_NAV) return null;
    navCalls++;
    const nav = await deps.navigate(why, facts).catch(() => null);
    if (!nav) return null;
    const { reply, el } = nav;
    if (reply.action === "done") {
      if (reply.state !== "success") return null;
      result({ status: "submitted", doneUrl: location.href, guesses: deps.guesses() });
      return "end";
    }
    if (reply.action === "stop") {
      // A bot check in the hidden frame is retried in a tab; in a tab it is the user's, like a CAPTCHA.
      const status = reply.state === "closed" ? "skipped" : reply.state === "blocked" && IN_HOST ? "blocked" : "needs";
      result({ status, reason: reply.reason || why, guesses: deps.guesses() });
      return "end";
    }
    if (reply.action === "fill") return "fill";
    if (reply.action === "wait") {
      if (await changed(before, 15_000)) return "moved";
      // A page that stays blank in the hidden frame (Taleo's login) never renders there: a tab may show it.
      if (IN_HOST && pageText().length < 40) {
        result({ status: "blocked", reason: "The page stays empty in the hidden page" });
        return "end";
      }
      return null;
    }
    if (!pressable(el)) return null;
    const account = reply.state === "account" || reply.state === "verify" || facts.passwords > 0;
    const final = reply.purpose === "final_submit" || (!account && RE_SUBMIT.test(labelOf(el)));
    const ambiguous =
      !account &&
      !final &&
      reply.purpose !== "dismiss" &&
      !(reply.purpose === "open_application" && reply.state === "posting") &&
      !RE_NEXT.test(labelOf(el));
    if ((final || ambiguous) && !(await beforeSubmit(ambiguous))) return "end";
    if (reply.purpose === "final_submit") {
      if (DRY) {
        dryStop(labelOf(el));
        return "end";
      }
      // As before any final Submit: the page's own built-ins back, and time on a graded page.
      busy(false);
      const graded = scoreCheck();
      setGraded(graded);
      if (graded) await dwell(facts.fields);
    }
    if (!(realFor("clicks") && (await realPress(el)))) press(el);
    // What it pressed may change nothing the step's signature reads (a dialog closing, a notice accepted:
    // SuccessFactors' privacy notice), so the step is read again either way; MAX_NAV and the loop guard end loops.
    await changed(before, 8_000);
    return "moved";
  };
  busy(true);
  try {
    if (hello.mode === "scrape") {
      await settle();
      await sleep(1500); // result lists often render after the page goes quiet
      return result({ status: "scraped", links: scrapeLinks(), walled: botWall() });
    }
    if (hello.posting) await deps.readPosting(hello.posting);
    let refills = 0;
    let pickedWay = false;
    /** Presses of Next/Submit in a row that changed nothing. */
    let idle = 0;
    /** Steps of this page load read as unknown. */
    let unknowns = 0;
    for (let i = 0; i < 30; i++) {
      // A navigation that never commits (a download, a 204) leaves the page as it was.
      if (leaving) {
        await sleep(15_000);
        leaving = false;
      }
      await settle();
      const facts = pageFacts(deps.fieldStats());
      setGraded(facts.scored);
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
      const signupForm = kind === "signup" && facts.requiredFields > 3;
      if (signupForm) {
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
        case "embedded": {
          // An embedded form loaded before in this run that led back here (iCIMS's login frame): the navigator decides.
          const src = embeddedForm();
          const seen = JSON.parse(sessionStorage.getItem("autoapply-embedded") ?? "[]") as string[];
          if (!src || seen.includes(src)) {
            const n = await navigateOn("The embedded application form leads back to this page", facts, before);
            if (n === "end") return;
            if (n === "fill") await fill();
            if (n) continue;
            return result({ status: "failed", reason: "The embedded form loops back", guesses: deps.guesses() });
          }
          sessionStorage.setItem("autoapply-embedded", JSON.stringify([...seen, src].slice(-10)));
          await deps.posting();
          location.href = src;
          return;
        }
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
          if ("fail" in r) {
            // A button its wording rules miss ("Create a new account"): the navigator's press, then the step again.
            const n = await navigateOn(`Account step: ${r.fail}`, facts, before);
            if (n === "end") return;
            if (n === "fill") await fill();
            if (n) continue;
            return needs(r.fail);
          }
          break;
        }
        case "job": {
          const b = findApply();
          // The facts saw an Apply that is gone now, or one no wording rule finds.
          if (!b) {
            const n = await navigateOn("No Apply button found on this posting", facts, before);
            if (n === "end") return;
            if (n === "fill") await fill();
            if (n) continue;
            return result({ status: "failed", reason: "No Apply button", guesses: deps.guesses() });
          }
          // A job board's own "Apply now" is its Easy Apply; only "Apply on company site" leads to the employer.
          const board = /(^|\.)(indeed|glassdoor|linkedin|ziprecruiter)\./.test(location.hostname);
          if (RE_EASY_APPLY.test(b.innerText) || (board && !/company|employer/i.test(labelOf(b))))
            return result({ status: "skipped", reason: "Easy Apply only (not supported yet)" });
          await deps.posting();
          press(b);
          // An Apply that opens a menu of ways in (Paccar's SuccessFactors: "Apply Now" beside LinkedIn and the like):
          // its own Apply item, the social ones avoided.
          if (b.matches("[aria-haspopup=true],[aria-haspopup=menu],[data-toggle=dropdown],[data-bs-toggle=dropdown]")) {
            // In its own menu: one opening upward sits above the toggle, which the lowest-Apply search would pick again.
            const item = await waitFor(
              () =>
                [...(b.parentElement?.querySelectorAll<HTMLElement>("a,button,[role=menuitem]") ?? [])].find(
                  (a) => a !== b && isVisible(a) && RE_APPLY.test(labelOf(a)),
                ),
              2000,
            );
            if (item) press(item);
          }
          if (!(await changed(before, 20_000))) {
            const n = await navigateOn(`Pressing "${labelOf(b)}" on the posting changed nothing`, facts, before);
            if (n === "end") return;
            if (n === "fill") await fill();
          }
          continue;
        }
        case "form": {
          const rep = await fill();
          // Now: a Submit that loads the confirmation page would take this page's guesses with it.
          await send({
            type: "YOLO_ANSWERS",
            answers: deps.debug ? deps.answers() : {},
            guesses: deps.guesses(),
            hasGuessedAnswers: deps.hasGuessedAnswers?.() ?? false,
          }).catch(() => undefined);
          if (rep.retryAt) return result({ status: "failed", reason: "AI usage limit reached", retryAt: rep.retryAt });
          if (rep.fatal) return needs(rep.fatal);
          if (rep.unfilled.length) return needs(`Couldn't fill: ${rep.unfilled.slice(0, 3).join(", ")}`);
          await acceptNotices();
          // A button the page enables once its form validates can lag the last answer (iCIMS's email step "Next").
          // Its own "Create Account" moves a sign-up form on (SuccessFactors' asks for name, phone and country too).
          const onward = () => findNext() ?? (signupForm ? findSignup() : null);
          await waitFor(() => onward() ?? findSubmit(), 5000);
          const next = onward();
          const b = next ?? findSubmit();
          // A page of ways to give the résumé (Avature's "From Device · Copy & Paste · Without Resume") shows its
          // Continue once one is picked; the file is already in its box.
          const way = b ? null : findButton(RE_UPLOAD_WAY);
          if (way && !pickedWay) {
            pickedWay = true;
            press(way);
            continue;
          }
          if (!b) {
            const n = await navigateOn("No Next or Submit button found after filling the page", facts, before);
            if (n === "end") return;
            if (n === "fill") await fill();
            if (n) continue;
            return result({ status: "failed", reason: "No Next or Submit button", guesses: deps.guesses() });
          }
          if (DRY && (!next || /submit/i.test(labelOf(b))))
            return needs(
              `Dry run before "${labelOf(b)}":\n${Object.values(deps.answers())
                .map((g) => `${g.q} = ${g.a}`)
                .join("\n")}`,
            );
          // A stable Next selector can also identify the final button; inspect its actual label too.
          const final = !next || (!signupForm && RE_SUBMIT.test(labelOf(b)));
          const ambiguous = !!next && !signupForm && /\bsubmit\b/i.test(labelOf(b)) && !RE_SUBMIT.test(labelOf(b));
          if ((final || ambiguous) && !(await beforeSubmit(ambiguous))) return;
          // A score check loaded during the fill: the step is classified again, so the hidden frame hands it to a tab.
          if (!next && IN_HOST && !facts.scored && scoreCheck()) continue;
          // Invisible CAPTCHAs score the page as it submits: it gets its own built-ins back first (pageTimers.ts).
          if (!next) busy(false);
          // They weigh time on the page too: a form sent seconds after it loaded reads as a bot's.
          // A check the fill loaded counts too (the frame case went back to be classified above).
          const graded = scoreCheck();
          setGraded(graded);
          if (!next && graded) await dwell(facts.fields);
          if (!(realFor("clicks") && (await realPress(b)))) press(b);
          if (!(await changed(before, 20_000))) {
            // A press the page ignores twice: something the rules don't see is in the way (a dialog, a hidden step).
            if (++idle >= 2) {
              idle = 0;
              const n = await navigateOn(`Pressing "${labelOf(b)}" changed nothing, twice`, facts, before);
              if (n === "end") return;
              if (n === "fill") await fill();
            }
            continue;
          }
          idle = 0;
          const errors = validationErrors();
          if (errors.length) {
            if (refills++ >= 2) return needs(`Form rejected: ${collapse(errors[0].innerText).slice(0, 80)}`);
            deps.refill(errors);
          }
          continue;
        }
        default:
          // Still rendering (Oracle's next section takes several seconds), or a page we don't know: give up only once
          // it stops changing. A second unknown step goes to the navigator even if the page keeps changing (a
          // carousel or clock), before the loop guard ends the run (Microsoft's sign-in choice).
          // With AI navigation off, keep main's full wait at every rendering stage.
          if ((!hello.aiNavigation || ++unknowns < 2) && (await changed(before, 15_000))) continue;
          // Workday's "Something went wrong. Please refresh the page and then try again." (the step loop guard caps it)
          if (/\b(refresh|reload) the page\b/i.test(pageText())) {
            location.reload();
            return;
          }
          {
            const n = await navigateOn(
              "The page isn't recognized as a posting, form, account step or confirmation",
              facts,
              before,
            );
            if (n === "end") return;
            if (n === "fill") await fill();
            if (n) continue;
          }
          // The hidden frame breaks pages that refuse to be framed (Taleo's "Prevent Frame usage"): a tab may not.
          return result({
            status: IN_HOST ? "blocked" : "failed",
            reason: "Unrecognized page",
            guesses: deps.guesses(),
          });
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
