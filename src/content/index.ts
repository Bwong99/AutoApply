// Content script: per-frame bootstrap (§11.1), fill pipeline (§12), learning (§16.3) and status reporting.
// Fills only when the user triggers it. Never sees API keys; never clicks submit/next. The exception is a YOLO run
// (./yolo), which the user turned on: it fills and submits in a page the background loaded for it.
import {
  canonicalCountry,
  profileConsentAnswer,
  RE_APPLIED,
  RE_CONSENT,
  RE_COVER_LETTER,
  RE_ENTRY_SECTION,
  RE_OPTIONAL_CONSENT,
  RE_RESUME_ONLY,
  sinAnswer,
} from "../shared/constants";
import { aiUseDecision, consentBoxes, matchesProfileConsent, profileConsentDecision } from "../shared/consents";
import { parseEssayLimits, wordCount } from "../shared/essay";
import { isErr, send as sendMessage, type Message, type Responses } from "../shared/messages";
import { resumeProblem, TAILOR_PLACEHOLDER } from "../shared/resumeMode";
import { SCREENING_SOURCE } from "../shared/screening";
import type {
  ApiError,
  Decision,
  EssayItem,
  FieldDescriptor,
  FrameStatus,
  NeedsYouItem,
  RuntimeConfig,
  StatusCounts,
  UploadedDoc,
} from "../shared/types";
import { extractJobContext, jobUrl, ldPosting, phenomPostingUrl, readPay } from "./jobContextExtract";
import { deterministicValue, isFreeText, matchLearned, RE_CITY_FIELD, shoutedName } from "./match/deterministic";
import { localMatchAll } from "./match/localMatch";
import { harvestOptions, ui5Host } from "./fill/dropdown";
import { fill, serial, type FillOp } from "./fill/engine";
import { dispatching, haltFill, isFilling, sleep, waitFor } from "./fill/events";
import { findDropzones, isPortfolioUpload } from "./fill/file";
import { portfolioLink } from "../shared/portfolio";
import {
  addEntries,
  editInvalidEntries,
  expandSections,
  resumeEntries,
  saveEntries,
  trimEntries,
  type EntryKind,
} from "./fill/sections";
import { readValue } from "./fill/verify";
import {
  consentPair,
  isConsent,
  lowestCommonAncestor,
  newScanState,
  onlyPair,
  scan,
  yesNoPair,
  type FieldHandle,
} from "./scan/fields";
import { removeBadge, setBadge, setBadgesVisible, type BadgeColor } from "./ui/badges";
import { showFieldPrompt } from "./ui/fieldPrompt";
import { showLearnPrompt } from "./ui/learnPrompt";
import { createOverlay, type Overlay } from "./ui/overlay";
import { claimFrame, relayClicksToTop } from "./ui/root";
import { nextMidnightPacific } from "../shared/time";
import type { Guess } from "../shared/yolo";
import { composedContains, isVisible } from "./scan/visibility";
import { HOST_TAG } from "./scan/traverse";
import { RE_SIGNUP_BOX } from "./yolo/classify";
import { jobContext, postingContext, shareOnApply, tabJob } from "./posting";
import { drive, type FillReport } from "./yolo/driver";
import { DRIVER_FRAME, endTransitions, IN_HOST, throttled } from "./yolo/frame";
import { labelOf } from "./yolo/nav";
import { adoption, opForAnswer, RE_POLICY_NOTE, revealable } from "./review/reconcile";
import { snapshot } from "./review/snapshot";
import type { ReviewField } from "../shared/review";
import { clip, normalize } from "../shared/normalize";

type Status =
  | "pending"
  | "working"
  | "filled"
  | "ai"
  | "draft"
  | "needs"
  | "check"
  | "failed"
  | "prefilled"
  | "skipped"
  | "you"
  | "saved"
  | "edited";

interface FieldState {
  status: Status;
  note?: string;
  tooltip?: string;
  userOwned?: boolean;
  /** Was flagged/failed, or AI-filled then changed by the user → eligible for the learning prompt. */
  learnable?: boolean;
  /** Field value when the status was last set; a different value later means the user changed it. */
  value?: string;
}

const BADGE: Partial<Record<Status, [BadgeColor, string]>> = {
  filled: ["green", "✓"],
  you: ["green", "You"],
  saved: ["green", "Saved"],
  ai: ["blue", "AI"],
  draft: ["purple", "AI draft"],
  needs: ["yellow", "Needs you"],
  check: ["orange", "Check"],
  failed: ["red", "Failed"],
};

// The YOLO host's frame is its page's top frame; the host itself (an extension page) runs nothing of ours.
const TOP = window === window.top || DRIVER_FRAME;
const HOST = location.hostname;

let config: RuntimeConfig;
const scanState = newScanState();
const handles = new Map<string, FieldHandle>();
const states = new Map<string, FieldState>();
const checkedByUs = new Set<Element>();
const harvested = new Map<string, string[]>();
let current: { groupId: string; ctrl: AbortController } | null = null;
let running = false;
/** `round`: AI review rounds this trigger already ran (each follow-up pass carries the count on). */
let queued: { rerun: boolean; depth?: number; round?: number } | null = null;
/** The AI review is reading the page (overlay: "Reviewing…"). */
let reviewing = false;
/** Fields answered by the screening policy (shared/screening.ts): the AI review leaves them as they are. */
const screened = new Set<string>();
/** Times the review corrected each field: a third correction means the page won't take it. */
const reviewTries = new Map<string, number>();
/** "Add" / "Show more" buttons the review pressed, each once. */
const revealed = new WeakSet<Element>();
/** Review rounds per trigger: each re-reads the page after the last one's corrections. */
const MAX_REVIEW_ROUNDS = 3;
/**
 * The last review's request and verdicts: the same page and answers again (corrections the page didn't take, a pass
 * that changed nothing) get those verdicts without asking the AI the same question. A trigger of the user's asks anew.
 */
let lastReview: { key: string; r: Responses["REVIEW_FORM"] } | null = null;
/** Save buttons of entry editors addEntries opened, clicked after the last fill pass. */
const unsaved: HTMLElement[] = [];
let lastError: ApiError | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let timings: [string, number][] = [];
let usedModel: string | null = null;
/** This fill's résumé variant for the job, when Documents has several résumés. */
let resumeId: string | null = null;
/** AI tailor: the résumé being tailored for this job, asked for once per fill (the background caches it per job). */
let tailoring: Promise<Responses["TAILOR_RESUME"]> | null = null;
/** Fields whose tailored résumé or cover letter failed, and why: the overlay offers to regenerate them. */
const regen = new Map<string, { kind: "resume" | "cover_letter"; note: string }>();
let overlay: Overlay | null = null;
/** Top frame: a triggered fill found no fields here, and no child frame reported any either. */
let noForm = false;
const NO_FORM: ApiError = { kind: "other", message: "No job application form found on this page." };
const childFrames = new Map<number, FrameStatus>();
let listening = false;
/** Aborted when a newer instance (extension reload/update) takes over this frame. */
const life = new AbortController();
/** This page belongs to a YOLO run: every field gets an answer, and nothing is left for the user. */
let yolo = false;
let reviewContext: { key: string; ready: boolean } | undefined;
/** Hands the page back from a YOLO run to the user: once, whichever way the run stops. */
let releaseYolo = () => undefined as void;
/** A resumed run stuck on this tab waits for the user (background/yolo/parked.ts): the overlay's text for it. */
let waiting: string | undefined;
/** The overlay shows Continue YOLO with it. */
let canContinue = false;
/** In the tab's sessionStorage: its next page (the site's own Next, pressed by the user) asks whether it still waits. */
const WAITING_MARK = "autoapply-yolo-waiting";
let hasGuessedAnswers = false;
/** Why the run can't go on, from the last fill (a required ID number, no résumé). */
let yoloFatal: string | undefined;
/** Résumés and cover letters uploaded per field, for the overlay to preview. */
const uploads = new Map<string, UploadedDoc>();
/** The posting an apply page that names no location is for (Phenom), read once. */
let posting: { url: string; ctx: Promise<ReturnType<typeof ldPosting>> } | null = null;
/** Documents the AI tailored or wrote for this job: the overlay offers the job details it was given. */
const aiDocs = new Set<string>();
/** Answers the AI made up on this page, for the run's log. */
const guesses = new Map<string, Guess>();

// ---------- status ----------
function counts(): StatusCounts {
  const c: StatusCounts = {
    total: 0,
    filled: 0,
    aiMatched: 0,
    aiDrafted: 0,
    needsYou: 0,
    failed: 0,
    prefilled: 0,
    skipped: 0,
  };
  for (const s of states.values()) {
    c.total++;
    if (["filled", "ai", "draft", "check", "you", "saved", "edited"].includes(s.status)) c.filled++;
    if (s.status === "ai") c.aiMatched++;
    if (s.status === "draft") c.aiDrafted++;
    if (s.status === "needs") c.needsYou++;
    if (s.status === "failed") c.failed++;
    if (s.status === "prefilled") c.prefilled++;
    if (s.status === "skipped") c.skipped++;
  }
  return c;
}

function frameStatus(): FrameStatus {
  const needsYou: NeedsYouItem[] = [];
  for (const [id, s] of states) {
    const bad = s.status === "needs" || s.status === "failed";
    const r = s.userOwned || s.status === "working" ? undefined : regen.get(id);
    if (bad || r)
      needsYou.push({
        fieldId: id,
        label: handles.get(id)?.desc.label ?? "",
        note: (bad ? s.note : r!.note) ?? "",
        ...(r && { regen: true as const }),
      });
  }
  const docs = [...uploads].filter(([id]) => !states.get(id)?.userOwned).map(([, d]) => d);
  return {
    frameId: 0,
    counts: counts(),
    needsYou,
    running,
    ...(reviewing ? { reviewing } : {}),
    error: lastError?.message,
    uploads: docs,
  };
}

let reportTimer: ReturnType<typeof setTimeout> | undefined;
function report() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = undefined;
    const st = frameStatus();
    send({ type: "FRAME_STATUS", status: st }).catch(() => undefined);
    if (TOP && !IN_HOST) renderOverlay();
  }, 250);
}

function renderOverlay() {
  const own = frameStatus();
  const frames = [own, ...childFrames.values()].filter((f) => f.counts.total || f.running || f.error);
  const childError = [...childFrames.values()].find((f) => f.error)?.error;
  const error =
    lastError ?? (childError ? { kind: "other", message: childError } : !frames.length && noForm ? NO_FORM : null);
  if (!frames.length && !error && !reviewContext && !waiting) return;
  overlay ??= createOverlay({
    onRerun: () => void send({ type: "BROADCAST_FILL", rerun: true }).catch(() => undefined),
    // Every frame of this tab only: a form in an iframe fills in its own frame. Never a YOLO run's page.
    onStop: () => {
      if (yolo) return;
      stop();
      void send({ type: "BROADCAST_STOP" }).catch(() => undefined);
    },
    onRetry: () => void send({ type: "BROADCAST_FILL", rerun: true }).catch(() => undefined),
    onOpenSettings: () => void send({ type: "OPEN_OPTIONS", hash: "/ai" }).catch(() => undefined),
    onFocus: (n) =>
      n.frameId
        ? void send({ type: "FOCUS_FIELD", frameId: n.frameId, fieldId: n.fieldId }).catch(() => undefined)
        : focusField(n.fieldId),
    onRegenerate: (n) =>
      n.frameId
        ? void send({ type: "REGEN_DOC", frameId: n.frameId, fieldId: n.fieldId }).catch(() => undefined)
        : void regenerate(n.fieldId),
    onOpenDoc: (id) => void openDoc(id),
    onJobInfo: (id) => send({ type: "GET_DOC_JOB", id }).catch(() => null),
    onContinue: () => {
      canContinue = false;
      renderOverlay();
      void send({ type: "YOLO_CONTINUE" })
        .then((r) => {
          setWaitingMark(false);
          waiting = !r.ok
            ? "This application is no longer waiting on you."
            : r.queued
              ? "YOLO continues here as soon as it's free."
              : "Continuing…";
        })
        .catch(() => {
          waiting = "Couldn't reach AutoApply. Reload the page and use Resume in Applications.";
        })
        .finally(renderOverlay);
    },
  });
  const total: StatusCounts = {
    total: 0,
    filled: 0,
    aiMatched: 0,
    aiDrafted: 0,
    needsYou: 0,
    failed: 0,
    prefilled: 0,
    skipped: 0,
  };
  for (const f of frames) for (const k of Object.keys(total) as (keyof StatusCounts)[]) total[k] += f.counts[k];
  overlay.update({
    counts: total,
    needsYou: frames.flatMap((f) => f.needsYou.map((n) => ({ ...n, frameId: f.frameId }))),
    running: frames.some((f) => f.running),
    reviewing: frames.some((f) => f.reviewing),
    uploads: [...new Map(frames.flatMap((f) => f.uploads ?? []).map((d) => [d.id, d])).values()],
    error,
    waiting,
    canContinue,
    model: usedModel ?? config?.selectedModel ?? null,
    debug: config?.settings.debugLogging ? timings.map(([k, v]) => `${k.padEnd(10)} ${v} ms`).join("\n") : "",
    notice:
      [
        reviewContext &&
          "Review your answers, then submit using this site's button. AutoApply will not submit this application.",
        config?.appliedBefore &&
          (config.appliedBefore.byYou
            ? `You already applied to this job (added to Applications on ${new Date(config.appliedBefore.at).toLocaleDateString()})`
            : `YOLO already applied to this job on ${new Date(config.appliedBefore.at).toLocaleDateString()}`),
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
  });
}

function setStatus(h: FieldHandle, status: Status, note?: string, tooltip?: string) {
  const s = states.get(h.id) ?? { status };
  s.status = status;
  s.note = note;
  s.tooltip = tooltip;
  if (status === "needs" || status === "failed") s.learnable = true;
  if (status !== "pending" && status !== "working") s.value = readValue(h);
  states.set(h.id, s);
  const b = BADGE[status];
  if (b && config.settings.showBadges) {
    const onClick = status === "draft" ? () => offerLearn(h, "Save as reusable answer?") : undefined;
    setBadge(
      h.id,
      badgeTarget(h),
      b[0],
      b[1],
      [note, tooltip].filter(Boolean).join(" — ") || b[1],
      onClick,
      h.desc.label,
    );
  } else removeBadge(h.id);
  report();
}

/** Badge the control, not its question: a group's options, else the control, or its container if the control is hidden. */
const badgeTargets = new WeakMap<FieldHandle, HTMLElement>();
function badgeTarget(h: FieldHandle): HTMLElement {
  let t = badgeTargets.get(h);
  if (!t) {
    t = h.members && h.members.length > 1 ? (lowestCommonAncestor(h.members) as HTMLElement) : h.el;
    if (!isVisible(t)) t = h.container;
    badgeTargets.set(h, t);
  }
  return t;
}

// ---------- helpers ----------
/** Observe usage limits before a caller can treat an AI failure as an optional step or a missing answer. */
async function send<M extends Message>(msg: M): Promise<Responses[M["type"]]> {
  const run = current;
  const r = await sendMessage(msg);
  if (isErr(r) && (!run || run === current)) rateLimited(r.error);
  return r;
}

/** Opens an uploaded document in a new tab (the browser's PDF viewer), fetched only when clicked. */
async function openDoc(id: string) {
  const d = await send({ type: "GET_DOCUMENT", id }).catch(() => null);
  if (!d) return;
  const bytes = Uint8Array.from(atob(d.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: d.meta.mimeType }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function focusField(id: string) {
  const h = handles.get(id);
  const target = h?.members?.[0] ?? h?.searchInput ?? h?.el;
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
  target?.focus?.({ preventScroll: true });
}

function stop() {
  if (!current || yolo) return;
  queued = null;
  clearTimeout(retryTimer);
  haltFill(true);
  current.ctrl.abort();
  void send({ type: "ABORT", groupId: current.groupId }).catch(() => undefined);
  for (const [id, s] of states) if (s.status === "working") setStatus(handles.get(id)!, "needs", "Stopped");
}

/** A résumé/CV upload (not a cover letter's), the fields Upload résumés decides. */
const isResumeUpload = (h: FieldHandle) => {
  const text = `${h.desc.label} ${h.desc.hint ?? ""}`;
  return h.desc.kind === "file" && !RE_COVER_LETTER.test(text) && RE_RESUME_ONLY.test(text);
};

function primaryDocFor(h: FieldHandle): string | null | undefined {
  const text = `${h.desc.label} ${h.desc.hint ?? ""}`;
  const docs = config.documentsIndex;
  if (RE_COVER_LETTER.test(text)) return docs.find((d) => d.kind === "cover_letter")?.id ?? null;
  if (RE_RESUME_ONLY.test(text))
    return resumeId ?? (docs.find((d) => d.isPrimaryResume) ?? docs.find((d) => d.kind === "resume"))?.id ?? null;
  return undefined; // not a résumé/cover-letter field: ask the AI
}

function opFromDecision(h: FieldHandle, d: Decision): FillOp | null {
  const k = h.desc.kind;
  if (k === "file") {
    const id = d.documentId ?? primaryDocFor(h);
    return id ? { type: "file", documentId: id } : null;
  }
  if (k === "checkbox") return d.checked === undefined ? null : { type: "checked", value: d.checked };
  const options = h.desc.options ?? harvested.get(h.id);
  if (d.optionIndexes?.length && options) return { type: "options", texts: d.optionIndexes.map((i) => options[i]) };
  if (k === "dropdown" || k === "typeahead") {
    const answer = d.intendedAnswer ?? d.text;
    return answer ? { type: "intended", answer, query: d.searchQuery } : null;
  }
  if (isFreeText(k)) {
    const value = d.text ?? d.intendedAnswer;
    return value ? { type: "text", value } : null;
  }
  const answer = d.intendedAnswer ?? d.text;
  return answer ? { type: "intended", answer, query: d.searchQuery } : null;
}

const opText = (op: FillOp) =>
  op.type === "text"
    ? op.value
    : op.type === "options"
      ? op.texts.join(", ")
      : op.type === "intended"
        ? op.answer
        : op.type === "checked"
          ? String(op.value)
          : "";

// ---------- choose-options batching (§14.6 step 3) ----------
const chooseQueue: {
  item: { fieldId: string; question: string; intendedAnswer: string; options: string[]; multiple: boolean };
  resolve: (v: number[] | null) => void;
}[] = [];
let chooseBusy = false;
function choose(h: FieldHandle, intended: string, options: string[]): Promise<number[] | null> {
  return new Promise((resolve) => {
    chooseQueue.push({
      item: { fieldId: h.id, question: h.desc.label, intendedAnswer: intended, options, multiple: !!h.desc.multiple },
      resolve,
    });
    void drainChoose();
  });
}
async function drainChoose() {
  if (chooseBusy) return;
  chooseBusy = true;
  await sleep(0);
  while (chooseQueue.length) {
    if (lastError?.kind === "allKeysExhausted") {
      for (const b of chooseQueue.splice(0)) b.resolve(null);
      break;
    }
    const batch = chooseQueue.splice(0, 20);
    const r = await send({
      type: "CHOOSE_OPTIONS",
      items: batch.map((b) => b.item),
      groupId: current?.groupId ?? "",
    }).catch(() => null);
    for (const b of batch) {
      const c = r && !isErr(r) ? r.choices.find((x) => x.fieldId === b.item.fieldId) : null;
      b.resolve(c?.optionIndexes ?? null);
    }
  }
  chooseBusy = false;
}

// ---------- pipeline (§12) ----------
/** Follow-ups that slide in stay hidden until their transition ends (Jane Street's student fields, 0.5 s). */
async function transitionsEnd(maxMs = 800) {
  const running = (document.getAnimations?.() ?? []).filter(
    (a) => a.playState === "running" && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)),
  );
  if (running.length) await Promise.race([Promise.allSettled(running.map((a) => a.finished)), sleep(maxMs)]);
}

/** What the page said about fields it rejected, by field: each scan's fresh descriptor gets it again (refill). */
const rejected = new Map<string, string>();

function rescan(): FieldHandle[] {
  const { handles: hs } = scan(scanState);
  const all = [...hs, ...findDropzones(hs, scanState)];
  for (const h of all) {
    const said = rejected.get(h.id);
    if (said !== undefined) {
      h.desc.required = true;
      if (said && !h.desc.hint?.includes(said))
        h.desc.hint = [h.desc.hint, `The form said: "${said}"`].filter(Boolean).join(" ");
    }
    // Dropzone.js (Teamtailor) swaps in a new hidden input after each upload: it is the same, uploaded field.
    const old =
      h.desc.kind === "file" && !states.has(h.id)
        ? [...handles.values()].find(
            (o) => o.desc.kind === "file" && o.desc.label === h.desc.label && !o.el.isConnected && states.has(o.id),
          )
        : undefined;
    if (old) states.set(h.id, states.get(old.id)!);
    handles.set(h.id, h);
  }
  if (yolo) markEntries(all);
  return all;
}

// ---------- résumé entries a site's parser wrote (YOLO) ----------
/** Entries ("experience 2") that held values before we filled them. */
const parsedEntries = new Set<string>();
/** Each field's work or education entry, by field id. */
const entryOf = new Map<string, { kind: EntryKind; n: number }>();

/**
 * A numbered work or education section ("Professional Experience 3"), or a lone one; `own`: only one the page itself
 * numbers as an entry ("Work Experience 2", iCIMS's "Experience (2)").
 */
function sectionEntry(section = "", own = false): { kind: EntryKind; n: number } | null {
  const s = section.replace(/\s*\((\d+)\)$/, " $1");
  if (own && !RE_ENTRY_SECTION.test(s)) return null;
  const [, base, n] = /^(.*?)(?: (\d+))?$/.exec(s)!;
  const kind: EntryKind | null = /education/i.test(base)
    ? "education"
    : /^(?!.*volunteer).*(experience|employment|work history)/i.test(base)
      ? "experience"
      : null;
  return kind && (n || RE_ENTRY_SECTION.test(s)) ? { kind, n: Number(n) || 1 } : null;
}

/**
 * A work or education entry holding values before we filled it was written by the site's résumé parser (Breezy,
 * iCIMS, Avature: projects as employers, titles and companies mismatched, wrong dates), not by the candidate, who
 * never types into a YOLO page. Its fields are answered from the profile entry of its place ("Work Experience 2"),
 * without the parser's values, never kept as prefilled.
 */
function markEntries(hs: FieldHandle[]) {
  const boxes = resumeEntries();
  for (const h of hs) {
    // The page's own entry headings first: Workday's "Education 1" and iCIMS's "Experience (1)" have no Delete.
    const e =
      sectionEntry(h.desc.section, true) ??
      boxes.find((b) => composedContains(b.box, h.el)) ??
      sectionEntry(h.desc.section);
    if (!e) {
      entryOf.delete(h.id);
      continue;
    }
    entryOf.set(h.id, { kind: e.kind, n: e.n });
    if (h.prefilled && !states.has(h.id)) parsedEntries.add(`${e.kind} ${e.n}`);
  }
  for (const h of hs) {
    const e = parsedEntry(h);
    if (!e) continue;
    h.desc.section = `${e.kind === "education" ? "Education" : "Work Experience"} ${e.n}`;
    if (states.has(h.id)) continue;
    h.prefilled = false;
    delete h.desc.currentValue;
  }
}

function parsedEntry(h: FieldHandle) {
  const e = entryOf.get(h.id);
  return e && parsedEntries.has(`${e.kind} ${e.n}`) ? e : undefined;
}

/** Ours: an entry holding a field we filled. */
const oursIn = (box: Element) =>
  [...applied.keys()].some((id) => {
    const h = handles.get(id);
    return !!h && composedContains(box, h.el);
  });

/** What a parser left in an entry field the profile has nothing for is emptied, not kept. */
function skipOrClear(h: FieldHandle, ctrl: AbortController, jobs: Promise<void>[]) {
  if (parsedEntry(h) && !h.sections && /^(text|textarea|date|month|number|select)$/.test(h.desc.kind) && readValue(h))
    jobs.push(doFill(h, { type: "clear" }, "skipped", "Not in your Profile", ctrl));
  else setStatus(h, "skipped");
}

/**
 * Chrome stops rendering a cross-origin frame that lies wholly outside the viewport, so its dropdowns never open
 * (Riot's Greenhouse form, far below the job description): scroll the frame into view first. Its viewport size, stale
 * meanwhile (150 px for Riot's 6582 px frame), updates some 100 ms after it shows; fills before that still fail.
 * Work the page deferred meanwhile runs then: Lyft's Greenhouse form hydrates only once shown, and our badges or
 * fills during that lose every dropdown its handlers. Wait until the page goes idle.
 */
async function revealFrame() {
  const root = document.documentElement;
  const seen = await new Promise<boolean>((resolve) => {
    const io = new IntersectionObserver(([e]) => {
      io.disconnect();
      resolve(e.isIntersecting);
    });
    io.observe(root);
    // An unrendered frame may never report (Brex's Greenhouse form): no answer means not shown.
    void sleep(300).then(() => resolve(false));
  });
  if (seen) return;
  const stale = innerHeight;
  root.scrollIntoView({ block: "start" });
  await waitFor(() => innerHeight !== stale, 1000);
  // The page's own idle callback (Remix's hydrate) runs first; ours then waits out the work it queued.
  for (let i = 0; i < 2; i++) await new Promise((r) => requestIdleCallback(r, { timeout: 1000 }));
}

/** The last fill applied to each field, to re-apply as is if the page empties it. */
const applied = new Map<string, [FillOp, Status, string]>();

async function doFill(h: FieldHandle, op: FillOp, okStatus: Status, tooltip: string, ctrl: AbortController) {
  if (states.get(h.id)?.userOwned) return;
  if (tooltip === "guess") {
    hasGuessedAnswers = true;
    okStatus = "check";
    tooltip = "Best guess (YOLO)";
    guesses.set(h.id, { q: h.desc.label, a: opText(op) });
  }
  if (tooltip.split(/,\s*/).includes(SCREENING_SOURCE)) {
    hasGuessedAnswers = true;
    screened.add(h.id);
    okStatus = "check";
    tooltip = "Meets the job's screening requirement; review this answer";
    guesses.set(h.id, { q: h.desc.label, a: opText(op) });
  }
  applied.set(h.id, [op, okStatus, tooltip]);
  setStatus(h, "working");
  const r = await fill(h, op, {
    documents: config.documentsIndex,
    getDocument: (id) => send({ type: "GET_DOCUMENT", id }),
    choose,
    checkedByUs,
    harvested,
    signal: ctrl.signal,
  });
  if (states.get(h.id)?.userOwned) return;
  const doc = r.outcome === "ok" && config.documentsIndex.find((d) => d.id === r.docId);
  if (doc && (doc.kind === "resume" || doc.kind === "cover_letter"))
    uploads.set(h.id, { id: doc.id, kind: doc.kind, fileName: doc.fileName, ...(aiDocs.has(doc.id) && { ai: true }) });
  else uploads.delete(h.id);
  if (r.outcome === "ok") {
    setStatus(h, okStatus, r.note, okStatus === "ai" && r.shown ? `${tooltip} → "${r.shown}"` : tooltip);
  } else if (r.outcome === "mismatch") setStatus(h, "check", r.note, tooltip);
  else if (r.outcome === "failed" && !ctrl.signal.aborted) setStatus(h, "failed", r.note);
  else setStatus(h, "needs", ctrl.signal.aborted ? "Stopped" : r.note);
}

const RE_COUNTRY_FIELD =
  /^(country|country\/region|country or region|country\/territory|(country )?phone (country )?code)$/i;
/**
 * A site's own default country where the profile names another: Workday tenants preselect theirs ("United States of
 * America (+1)"), whose states then left a Canadian's province unanswerable. Not someone's answer, so it is filled.
 */
function defaultCountry(h: FieldHandle): boolean {
  if (!RE_COUNTRY_FIELD.test(h.desc.label)) return false;
  const shown = canonicalCountry(
    readValue(h)
      .replace(/\(.*?\)|\+\d+/g, "")
      .trim(),
  );
  const home = canonicalCountry(config.profileSnapshotForDeterministic.personal.address.country);
  return !!shown && !!home && shown !== home;
}

/** Profile-owned consents use the same local mapping rules as review, even when the preference is unset. */
const profileConsent = (d: FieldDescriptor) =>
  matchesProfileConsent(d, config.profileSnapshotForDeterministic.consents);

/**
 * Profile owns matching questions and individual boxes in mixed groups. Only other consents use Behaviour settings.
 */
function handleConsent(h: FieldHandle, d: Decision | undefined, ctrl: AbortController, jobs: Promise<void>[]) {
  const text = `${h.desc.label} ${h.desc.hint ?? ""}`;
  const prefs = config.profileSnapshotForDeterministic.consents;
  const options = h.desc.options ?? harvested.get(h.id);
  const descriptor = { ...h.desc, options };
  if (profileConsent(descriptor)) {
    const decision = aiUseDecision(descriptor) ?? profileConsentDecision(descriptor, prefs)!;
    if (decision.action !== "consent") {
      const op = decision.action === "fill" ? opFromDecision(h, decision) : null;
      if (op) jobs.push(doFill(h, op, "ai", "Profile consent preference", ctrl));
      else setStatus(h, "needs", decision.note ?? "Needs your confirmation");
      return;
    }
  }
  const { optionalConsents, autoAcceptAcknowledgements } = config.settings;
  if (consentBoxes({ ...h.desc, options }, prefs) && profileConsent({ ...h.desc, options })) {
    const modes = options!.map((o) => {
      const p = profileConsentAnswer(o, prefs);
      return p !== null
        ? p === "yes"
          ? "accept"
          : p === "no"
            ? "decline"
            : "ask"
        : RE_OPTIONAL_CONSENT.test(o)
          ? optionalConsents
          : autoAcceptAcknowledgements
            ? "accept"
            : "ask";
    });
    if (modes.includes("ask")) setStatus(h, "needs", "Needs your confirmation");
    else
      jobs.push(
        doFill(
          h,
          { type: "options", texts: options!.filter((_, i) => modes[i] === "accept"), exact: true },
          "ai",
          "Consent preferences",
          ctrl,
        ),
      );
    return;
  }
  // A required choice can still say "No": Braze requires an answer to "Select 'Yes' to join our Talent Community".
  const choice = h.desc.kind !== "checkbox" && !RE_CONSENT.test(text);
  const pref = profileConsentAnswer(text, prefs);
  const optional = (!h.desc.required || choice) && (d?.checked === false || RE_OPTIONAL_CONSENT.test(text));
  const settingsMode = optional ? optionalConsents : autoAcceptAcknowledgements ? "accept" : "ask";
  const mode = pref !== null ? (pref === "yes" ? "accept" : pref === "no" ? "decline" : "ask") : settingsMode;
  const accept = mode === "accept";
  // Choice fields: [consenting option, declining option], from the AI or read locally from the options.
  // The AI may answer "consent" without naming the two options (Ramp's SMS question): read them locally then.
  // A lone option (Reddit's "I agree" dropdown) can only accept; plain "Yes"/"No" (MongoDB's job alerts) pair too.
  const pair =
    d?.optionIndexes?.length === 2
      ? d.optionIndexes
      : ((options && (consentPair(options) ?? yesNoPair(options) ?? onlyPair(options))) ??
        (options?.length === 1 ? [0] : d?.optionIndexes));
  const pick = options?.[pair?.[accept ? 0 : 1] ?? -1];
  // Unmatched groups retain the existing required/optional consent handling.
  const boxes =
    h.desc.kind === "checkbox_group" &&
    accept &&
    options?.every((o) => RE_CONSENT.test(o) || RE_OPTIONAL_CONSENT.test(o))
      ? options.filter((o) => optional || optionalConsents === "accept" || !RE_OPTIONAL_CONSENT.test(o))
      : [];
  const op: FillOp | null =
    h.desc.kind === "checkbox"
      ? { type: "checked", value: accept }
      : boxes.length
        ? { type: "options", texts: boxes }
        : pick
          ? { type: "options", texts: [pick] }
          : // Options not read yet (Twitch's 16th dropdown, "considered for future opportunities?"; Eightfold's Yes/No
            // combobox "A recruiter may contact me regarding opportunities."): pick by meaning.
            (h.desc.kind === "dropdown" || h.desc.kind === "typeahead") && !options
            ? { type: "intended", answer: accept ? "Yes" : "No" }
            : null;
  const tooltip = `${accept ? "Auto-accepted" : "Auto-declined"}${pref ? " (Profile)" : optional ? " (optional)" : ""}`;
  if (mode !== "ask" && op) jobs.push(doFill(h, op, "ai", tooltip, ctrl));
  else setStatus(h, "needs", "Needs your confirmation");
}

/** Filled by us, then emptied by the page itself. Not uploads: re-uploading a résumé re-runs its parser. */
function emptied(h: FieldHandle): boolean {
  const s = states.get(h.id);
  return (
    !!s?.value &&
    !s.userOwned &&
    applied.has(h.id) &&
    h.desc.kind !== "file" &&
    ["filled", "ai", "draft", "check"].includes(s.status) &&
    h.el.isConnected &&
    !readValue(h)
  );
}

/** Job context: top frame extracts; child frames share theirs only when they hold a description. */
async function shareJobContext() {
  const jc = jobContext();
  const postingUrl = TOP && !jc.location ? phenomPostingUrl(location) : null;
  if (postingUrl) {
    // Once per posting: Phenom's later steps are the same page.
    if (posting?.url !== postingUrl) posting = { url: postingUrl, ctx: fetchPosting(postingUrl) };
    const p = await posting.ctx;
    // The posting's description over the apply page's blurb.
    if (p?.location) Object.assign(jc, { location: p.location, text: p.text || jc.text });
  }
  if (TOP || jc.text) await send({ type: "SET_JOB_CONTEXT", ctx: jc });
}

/** Variant select: which of several résumés to upload for this job. */
async function pickResumeVariant() {
  resumeId =
    config.settings.resumeUpload === "variants" && config.documentsIndex.filter((d) => d.kind === "resume").length > 1
      ? (await send({ type: "PICK_RESUME" })).id
      : null;
}

interface LocalEnv {
  det: RuntimeConfig["profileSnapshotForDeterministic"];
  cityField: boolean;
  usedLearned: string[];
  ctrl: AbortController;
  jobs: Promise<void>[];
  groupId: string;
  /** Fill this field: the user asked for this one, so what it holds is filled over. */
  force?: boolean;
}

/** PHASE A for one field: deterministic and learned answers, no AI. False: the AI is to map it. */
function localFill(h: FieldHandle, env: LocalEnv): boolean {
  const { det, cityField, usedLearned, ctrl, jobs, groupId } = env;
  // A parsed entry past the profile's that has no Delete (iCIMS's fixed slots).
  const entry = parsedEntry(h);
  if (entry && entry.n > config.entryCounts[entry.kind]) {
    skipOrClear(h, ctrl, jobs);
    return true;
  }
  // Not one the page rejected: what it holds is ours, and wrong (a typed place never picked from its list).
  if (
    h.prefilled &&
    !env.force &&
    !config.settings.overwritePrefilled &&
    !defaultCountry(h) &&
    !shoutedName(h.desc, det.personal) &&
    !rejected.has(h.id)
  ) {
    setStatus(h, "prefilled");
    return true;
  }
  if (h.sensitive && !sinAnswer(h.desc, det.hasSin, det.noCanadianPermitNeeded)) {
    // Never made up: a required ID or card number ends a YOLO application.
    if (yolo && h.desc.required) yoloFatal = `Asks for ${h.desc.label}`;
    setStatus(h, yolo && !h.desc.required ? "skipped" : "needs", "Sensitive – fill manually");
    return true;
  }
  if (profileConsent(h.desc)) {
    // Harvest unknown choices first; Unset can be flagged immediately without opening the dropdown.
    if (
      (h.desc.kind === "dropdown" || h.desc.kind === "typeahead") &&
      !h.desc.optionsKnown &&
      profileConsentAnswer(`${h.desc.label} ${h.desc.hint ?? ""}`, det.consents)
    )
      return false;
    handleConsent(h, undefined, ctrl, jobs);
    return true;
  }
  if (h.consent) {
    handleConsent(h, undefined, ctrl, jobs);
    return true;
  }
  if (isResumeUpload(h) && config.settings.resumeUpload !== "variants") {
    if (config.settings.resumeUpload === "tailor") jobs.push(tailoredUpload(h, groupId, ctrl));
    else setStatus(h, "needs", "Upload your résumé (Flag for me)");
    return true;
  }
  if (h.desc.kind === "file") {
    const doc = primaryDocFor(h);
    if (doc) {
      const label = doc === resumeId ? config.documentsIndex.find((d) => d.id === doc)?.label : undefined;
      jobs.push(doFill(h, { type: "file", documentId: doc }, "filled", label ?? "Primary résumé", ctrl));
    } else if (
      doc === null &&
      RE_COVER_LETTER.test(h.desc.label) &&
      ((yolo && h.desc.required) || config.settings.coverLetterPdfs)
    )
      jobs.push(coverLetter(h, ctrl));
    else if (doc === null && yolo && RE_COVER_LETTER.test(h.desc.label)) setStatus(h, "skipped");
    else if (doc === null)
      setStatus(h, "needs", RE_COVER_LETTER.test(h.desc.label) ? "No cover letter uploaded" : "No résumé uploaded");
    else if (wantsPortfolioPdf(h)) jobs.push(portfolioUpload(h, ctrl));
    else return false;
    return true;
  }
  const d = deterministicValue(h.desc, det.personal, cityField);
  if (d) {
    const op: FillOp = d.query
      ? { type: "intended", answer: d.value, query: d.query }
      : { type: "text", value: d.value };
    if (d.value) jobs.push(doFill(h, op, "filled", d.path, ctrl));
    // An optional box the profile leaves empty (Fivetran's "Address Line 2") needs nothing.
    else if (h.desc.required) setStatus(h, "needs", "Not set in your Profile");
    else skipOrClear(h, ctrl, jobs);
    return true;
  }
  const l = matchLearned(h.desc, det.learnedAnswers);
  if (l) {
    let op: FillOp | null = null;
    if (isFreeText(h.desc.kind)) op = { type: "text", value: l.answer };
    else if (h.desc.kind === "checkbox") op = { type: "checked", value: /^(true|yes|checked)$/i.test(l.answer) };
    else if (h.desc.options) {
      const idx = localMatchAll(l.answer, h.desc.options);
      if (idx) op = { type: "options", texts: idx.map((i) => h.desc.options![i]) };
    } else op = { type: "intended", answer: l.answer };
    if (op) {
      usedLearned.push(l.id);
      jobs.push(doFill(h, op, "filled", "Saved answer", ctrl));
      return true;
    }
  }
  return false;
}

/** A mapping decision applied to its field; an essay to draft is added to `essays`. */
function applyDecision(
  h: FieldHandle,
  d: Decision,
  groupId: string,
  ctrl: AbortController,
  jobs: Promise<void>[],
  essays: EssayItem[],
  /** Fill this field: the user asked for an answer here, so it is drafted whatever Draft essays says. */
  asked = false,
) {
  const suggestion = d.suggestion ? `Suggested: ${d.suggestion}` : undefined;
  if (d.action === "fill" && h.desc.kind === "file" && d.documentId === TAILOR_PLACEHOLDER)
    jobs.push(tailoredUpload(h, groupId, ctrl));
  else if (d.action === "fill") {
    const op = opFromDecision(h, d);
    if (op) jobs.push(doFill(h, op, "ai", (d.sources ?? []).join(", ") || "AI", ctrl));
    else setStatus(h, "needs", d.note ?? "No usable AI answer", suggestion);
  } else if (
    d.action === "essay" ||
    // "Write optional cover letters" covers a cover-letter box the AI would leave empty.
    (d.action === "skip" &&
      config.settings.coverLetterPdfs &&
      (h.desc.kind === "textarea" || h.desc.kind === "contenteditable") &&
      RE_COVER_LETTER.test(h.desc.label))
  ) {
    if (config.settings.draftEssays || asked) essays.push(essayItem(h));
    else setStatus(h, "needs", "Write this yourself");
  } else if (d.action === "consent") handleConsent(h, d, ctrl, jobs);
  else if (d.action === "skip") skipOrClear(h, ctrl, jobs);
  else setStatus(h, "needs", d.note ?? "AI could not answer", suggestion);
}

function essayItem(h: FieldHandle): EssayItem {
  const limits = parseEssayLimits(h.desc.label, h.desc.hint, h.desc.maxLength);
  const kind = RE_COVER_LETTER.test(h.desc.label) ? "cover_letter" : "essay";
  return { fieldId: h.id, question: h.desc.label, hint: h.desc.hint, ...limits, kind };
}

async function runPipeline(opts: { rerun?: boolean; depth?: number; round?: number } = {}) {
  if (running) {
    queued = { rerun: !!opts.rerun || !!queued?.rerun };
    return;
  }
  // A new trigger (not a follow-up pass of one): the review may correct each field afresh.
  if (opts.depth === undefined && opts.round === undefined) reviewTries.clear();
  running = true;
  haltFill(false);
  lastError = null;
  clearTimeout(retryTimer);
  const ctrl = new AbortController();
  const groupId = crypto.randomUUID();
  current = { groupId, ctrl };
  const t0 = performance.now();
  timings = [];
  const mark = (k: string) => timings.push([k, Math.round(performance.now() - t0)]);
  const jobs: Promise<void>[] = [];
  try {
    config = await send({ type: "GET_RUNTIME_CONFIG", yolo });
    if (!config.excluded && !config.settings.excludedHosts.includes(HOST)) listen();
    // No résumé for the chosen upload mode: nothing is filled, rather than an application without the right résumé.
    const noResume = resumeProblem(
      config.settings.resumeUpload,
      config.documentsIndex,
      config.tailorReady,
      yolo ? "YOLO" : "Autofill",
    );
    if (noResume) {
      lastError = { kind: "other", message: noResume };
      if (yolo) yoloFatal = noResume;
      return;
    }
    document.dispatchEvent(new Event("autoapply-fill-start")); // see pageTimers.ts
    setBadgesVisible(config.settings.showBadges);
    report(); // running: the top frame waits for us while we reveal
    if (!TOP && !IN_HOST && rescan().length) await revealFrame();
    await expandSections(ctrl.signal);
    if (yolo) await trimEntries(config.entryCounts, oursIn, ctrl.signal);
    unsaved.push(...(await addEntries(config.entryCounts, ctrl.signal)));
    unsaved.push(...(await editInvalidEntries(ctrl.signal)));
    const all = rescan();
    mark("scan");
    const targets = all.filter((h) => {
      const s = states.get(h.id);
      if (s?.userOwned) return false;
      if (!s || s.status === "pending") return true;
      // A YOLO pass re-tries only what it couldn't fill: its guesses ("check") stand, unless the page emptied them (a
      // province guessed from the states listed before the country changed).
      if (!opts.rerun) return false;
      if (!yolo) return ["needs", "failed", "check"].includes(s.status);
      return ["needs", "failed"].includes(s.status) || (s.status === "check" && !readValue(h));
    });
    for (const h of targets) setStatus(h, "pending");
    report();

    await shareJobContext();
    const mode = config.settings.resumeUpload;
    await pickResumeVariant();
    // AI tailor starts now, alongside the rest of the fill, and only for a page asking for the résumé (YOLO: any
    // page of the application it committed to), so no tokens go to forms that never upload one.
    tailoring = mode === "tailor" && (yolo || targets.some(isResumeUpload)) ? requestTailoring(groupId) : null;
    sendPay(false);

    // PHASE A: deterministic and learned answers — no network to Gemini.
    const det = config.profileSnapshotForDeterministic;
    const usedLearned: string[] = [];
    const pending: FieldHandle[] = [];
    const cityField = all.some((h) => RE_CITY_FIELD.test(h.desc.label));
    const env = { det, cityField, usedLearned, ctrl, jobs, groupId };
    for (const h of targets) if (!localFill(h, env)) pending.push(h);
    if (usedLearned.length) void send({ type: "LEARNED_USED", ids: usedLearned }).catch(() => undefined);
    mark("phaseA");

    // PHASE B: batched mapping calls (chunked in the background). Dropdowns with unknown options are harvested
    // first and mapped in a second call, so the AI picks from the real options instead of guessing blind.
    if (pending.length && !ctrl.signal.aborted) {
      for (const h of pending) setStatus(h, "working");
      // Required ones first: SpaceX's 15th, "Citizenship Status", answered blind as "Citizen", got "U.S. citizen".
      const toHarvest = pending
        // A UI5 box lists its options from its arrow, though it reads as a search box: read first like a dropdown's
        // (SuccessFactors' Status answered blind as "Currently Enrolled", "In Progress", "Current": none an option).
        .filter(
          (h) => (h.desc.kind === "dropdown" || (h.desc.kind === "typeahead" && !!ui5Host(h))) && !h.desc.optionsKnown,
        )
        .sort((a, b) => Number(b.desc.required) - Number(a.desc.required));
      const later = new Set(toHarvest);
      const now = pending.filter((h) => !later.has(h));
      // Mapped 15 at a time, so the first answers don't wait for a long form's last lists. All are read: past a
      // cap of 15, Riot's last 4 required questions were answered blind.
      const harvestThenMap = async () => {
        const maps: Promise<void>[] = [];
        for (let i = 0; i < toHarvest.length; i += 15) {
          const chunk = toHarvest.slice(i, i + 15);
          for (const h of chunk)
            await serial(async () => {
              if (ctrl.signal.aborted || harvested.has(h.id)) return;
              const opts = await harvestOptions(h, 400);
              if (opts) harvested.set(h.id, opts);
            });
          const fields = chunk.map((h) => {
            const options = harvested.get(h.id);
            return options ? { ...h.desc, options, optionsKnown: true } : h.desc;
          });
          // Late-discovered consent choices use Behaviour only when Profile does not own the question.
          const consents = new Set(fields.filter((f) => isConsent(f) || profileConsent(f)).map((f) => f.id));
          for (const h of chunk) if (consents.has(h.id)) handleConsent(h, undefined, ctrl, jobs);
          maps.push(
            mapAndApply(
              chunk.filter((h) => !consents.has(h.id)),
              fields.filter((f) => !consents.has(f.id)),
            ),
          );
        }
        await Promise.all(maps);
      };
      const mapAndApply = async (hs: FieldHandle[], fields: FieldDescriptor[]) => {
        if (!hs.length || ctrl.signal.aborted) return;
        const uploads = [...handles.values()].flatMap((h) => (h.desc.kind === "file" ? [h.desc.label] : []));
        const res = await send({
          type: "MAP_FIELDS",
          fields,
          host: HOST,
          groupId,
          yolo,
          ...(uploads.length ? { uploads } : {}),
        });
        if (isErr(res)) {
          if (lastError?.kind !== "allKeysExhausted") lastError = res.error;
          for (const h of hs) setStatus(h, "needs", res.error.message);
          return;
        }
        if (ctrl.signal.aborted) return;
        usedModel = res.usedModel;
        const essays: EssayItem[] = [];
        for (const d of res.decisions) {
          const h = handles.get(d.fieldId);
          if (h && !states.get(h.id)?.userOwned) applyDecision(h, d, groupId, ctrl, jobs, essays);
        }
        // Drafted now, not after the other mapping calls: an essay needs nothing from them.
        if (essays.length) jobs.push(draftEssays(essays, groupId, ctrl, mark));
      };
      const fieldsNow = now.map((h) => h.desc);
      await Promise.all([mapAndApply(now, fieldsNow), harvestThenMap()]);
      mark("map");
    }
    await Promise.all(jobs);
    // YOLO starts tailoring before finding an upload box; its usage limit must still stop this page.
    if (tailoring) await tailoring;
    mark("done");
    // Résumé parsers (SmartRecruiters) re-render the form, emptying fields filled before: re-apply those answers.
    // Answers can also reveal follow-up questions (Greenhouse: Hispanic/Latino "No" → race): fill them in another pass.
    const depth = opts.depth ?? 0;
    if (!ctrl.signal.aborted && depth < 2) {
      await transitionsEnd();
      const fresh = rescan();
      await Promise.all(fresh.filter(emptied).map((h) => doFill(h, ...applied.get(h.id)!, ctrl)));
      if (fresh.some((h) => !states.has(h.id))) queued ??= { rerun: false, depth: depth + 1, round: opts.round };
    }
    // The AI review (content/review): the page as shown, read once nothing more is queued for this trigger.
    if (!queued && !ctrl.signal.aborted && !lastError && config.settings.reviewFills)
      for (let round = opts.round ?? 0; round < MAX_REVIEW_ROUNDS && !ctrl.signal.aborted; round++) {
        const r = await reviewPage(groupId, ctrl);
        mark(`review${round + 1}`);
        // New fields (adopted, revealed, or follow-ups the corrections showed): a pass fills them, then reviews.
        if (r === "fresh") {
          queued ??= { rerun: false, round: round + 1 };
          break;
        }
        if (r !== "changed") break;
      }
    // Entry editors we opened (SmartRecruiters' Experience) are saved once nothing more will be filled in them.
    if (!queued && !ctrl.signal.aborted && unsaved.length) await saveEntries(unsaved.splice(0));
  } catch (e) {
    if (lastError?.kind !== "allKeysExhausted")
      lastError = { kind: "other", message: (e as Error)?.message ?? String(e) };
  } finally {
    // A stopped widget can reject while other fill jobs are unwinding. Finish them before another fill starts.
    if (ctrl.signal.aborted) await Promise.allSettled(jobs);
    running = false;
    haltFill(false);
    document.dispatchEvent(new Event("autoapply-fill-end"));
    current = null;
    report();
    // Child frames report their fields ~250 ms after the trigger; give them time before calling the page empty.
    if (TOP && !IN_HOST && !states.size)
      setTimeout(() => {
        noForm = true;
        renderOverlay();
      }, 1000);
    if (queued) {
      const q = queued;
      queued = null;
      void runPipeline(q);
    }
  }
}

// ---------- the AI review (./review, background/services/reviewForm.ts) ----------
/** A choice group whose picked option the page doesn't mark (pills without aria state or a checked box). */
const stateHidden = (h: FieldHandle) =>
  !!h.buttonStyle &&
  !(h.members ?? []).some(
    (m) =>
      m instanceof HTMLInputElement || ["aria-checked", "aria-pressed", "aria-selected"].some((a) => m.hasAttribute(a)),
  );

/** A field as the review sees it: what it asks, what the page shows, where the answer came from, if it's ours to change. */
function reviewField(h: FieldHandle): ReviewField {
  const s = states.get(h.id);
  const options = h.desc.options ?? harvested.get(h.id);
  const shown = readValue(h);
  const locked =
    !!s?.userOwned ||
    ["you", "saved", "edited", "draft"].includes(s?.status ?? "") ||
    h.sensitive ||
    h.consent ||
    profileConsent({ ...h.desc, options }) ||
    (!!options && isConsent({ ...h.desc, options })) ||
    RE_POLICY_NOTE.test(s?.note ?? "") ||
    screened.has(h.id) ||
    (h.desc.kind === "file" && (!!shown || s?.status === "filled"));
  return {
    id: h.id,
    question: h.desc.label,
    kind: h.desc.kind,
    required: h.desc.required,
    ...(h.desc.section ? { section: h.desc.section } : {}),
    ...(h.desc.hint ? { hint: clip(h.desc.hint, 300) } : {}),
    ...(h.desc.placeholder ? { placeholder: h.desc.placeholder } : {}),
    ...(h.desc.maxLength ? { maxLength: h.desc.maxLength } : {}),
    ...(options ? { options: options.slice(0, 80) } : {}),
    ...(h.desc.multiple ? { multiple: true } : {}),
    shown: clip(shown, 600),
    status: s?.status ?? "new",
    ...(s?.tooltip ? { source: clip(s.tooltip, 200) } : {}),
    ...(s?.note ? { note: clip(s.note, 200) } : {}),
    ...(locked ? { locked: true } : {}),
  };
}

/** A file the review says is missing: the same résumé or cover letter a fill would upload. */
function reviewUpload(h: FieldHandle, groupId: string, ctrl: AbortController, why: string): Promise<void> | undefined {
  if (isResumeUpload(h) && config.settings.resumeUpload === "tailor") return tailoredUpload(h, groupId, ctrl);
  const doc = primaryDocFor(h);
  if (doc) return doFill(h, { type: "file", documentId: doc }, "filled", why, ctrl);
  if (doc === undefined && wantsPortfolioPdf(h)) return portfolioUpload(h, ctrl);
  setStatus(h, "needs", why);
}

/**
 * One review round: the page as text and the fields on it to the AI, then its verdicts applied. "fresh": fields
 * appeared (adopted, revealed or shown by a correction) for a fill pass; "changed": answers were corrected, for
 * another round to check; "none": nothing to do. Ordinary AI errors leave the fills as they are; usage limits stop.
 */
/** The page as text (./review/snapshot.ts) with the fields shown on it, for the review and YOLO's navigator. */
function pageSnapshot() {
  const shown = rescan().filter((h) => h.el.isConnected && (h.desc.kind === "file" || isVisible(h.container ?? h.el)));
  const owner = new Map<Element, string>();
  for (const h of shown)
    for (const e of [h.el, ...(h.members ?? []), h.searchInput, ...(h.sections ?? [])]) if (e) owner.set(e, h.id);
  const snap = snapshot({
    fieldOf: (el) => owner.get(el),
    shown: (id) => {
      const h = handles.get(id);
      return h ? readValue(h) : "";
    },
    excluded: (el) => scanState.excluded.get(el),
    unknownState: (id) => {
      const h = handles.get(id);
      if (!h || !stateHidden(h)) return undefined;
      const a = applied.get(id);
      return a ? opText(a[0]) : "";
    },
  });
  return { shown, owner, snap };
}

async function reviewPage(groupId: string, ctrl: AbortController): Promise<"none" | "changed" | "fresh"> {
  reviewing = true;
  report();
  try {
    await transitionsEnd();
    const { shown, owner, snap } = pageSnapshot();
    if (!shown.length && !snap.unscanned.length) return "none";
    const req = { page: snap.text, fields: shown.map(reviewField) };
    const key = JSON.stringify(req);
    const r = lastReview?.key === key ? lastReview.r : await send({ type: "REVIEW_FORM", ...req, groupId, yolo });
    if (!isErr(r)) lastReview = { key, r };
    if (ctrl.signal.aborted) return "none";
    if (isErr(r)) {
      if (config.settings.debugLogging) console.warn("[AutoApply] review failed:", r.error.message);
      return "none";
    }
    let changed = false;
    const jobs: Promise<void>[] = [];
    const essays: EssayItem[] = [];
    for (const fix of r.fixes) {
      const h = handles.get(fix.fieldId);
      const s = h && states.get(h.id);
      if (!h || s?.userOwned) continue;
      let relabeled = false;
      if (fix.verdict === "relabel" && fix.question && fix.question !== h.desc.label) {
        scanState.relabeled.set(h.el, fix.question);
        h.desc.label = fix.question;
        relabeled = true;
      }
      const why = `Review: ${fix.reason || "corrected"}`;
      const suggestion = fix.answer ? `Suggested: ${fix.answer}` : undefined;
      if (fix.verdict === "needs_user") {
        // YOLO keeps its answer rather than a blank; a fill shows the user what the review doubts.
        if (yolo && readValue(h)) continue;
        setStatus(h, readValue(h) ? "check" : "needs", why, suggestion);
        continue;
      }
      if (fix.answer === undefined) continue;
      // What the page held before the fill may be the user's own: suggested, not overwritten (Overwrite pre-filled).
      if (!yolo && s?.status === "prefilled" && !config.settings.overwritePrefilled) {
        setStatus(h, "check", why, suggestion);
        continue;
      }
      const tries = (reviewTries.get(h.id) ?? 0) + 1;
      reviewTries.set(h.id, tries);
      if (tries > 2) {
        // YOLO keeps what the field holds: the review never ends a run the first pass would have sent.
        const left = `The page didn't take the review's answer (${fix.reason || "corrected"})`;
        setStatus(h, yolo && readValue(h) ? "check" : "needs", left, suggestion);
        continue;
      }
      changed ||= relabeled;
      if (h.desc.kind === "file") {
        const upload = reviewUpload(h, groupId, ctrl, why);
        if (upload) {
          changed = true;
          jobs.push(upload);
        }
        continue;
      }
      // Prose is the essay writer's (its rules against AI-sounding text, the question's limits), not the review's.
      // Screening quantities are fills, never essays (shared/screening.ts).
      const screening = fix.sources.includes(SCREENING_SOURCE);
      if (!screening && (h.desc.kind === "textarea" || h.desc.kind === "contenteditable") && fix.answer.length > 200) {
        if (!config.settings.draftEssays) {
          setStatus(h, "needs", "Write this yourself");
          continue;
        }
        const limits = parseEssayLimits(h.desc.label, h.desc.hint, h.desc.maxLength);
        const kind = RE_COVER_LETTER.test(h.desc.label) ? "cover_letter" : "essay";
        changed = true;
        essays.push({ fieldId: h.id, question: h.desc.label, hint: h.desc.hint, ...limits, kind });
        continue;
      }
      // A custom list read before the answer it now needs was there (provinces before the country): read it again.
      const read = harvested.get(h.id);
      if (h.desc.kind === "dropdown" && read && !read.some((o) => normalize(o) === normalize(fix.answer!)))
        harvested.delete(h.id);
      const op = opForAnswer(h, fix.answer, h.desc.options ?? harvested.get(h.id));
      if (!op) {
        setStatus(h, "needs", why, suggestion);
        continue;
      }
      // A YOLO best guess, or an answer the screening policy permits, is logged and badged like the mapping's.
      const tooltip = screening ? SCREENING_SOURCE : yolo && fix.sources.includes("guess") ? "guess" : why;
      // An attempted write still needs checking: even a failed widget can change the page or reveal questions.
      changed = true;
      jobs.push(doFill(h, op, "ai", tooltip, ctrl));
    }
    if (essays.length) jobs.push(draftEssays(essays, groupId, ctrl, () => undefined));
    await Promise.all(jobs);
    let found = false;
    for (const m of r.missed) {
      const a = adoption(m, snap.refs, (el) => scanState.excluded.get(el));
      if (!a || owner.has(a[0]) || scanState.adopted.has(a[0])) continue;
      scanState.adopted.set(a[0], a[1]);
      found = true;
    }
    for (const ref of r.reveal.slice(0, 5)) {
      const el = snap.refs.get(ref);
      if (!revealable(el) || revealed.has(el)) continue;
      revealed.add(el);
      dispatching(() => el.click());
      found = true;
      await sleep(600);
    }
    if (changed || found) {
      await transitionsEnd();
      if (rescan().some((h) => !states.has(h.id))) return "fresh";
    }
    return changed ? "changed" : "none";
  } finally {
    reviewing = false;
    report();
  }
}

const requestTailoring = (groupId: string, fresh = false): Promise<Responses["TAILOR_RESUME"]> =>
  send({ type: "TAILOR_RESUME", groupId, ...(fresh && { fresh }) }).catch((e: Error) => ({
    error: { kind: "other", message: e.message },
  }));

/**
 * AI tailor: the résumé tailored for this job, uploaded once it is ready, so other fields fill meanwhile and this one
 * comes last. Any tailoring failure has the background answer with the untailored résumé instead.
 */
async function tailoredUpload(h: FieldHandle, groupId: string, ctrl: AbortController) {
  setStatus(h, "working", "Tailoring your résumé…");
  const r = await (tailoring ??= requestTailoring(groupId));
  if (ctrl.signal.aborted || states.get(h.id)?.userOwned) return;
  if (isErr(r)) {
    regen.set(h.id, { kind: "resume", note: r.error.message });
    return setStatus(h, "needs", r.error.message);
  }
  if (!config.documentsIndex.some((d) => d.id === r.meta.id))
    config.documentsIndex = [...config.documentsIndex, r.meta];
  if (r.tailored) {
    regen.delete(h.id);
    aiDocs.add(r.meta.id);
  } else regen.set(h.id, { kind: "resume", note: `Untailored résumé used: ${r.note}` });
  const tooltip = r.tailored ? `AI-tailored résumé (${r.note})` : `Untailored résumé (${r.note})`;
  await doFill(h, { type: "file", documentId: r.meta.id }, "filled", tooltip, ctrl);
}

/** A cover-letter upload with none in Documents gets one written for this job (always for YOLO's required ones). */
async function coverLetter(h: FieldHandle, ctrl: AbortController) {
  setStatus(h, "working", "Drafting a cover letter…");
  const r = await send({ type: "COVER_LETTER_PDF", question: h.desc.label });
  if (isErr(r)) {
    regen.set(h.id, { kind: "cover_letter", note: r.error.message });
    return setStatus(h, "needs", r.error.message);
  }
  if (ctrl.signal.aborted) return;
  config.documentsIndex = [...config.documentsIndex, r.meta];
  regen.delete(h.id);
  aiDocs.add(r.meta.id);
  guesses.set(h.id, { q: h.desc.label, a: "A cover letter written for this job" });
  await doFill(h, { type: "file", documentId: r.meta.id }, "draft", "Generated cover letter", ctrl);
}

/**
 * A required upload for a portfolio or work samples, with nothing in Documents but résumés and cover letters: a PDF of
 * the Profile's portfolio link goes in. Optional ones, and pages where the user keeps other documents, go on to the AI
 * as before.
 */
const wantsPortfolioPdf = (h: FieldHandle) =>
  h.desc.required &&
  isPortfolioUpload(h) &&
  !!portfolioLink(config.profileSnapshotForDeterministic.personal.links) &&
  // Its own earlier PDFs (yolo- ids) aren't the user's documents.
  !config.documentsIndex.some((d) => d.kind === "other" && !d.id.startsWith("yolo-"));

async function portfolioUpload(h: FieldHandle, ctrl: AbortController) {
  setStatus(h, "working", "Making a PDF of your portfolio link…");
  const r = await send({ type: "PORTFOLIO_PDF" });
  if (ctrl.signal.aborted || states.get(h.id)?.userOwned) return;
  if (isErr(r)) return setStatus(h, "needs", r.error.message);
  if (!config.documentsIndex.some((d) => d.id === r.meta.id))
    config.documentsIndex = [...config.documentsIndex, r.meta];
  await doFill(h, { type: "file", documentId: r.meta.id }, "filled", "Your portfolio link, as a PDF", ctrl);
}

/** The overlay's Regenerate: the failed résumé tailoring or cover letter tried again, outside a fill so Stop ends it. */
async function regenerate(id: string) {
  const h = handles.get(id);
  const r = regen.get(id);
  if (!h || !r || running) return;
  haltFill(false);
  lastError = null;
  clearTimeout(retryTimer);
  const me = (current = { groupId: crypto.randomUUID(), ctrl: new AbortController() });
  try {
    if (r.kind === "cover_letter") await coverLetter(h, me.ctrl);
    else {
      tailoring = requestTailoring(me.groupId, true);
      await tailoredUpload(h, me.groupId, me.ctrl);
    }
  } finally {
    if (current === me) current = null;
  }
}

async function draftEssays(items: EssayItem[], groupId: string, ctrl: AbortController, mark: (k: string) => void) {
  for (const i of items) setStatus(handles.get(i.fieldId)!, "working", "Drafting…");
  const r = await send({ type: "DRAFT_ESSAYS", items, groupId });
  if (isErr(r)) {
    for (const i of items) setStatus(handles.get(i.fieldId)!, "needs", r.error.message);
    return;
  }
  await Promise.all(
    r.essays.map(async (e) => {
      const h = handles.get(e.fieldId);
      if (!h || states.get(h.id)?.userOwned || ctrl.signal.aborted) return;
      if (!e.text) return setStatus(h, "needs", e.note ?? "No draft");
      const fr = await fill(
        h,
        { type: "text", value: e.text },
        {
          documents: [],
          getDocument: async () => null,
          choose,
          checkedByUs,
          harvested,
          signal: ctrl.signal,
        },
      );
      if (states.get(h.id)?.userOwned) return;
      if (fr.outcome === "ok") {
        essayed.add(h.id);
        setStatus(h, "draft", "AI draft – review", `${wordCount(e.text)} words`);
      } else if (ctrl.signal.aborted) setStatus(h, "needs", "Stopped");
      else setStatus(h, fr.outcome === "mismatch" ? "check" : "failed", fr.note);
    }),
  );
  mark("essays");
}

/** Every AI step stops the same way on exhausted usage, preserving the warning while cancelled work unwinds. */
function rateLimited(err: ApiError, broadcast = true) {
  if (err.kind !== "allKeysExhausted") return;
  if (lastError?.kind === "allKeysExhausted") return;
  lastError = err;
  queued = null;
  clearTimeout(retryTimer);
  haltFill(true);
  if (current && !current.ctrl.signal.aborted) {
    current.ctrl.abort();
    void sendMessage({ type: "ABORT", groupId: current.groupId }).catch(() => undefined);
  }
  for (const [id, s] of states) if (s.status === "working") setStatus(handles.get(id)!, "needs", err.message);
  report();
  if (broadcast) void sendMessage({ type: "BROADCAST_STOP", error: err }).catch(() => undefined);
  if (!yolo) scheduleAutoRetry(err);
}

function scheduleAutoRetry(err: ApiError) {
  if (!TOP || err.kind !== "allKeysExhausted" || !err.earliestRetryAt) return;
  const wait = err.earliestRetryAt - Date.now();
  if (wait > 0 && wait <= 90_000)
    retryTimer = setTimeout(() => void sendMessage({ type: "BROADCAST_FILL", rerun: true }), wait + 250);
}

// ---------- user edits & learning (§12 cancellation, §16.3) ----------
function handleFor(t: EventTarget | null): FieldHandle | null {
  if (!(t instanceof Node)) return null;
  for (const h of handles.values())
    if (
      h.el.contains(t) ||
      h.members?.some((m) => m === t || m.contains(t) || (m as HTMLInputElement).labels?.[0]?.contains(t))
    )
      return h;
  return null;
}

function onUserInput(e: Event) {
  if (!e.isTrusted || isFilling()) return;
  const h = handleFor(e.composedPath()[0] ?? e.target);
  if (!h) return;
  const s = states.get(h.id) ?? { status: "pending" as Status };
  s.userOwned = true;
  states.set(h.id, s);
  if (s.status === "ai" || s.status === "filled" || s.status === "check" || s.status === "draft") {
    s.learnable = s.status !== "draft";
    setStatus(h, "edited");
  }
}

function offerLearn(h: FieldHandle, title?: string) {
  const answer = readValue(h);
  if (!answer) return;
  showLearnPrompt(
    h.container,
    h.desc.label,
    answer,
    async () => {
      await send({
        type: "SAVE_LEARNED_ANSWER",
        answer: { question: h.desc.label, kind: h.desc.kind, options: h.desc.options, answer, host: HOST },
      });
      setStatus(h, "saved", "Saved for future applications");
    },
    title,
  );
}

function onUserCommit(e: Event) {
  if (!e.isTrusted || isFilling()) return;
  const h = handleFor(e.composedPath()[0] ?? e.target);
  if (!h) return;
  // Choice clicks (radios, pill buttons, dropdown options) settle after the page's own handlers run.
  setTimeout(() => {
    const s = states.get(h.id);
    if (!s || s.status === "working") return;
    const value = readValue(h);
    if (value === (s.value ?? "")) return;
    s.userOwned = true;
    if (s.status === "ai" || s.status === "filled" || s.status === "check") {
      s.learnable = true;
      setStatus(h, "edited");
    } else if (s.status === "draft") setStatus(h, "edited");
    else s.value = value;
    if (!value) return;
    if (s.status === "needs" || s.status === "failed") setStatus(h, "you", "You answered this");
    if (config.settings.learnPrompts && s.learnable && h.desc.kind !== "file") offerLearn(h);
  }, 50);
}

// ---------- Fill this field (ui/fieldPrompt.ts) ----------
/** What the user last right-clicked, for the menu's Fill with AutoApply. */
let contextTarget: Element | null = null;
/** Fields answered with an essay draft: an instruction for one revises the draft, with no mapping call first. */
const essayed = new Set<string>();

/** The focused element, through open shadow roots; null when another frame (or our own card) has the focus. */
function focusedElement(): Element | null {
  if (!document.hasFocus()) return null;
  let a = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  if (!a || a === document.body || a instanceof HTMLIFrameElement || a.localName === "frame") return null;
  return a.localName === HOST_TAG ? null : a;
}

/** The field at `t`: its control, or a question box holding that field alone (a right-click on the label). */
function fieldAt(t: Element): FieldHandle | null {
  const all = [...handles.values()].filter((h) => h.el.isConnected);
  return (
    handleFor(t) ??
    all.find(
      (h) => composedContains(h.container, t) && !all.some((o) => o !== h && composedContains(h.container, o.el)),
    ) ??
    null
  );
}

function pickField(via: "menu" | "key") {
  if (yolo) return;
  const t = via === "menu" ? contextTarget : focusedElement();
  if (!t?.isConnected) return; // the shortcut reaches every frame; the focused one answers
  rescan();
  const h = fieldAt(t);
  if (!h) {
    const why = scanState.excluded.get(t);
    return showFieldPrompt(
      t,
      "",
      undefined,
      why ? `AutoApply doesn't fill this field (${why}).` : "No form field AutoApply can fill here.",
    );
  }
  showFieldPrompt(badgeTarget(h), h.desc.label, (instruction) => fillOne(h, instruction));
}

const OUTCOME: Partial<Record<Status, string>> = {
  filled: "Filled",
  ai: "Filled by AI",
  draft: "AI draft written. Review it before you submit.",
  check: "Filled. Check this answer.",
  prefilled: "Left as it was",
  skipped: "Left blank: it doesn't apply to you",
  needs: "Needs you",
  failed: "Couldn't fill this field",
};

/**
 * The one field the user picked, filled now. No instruction: as a fill of the page would (profile and saved answers
 * first, else the AI), over what it holds. An instruction: the AI answers as told, revising the current answer.
 */
async function fillOne(h: FieldHandle, instruction: string): Promise<string> {
  if (running || current) return "AutoApply is busy on this page. Try again when it's done.";
  haltFill(false);
  lastError = null as ApiError | null; // read again after the awaits below set it
  clearTimeout(retryTimer);
  const me = (current = { groupId: crypto.randomUUID(), ctrl: new AbortController() });
  const { groupId, ctrl } = me;
  const jobs: Promise<void>[] = [];
  try {
    config = await send({ type: "GET_RUNTIME_CONFIG", yolo });
    if (!config.excluded && !config.settings.excludedHosts.includes(HOST)) listen();
    setBadgesVisible(config.settings.showBadges);
    const det = config.profileSnapshotForDeterministic;
    const s = states.get(h.id);
    if (s) s.userOwned = false; // the user handed it back
    // Never sent to the AI, whatever the instruction: ID and card numbers are the user's to type.
    if (h.sensitive && (instruction || !sinAnswer(h.desc, det.hasSin, det.noCanadianPermitNeeded))) {
      setStatus(h, "needs", "Sensitive – fill manually");
      return "AutoApply never fills ID or card numbers. Fill this one yourself.";
    }
    setStatus(h, "working");
    await shareJobContext();
    if (h.desc.kind === "file") await pickResumeVariant();
    const env = {
      det,
      cityField: [...handles.values()].some((o) => RE_CITY_FIELD.test(o.desc.label)),
      usedLearned: [] as string[],
      ctrl,
      jobs,
      groupId,
      force: true,
    };
    if (!instruction && localFill(h, env)) {
      if (env.usedLearned.length) void send({ type: "LEARNED_USED", ids: env.usedLearned }).catch(() => undefined);
    } else await aiFillOne(h, instruction, groupId, ctrl, jobs);
    await Promise.all(jobs);
  } catch (e) {
    if (lastError?.kind !== "allKeysExhausted")
      lastError = { kind: "other", message: (e as Error)?.message ?? String(e) };
  } finally {
    if (ctrl.signal.aborted) await Promise.allSettled(jobs);
    haltFill(false);
    if (current === me) current = null;
    report();
  }
  if (lastError) return lastError.message;
  const st = states.get(h.id);
  if (!st || st.status === "working" || st.status === "pending") return "Stopped";
  return [OUTCOME[st.status] ?? "Done", st.note].filter(Boolean).join(": ");
}

async function aiFillOne(
  h: FieldHandle,
  instruction: string,
  groupId: string,
  ctrl: AbortController,
  jobs: Promise<void>[],
) {
  const now = instruction ? clip(readValue(h), 4000) : "";
  const essays: EssayItem[] = [];
  // Revising a draft: straight to the essay writer, with the text as it stands.
  if (instruction && now && essayed.has(h.id) && isFreeText(h.desc.kind)) essays.push(essayItem(h));
  else {
    if (
      (h.desc.kind === "dropdown" || (h.desc.kind === "typeahead" && !!ui5Host(h))) &&
      !h.desc.optionsKnown &&
      !harvested.has(h.id)
    )
      await serial(async () => {
        const opts = await harvestOptions(h, 400);
        if (opts) harvested.set(h.id, opts);
      });
    if (ctrl.signal.aborted) return;
    const options = harvested.get(h.id);
    // A fresh answer, not one kept because the box shows it; an instruction revises what it shows.
    const { currentValue: _shown, ...desc } = h.desc;
    const field: FieldDescriptor = {
      ...desc,
      ...(options && { options, optionsKnown: true }),
      ...(now && { currentValue: now }),
    };
    // A consent the user gave no words for follows their consent settings, as in a fill of the page.
    if (!instruction && (isConsent(field) || profileConsent(field))) return handleConsent(h, undefined, ctrl, jobs);
    const uploads = [...handles.values()].flatMap((o) => (o.desc.kind === "file" ? [o.desc.label] : []));
    const res = await send({
      type: "MAP_FIELDS",
      fields: [field],
      host: HOST,
      groupId,
      ...(uploads.length ? { uploads } : {}),
      ...(instruction && { instruction }),
    });
    if (isErr(res)) {
      if (lastError?.kind !== "allKeysExhausted") lastError = res.error;
      return setStatus(h, "needs", res.error.message);
    }
    if (ctrl.signal.aborted) return;
    usedModel = res.usedModel;
    const d = res.decisions.find((x) => x.fieldId === h.id);
    if (!d) return setStatus(h, "needs", "No AI answer");
    applyDecision(h, d, groupId, ctrl, jobs, essays, true);
  }
  if (instruction) for (const e of essays) Object.assign(e, { instruction, ...(now && { current: now }) });
  if (essays.length) await draftEssays(essays, groupId, ctrl, () => undefined);
}

// ---------- YOLO (./yolo/driver.ts) ----------
/** Required fields still without an answer on the page. */
function unfilledRequired(): FieldHandle[] {
  return [...handles.values()].filter((h) => {
    if (!h.desc.required || !h.el.isConnected || !isVisible(h.container ?? h.el)) return false;
    const s = states.get(h.id)?.status;
    // An uploader empties its file input once it has taken the file (SmartRecruiters): its status says it's done.
    if (s === "needs" || s === "failed") return true;
    // So does one that held its file when scanned (iCIMS, after parsing the résumé).
    return s !== "skipped" && !(h.desc.kind === "file" && (s === "filled" || h.prefilled)) && !readValue(h);
  });
}

async function yoloFill(): Promise<FillReport> {
  yoloFatal = undefined;
  for (let pass = 0; pass < 4; pass++) {
    await runPipeline({ rerun: true });
    while (running || queued) await sleep(100);
    if (lastError?.kind === "allKeysExhausted") {
      // Stop the application now; the coordinator keeps it queued until usage is available again.
      clearTimeout(retryTimer);
      return {
        unfilled: [],
        retryAt: lastError.earliestRetryAt ?? nextMidnightPacific(),
        limitMessage: lastError.message,
      };
    }
    if (yoloFatal) return { unfilled: [], fatal: yoloFatal };
    if (!unfilledRequired().length || pass >= 1) break;
  }
  return {
    unfilled: unfilledRequired().map((h) => {
      const note = states.get(h.id)?.note;
      return `${h.desc.label || "(unlabeled field)"}${note ? ` (${note})` : ""}`;
    }),
  };
}

/**
 * Fields the page rejected are answered again, with its message as a hint ("Enter a valid phone number"). The page
 * requires them, marked or not: a form marking only its optional fields had an unanswerable one left blank again.
 */
function refill(errors: HTMLElement[]) {
  for (const h of handles.values()) {
    const box = h.container ?? h.el;
    const e = errors.find((x) => box.contains(x) || x === h.el || h.members?.includes(x));
    const s = states.get(h.id);
    if (!e || !s || s.userOwned) continue;
    s.status = "failed";
    applied.delete(h.id);
    rejected.set(h.id, labelOf(e));
  }
}

/** Every field shown on the page and its answer, blank or not, for the run's log. Keys are per document: a field's id
 * repeats on the next page. */
function answers(): Record<string, Guess> {
  const out: Record<string, Guess> = {};
  for (const h of handles.values()) {
    if (!h.el.isConnected || !isVisible(h.container ?? h.el)) continue;
    const v = (h.el as HTMLInputElement).type === "password" ? "••••" : readValue(h);
    const a = v.length > 300 ? `${v.slice(0, 300)}…` : v || "(blank)";
    out[`${performance.timeOrigin}|${h.id}`] = {
      q: h.desc.label || "(unlabeled field)",
      a: `${a} [${states.get(h.id)?.status ?? "unscanned"}]`,
    };
  }
  return out;
}

/** A posting's place and description from its HTML: one request, nothing rendered. */
const fetchPosting = (url: string) =>
  fetch(url, { credentials: "include", signal: AbortSignal.timeout(5000) })
    .then((r) => (r.ok ? r.text() : ""))
    .then((html) => (html ? ldPosting(new DOMParser().parseFromString(html, "text/html")) : null))
    .catch(() => null);

/** Gives the background a posting's description and pay, for the application's later pages. */
async function sharePosting(doc: Document, loc: Location) {
  const pays = readPay(doc, loc);
  await Promise.all([
    pays && send({ type: "SET_JOB_PAY", pays, passive: false }),
    send({ type: "SET_JOB_CONTEXT", ctx: doc === document ? jobContext() : extractJobContext(doc, loc) }),
  ]).catch(() => undefined);
}

async function startYolo() {
  if (yolo || reviewContext) return;
  yolo = true;
  // Continue YOLO pressed (or the tab adopted): the overlay's waiting note is done with.
  waiting = undefined;
  canContinue = false;
  const restoreTransitions = throttled() ? endTransitions() : () => undefined;
  releaseYolo = () => {
    releaseYolo = () => undefined;
    yolo = false;
    restoreTransitions();
  };
  config = await send({ type: "GET_RUNTIME_CONFIG", yolo: true });
  listen();
  const parked = await drive({
    fieldStats: () => {
      // Nor the fields of a form still collapsed (JazzHR's, until its Apply): file inputs are scanned hidden too.
      const fields = rescan().filter((h) => !RE_SIGNUP_BOX.test(h.desc.section ?? "") && isVisible(h.container));
      return { fields: fields.length, requiredFields: fields.filter((h) => h.desc.required).length };
    },
    fill: yoloFill,
    refill,
    navigate: async (why, facts) => {
      const { snap } = pageSnapshot();
      const r = await send({ type: "NAVIGATE", page: snap.text, facts, url: location.href, why }).catch(() => null);
      if (!r) return null;
      if (isErr(r)) return r.error.kind === "allKeysExhausted" ? r : null;
      return { reply: r, el: r.ref ? snap.refs.get(r.ref) : undefined };
    },
    guesses: () => [...guesses.values()],
    hasGuessedAnswers: () => hasGuessedAnswers,
    handoff: () => releaseYolo(),
    email: () => config.profileSnapshotForDeterministic.personal.email,
    answers,
    debug: config.settings.debugLogging,
    posting: () => sharePosting(document, location),
    readPosting: async (url) => {
      // One request, nothing rendered: the description and pay are in its HTML or JSON-LD.
      const html = await fetch(url, { credentials: "include" })
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
      if (html)
        await sharePosting(new DOMParser().parseFromString(html, "text/html"), new URL(url) as unknown as Location);
    },
  });
  if (reviewContext || parked) releaseYolo();
}

function setWaitingMark(on: boolean) {
  try {
    if (on) sessionStorage.setItem(WAITING_MARK, "1");
    else sessionStorage.removeItem(WAITING_MARK);
  } catch {
    // Storage blocked (a sandboxed page): only this page shows its Continue YOLO.
  }
}

/** The resumed run stuck on this tab: the user finishes the step, then presses Continue YOLO in the overlay. */
function showWaiting(text: string) {
  waiting = `YOLO is waiting on you: ${text}. Finish that part here, then press Continue YOLO.`;
  canContinue = true;
  setWaitingMark(true);
  // Their edits stay theirs when the run fills the page again.
  listen();
  if (config) renderOverlay();
  else
    void send({ type: "GET_RUNTIME_CONFIG" })
      .then((c) => {
        config ??= c;
        renderOverlay();
      })
      .catch(() => undefined);
}

// ---------- the user's own submissions (for "already applied") ----------
let attempted = false;
/** After a fill, the user pressing the form's submit: logged as applied once the page confirms it. */
function onSubmitAttempt(e: Event) {
  if (!e.isTrusted || yolo || attempted || (!states.size && !reviewContext)) return;
  if (e.type === "click" || (reviewContext && e.type === "submit")) {
    const b =
      e.type === "submit"
        ? (e as SubmitEvent).submitter
        : (e.target as Element | null)?.closest?.("button,input[type=submit],[role=button]");
    const t = b instanceof HTMLElement ? labelOf(b) : "";
    if (
      e.type === "click" &&
      (!/submit|apply|send|finish|complete/i.test(t) || /next|continue|save|back|cancel|review/i.test(t))
    )
      return;
    if (e.type === "submit" && /next|continue|save|back|cancel|review/i.test(t)) return;
  }
  attempted = true;
  const ctx = extractJobContext();
  const job = { url: location.href, company: ctx.company, title: ctx.jobTitle || ctx.title };
  void send({ type: "APPLY_ATTEMPT", job }).catch(() => undefined);
  if (RE_APPLIED.test(document.body?.innerText ?? "")) return; // said so already: no proof either way
  void waitFor(() => RE_APPLIED.test(document.body?.innerText ?? "") && location.href, 20_000, false).then(
    (doneUrl) => {
      if (doneUrl) send({ type: "APPLY_ATTEMPT", job, doneUrl }).catch(() => undefined);
      else if (reviewContext) attempted = false;
    },
  );
}

// ---------- messages ----------
function onMessage(msg: Message, _sender: unknown, sendResponse: (r: unknown) => void) {
  switch (msg.type) {
    case "YOLO_REVIEW_CONTEXT":
      reviewContext = { key: msg.key, ready: msg.ready };
      yolo = false;
      listen();
      if (config) renderOverlay();
      else
        void send({ type: "GET_RUNTIME_CONFIG" })
          .then((c) => {
            config = c;
            renderOverlay();
          })
          .catch(() => undefined);
      break;
    case "YOLO_REVIEW_PING":
      sendResponse({ ready: reviewContext?.key === msg.key && reviewContext.ready });
      return false;
    case "STOP_FILL":
      if (msg.error?.kind === "allKeysExhausted") rateLimited(msg.error, false);
      else stop();
      break;
    case "TRIGGER_FILL":
      lastReview = null;
      void runPipeline({ rerun: msg.rerun ?? msg.force });
      break;
    case "FOCUS_FIELD":
      focusField(msg.fieldId);
      break;
    case "REGEN_DOC":
      void regenerate(msg.fieldId);
      break;
    case "TOGGLE_OVERLAY":
      overlay?.toggle();
      break;
    case "PICK_FIELD":
      pickField(msg.via);
      break;
    case "YOLO_ATTACH":
      if (window === window.top) void startYolo();
      break;
    case "YOLO_WAITING":
      if (window !== window.top) break;
      releaseYolo();
      showWaiting(msg.text);
      break;
    case "READ_POSTING":
      // No read of a page that isn't about a job: this runs whenever the page opens a new tab.
      sendResponse(postingContext());
      return false;
    case "READ_JOB_TAB":
      sendResponse(tabJob());
      return false;
    case "FRAME_STATUS":
      if (TOP) {
        childFrames.set(msg.status.frameId, msg.status);
        // A child frame may report before this frame's own fill has the config (the overlay's saved position).
        if (config) renderOverlay();
        else
          send({ type: "GET_RUNTIME_CONFIG" })
            .then((c) => ((config ??= c), renderOverlay()))
            .catch(() => undefined);
      }
      break;
    default:
      return false;
  }
  sendResponse({ ok: true });
  return false;
}

// ---------- bootstrap (§11.1) ----------
/** Shares the pay of the posting on the page; returns whether there is one. */
function sendPay(passive = true): boolean {
  const pays = readPay();
  if (pays) send({ type: "SET_JOB_PAY", pays, passive }).catch(() => undefined);
  return !!pays;
}

/**
 * Reads a posting's pay once it renders (again after a single-page app's navigation), for later application pages.
 * Other addresses cost one URL test: no timer, no DOM read (battery).
 */
function watchPay() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(timer);
    if (jobUrl(location)) timer = setTimeout(() => sendPay() || (timer = setTimeout(sendPay, 4000)), 1500);
  };
  soon();
  window.navigation?.addEventListener("navigatesuccess", soon, { signal: life.signal });
}

async function main() {
  // Injected as the extension reloaded, this context can have no live bindings (chrome.runtime reads undefined):
  // nothing here works, and claiming the frame would evict the instance that does.
  if (!chrome.runtime?.id) return;
  if (!TOP) relayClicksToTop(life.signal); // before the bail-outs: about:blank editor frames are outside clicks too
  if (!/^https?:$/.test(location.protocol) || !document.body) return;
  const g = globalThis as { __autoapply?: boolean };
  if (g.__autoapply) return;
  g.__autoapply = true;
  claimFrame(() => {
    life.abort();
    current?.ctrl.abort(); // no ABORT message: this context's runtime is gone
    queued = null;
    clearTimeout(retryTimer);
  });
  // No message to the background until a fill: waking its service worker on every page load costs battery.
  chrome.runtime.onMessage.addListener(onMessage);
  // Fill with AutoApply (context menu) acts on what was right-clicked, which only the page sees.
  document.addEventListener("contextmenu", (e) => (contextTarget = e.composedPath()[0] as Element), {
    capture: true,
    signal: life.signal,
  });
  watchPay();
  // A YOLO run shares its posting itself (sharePosting).
  if (TOP && !DRIVER_FRAME)
    document.addEventListener(
      "click",
      (e) =>
        yolo ||
        shareOnApply(e, (ctx) => void send({ type: "SET_JOB_CONTEXT", ctx, passive: true }).catch(() => undefined)),
      { capture: true, signal: life.signal },
    );
  if (DRIVER_FRAME) void startYolo();
  // Except a fresh tab, at any address (an employer's form at "forms.acme.com/f/88"): the tab that opened it may show
  // another job by the fill. Only the background knows its opener ("noreferrer" links hide it from the page).
  else if (TOP && history.length === 1) void send({ type: "BORROW_POSTING" }).catch(() => undefined);
  // The user moved a waiting tab on by themselves: its Continue YOLO shows on this page too. One read on other pages.
  // shortcut: a page of another origin has no mark, so it shows only after the notification or Resume; mark in the
  // background (a tabs listener) if users often leave the origin mid-wait.
  if (TOP && !DRIVER_FRAME && hasWaitingMark())
    void send({ type: "YOLO_WAITING_CHECK" })
      .then((r) => (r ? showWaiting(r.text) : setWaitingMark(false)))
      .catch(() => undefined);
}

function hasWaitingMark() {
  try {
    return !!sessionStorage.getItem(WAITING_MARK);
  } catch {
    return false;
  }
}

/** Edit tracking and page timers, from the first fill on a site that isn't excluded (they only act on its fields). */
function listen() {
  if (listening) return;
  listening = true;
  const opts = { capture: true, signal: life.signal };
  document.addEventListener("input", onUserInput, opts);
  for (const ev of ["change", "focusout", "click"]) document.addEventListener(ev, onUserCommit, opts);
  for (const ev of ["submit", "click"]) document.addEventListener(ev, onSubmitAttempt, opts);
  // A page timer set during a fill in a hidden tab (pageTimers.ts): fire it on time.
  document.addEventListener(
    "autoapply-timer",
    (e) => {
      const [id, ms] = String((e as CustomEvent<string>).detail).split(":");
      void sleep(Number(ms)).then(() =>
        document.dispatchEvent(new CustomEvent("autoapply-timer-fire", { detail: id })),
      );
    },
    opts,
  );
}

void main();
