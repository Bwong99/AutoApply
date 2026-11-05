// §14 fill dispatcher: picks the right strategy per kind; dropdowns/typeaheads run strictly one at a time.
import { RE_JOB_BOARD } from "../../shared/constants";
import { normalize } from "../../shared/normalize";
import type { DocumentMeta } from "../../shared/types";
import { localMatch, localMatchAll } from "../match/localMatch";
import type { FieldHandle } from "../scan/fields";
import { nativeOptions } from "../scan/widgets";
import { fillDropdown, harvestOptions, searchOptions } from "./dropdown";
import { holdScroll, sleep, waitFor } from "./events";
import { compatibleDoc, fillFile } from "./file";
import {
  clearValue,
  fillCheckbox,
  fillCheckboxGroup,
  fillContentEditable,
  fillRadio,
  fillSelect,
  fillText,
  type FillResult,
} from "./native";
import { fillTypeahead } from "./typeahead";

export type { FillResult };

export type FillOp =
  | { type: "text"; value: string }
  /** `exact`: these and no others (the review's answer): boxes the page ticked itself are unticked too. */
  | { type: "options"; texts: string[]; exact?: boolean }
  | { type: "intended"; answer: string; query?: string }
  | { type: "checked"; value: boolean }
  | { type: "file"; documentId: string }
  /** Empties a text box or native select. */
  | { type: "clear" };

export interface EngineDeps {
  documents: DocumentMeta[];
  getDocument(id: string): Promise<{ meta: DocumentMeta; base64: string } | null>;
  /** AI fallback (chooseOptions) for options discovered late. */
  choose(h: FieldHandle, intended: string, options: string[]): Promise<number[] | null>;
  checkedByUs: Set<Element>;
  harvested: Map<string, string[]>;
  signal: AbortSignal;
}

const RE_HEARD_Q = /\b(hear|heard|learn(ed)?) (about|of)\b|\bbrought you to\b/i;
/** A list whose label says to take its "Other" when the answer isn't on it. */
const RE_PICK_OTHER = /\b(select|choose|pick)\s+["“']?other\b/i;

// Remote lists can page very slowly (EA skills: 3 options per request); past this, searching beats paging.
const HARVEST_MS = 3000;
let chain: Promise<unknown> = Promise.resolve();

/**
 * Ashby saves each answer in its own request and keeps only the last of overlapping ones (submitting then reports
 * "Missing entry" for answers it showed as given). pageTimers.ts counts its requests in flight on the page; the next
 * fill waits for them.
 */
async function savesDone() {
  const root = document.documentElement;
  if (!root.hasAttribute("data-autoapply-net")) return;
  await sleep(50); // a save may start a moment after the change that causes it
  await waitFor(() => root.getAttribute("data-autoapply-net") === "0", 3000);
}

export function fill(h: FieldHandle, op: FillOp, deps: EngineDeps): Promise<FillResult> {
  const run = () =>
    deps.signal.aborted
      ? Promise.resolve<FillResult>({ outcome: "flag", note: "Stopped" })
      : dispatch(h, op, deps).finally(savesDone);
  // One at a time: every fill moves focus, and a widget left mid-search closes when focus leaves it (Ashby's location
  // emptied while its date picker opened). Text fills take milliseconds, so the queue costs little.
  return serial(run);
}

/** Runs `fn` after every queued fill or harvest (one focus owner and one popup open at a time). */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const held = () => holdScroll(fn);
  const p = chain.then(held, held);
  chain = p.catch(() => undefined);
  return p;
}

const flag = (note: string): FillResult => ({ outcome: "flag", note });
const answerOf = (op: FillOp) =>
  op.type === "intended"
    ? op.answer
    : op.type === "text"
      ? op.value
      : op.type === "options"
        ? op.texts.join(" | ")
        : "";

/** Option texts for an op against a known option list (local, safe matching only). */
function textsFor(op: FillOp, options: string[]): string[] | null {
  if (op.type === "options") {
    const known = op.texts.filter((t) => options.some((o) => normalize(o) === normalize(t)));
    return known.length === op.texts.length ? op.texts : null;
  }
  const idx = localMatchAll(answerOf(op), options);
  return idx ? idx.map((i) => options[i]) : null;
}

/**
 * A native select too long to send to the AI (Lever: 3,300 schools): match its options locally, else let the AI
 * choose among the few that contain the search query.
 */
async function longSelectTexts(h: FieldHandle, op: FillOp, deps: EngineDeps): Promise<string[] | null> {
  const options = nativeOptions(h.el as HTMLSelectElement, Infinity)?.texts ?? [];
  const local = textsFor(op, options);
  if (local) return local;
  const q = normalize((op.type === "intended" && op.query) || answerOf(op));
  const hits = q ? options.filter((o) => normalize(o).includes(q)).slice(0, 50) : [];
  if (!hits.length) return null;
  const idx = await deps.choose(h, answerOf(op), hits);
  return idx?.length ? idx.map((i) => hits[i]) : null;
}

async function dispatch(h: FieldHandle, op: FillOp, deps: EngineDeps): Promise<FillResult> {
  // Awaited, so a strategy's rejection (a refused click) fails this field instead of the whole fill.
  try {
    return await dispatchKind(h, op, deps);
  } catch (e) {
    return { outcome: "failed", note: (e as Error).message };
  }
}

async function dispatchKind(h: FieldHandle, op: FillOp, deps: EngineDeps): Promise<FillResult> {
  const kind = h.desc.kind;
  if (op.type === "clear") return clearValue(h);
  switch (kind) {
    case "text":
    case "email":
    case "tel":
    case "url":
    case "number":
    case "date":
    case "month":
    case "textarea":
      return fillText(h, answerOf(op));
    case "contenteditable":
      return fillContentEditable(h, answerOf(op));
    case "checkbox":
      return op.type === "checked" ? fillCheckbox(h, op.value) : flag("Needs your confirmation");
    case "select":
    case "multiselect":
    case "radio_group":
    case "checkbox_group": {
      const texts = h.desc.options ? textsFor(op, h.desc.options) : await longSelectTexts(h, op, deps);
      if (!texts) return flag(`Suggested: ${answerOf(op)}`);
      if (kind === "radio_group") return fillRadio(h, texts[0]);
      if (kind === "checkbox_group")
        return fillCheckboxGroup(h, texts, deps.checkedByUs, op.type === "options" && !!op.exact);
      return fillSelect(h, kind === "select" ? texts.slice(0, 1) : texts);
    }
    case "dropdown": {
      if (op.type === "options") return fillDropdown(h, op.texts);
      let options = h.desc.options ?? deps.harvested.get(h.id) ?? null;
      if (!options) {
        // Fast path: the intended answer is usually an exact option (scrolls virtualized lists to it).
        const direct = await fillDropdown(h, [answerOf(op)]);
        if (direct.outcome === "ok") return direct;
        options = await harvestOptions(h, HARVEST_MS);
        if (options) deps.harvested.set(h.id, options);
      }
      if (!options) {
        // Search by the short query: Greenhouse's places search for the full "Langley, British Columbia, Canada"
        // lists only "Fort Langley, …".
        const query = (op.type === "intended" && op.query) || answerOf(op);
        // Not on its list: the "Other" its label asks for then (iCIMS: "School (If not applicable, select Other)").
        const other = RE_PICK_OTHER.test(h.desc.label);
        if (h.searchInput) {
          const r = await fillTypeahead(h, query, answerOf(op), (o) =>
            deps.choose(h, answerOf(op), o).then((r) => r?.[0] ?? null),
          );
          if (r.outcome !== "flag" || !other) return r;
          return fillTypeahead(h, "Other", "Other", async (o) => localMatch("Other", o));
        }
        // Too long to harvest (remote paging): choose among what its popup search finds instead.
        options = await searchOptions(h, query);
        if (!options && other) {
          const pick = (await searchOptions(h, "Other"))?.find((o) => /^other\b/i.test(o.trim()));
          if (pick) return fillDropdown(h, [pick]);
        }
        if (!options) return flag(`Suggested: ${answerOf(op)}`);
      }
      let texts = textsFor(op, options);
      // How they heard, under one of the listed categories (Workday's "Job Board" › "LinkedIn"): its search finds it.
      if (!texts && op.type === "intended" && h.searchInput && RE_HEARD_Q.test(h.desc.label)) {
        const found = await fillDropdown(h, [answerOf(op)]);
        if (found.outcome === "ok") return found;
      }
      // A flat list naming only the category (Sun Life's "Job Board" for LinkedIn): the AI chooser won't make the leap.
      if (!texts && !h.searchInput && RE_HEARD_Q.test(h.desc.label) && RE_JOB_BOARD.test(answerOf(op))) {
        const boards = options.filter((o) => /\bjob ?(boards?|sites?)\b/i.test(o));
        if (boards.length === 1) texts = boards;
      }
      if (!texts) {
        const idx = await deps.choose(h, answerOf(op), options);
        texts = idx?.length ? idx.map((i) => options[i]) : null;
      }
      // Where they live, on a list without the place: its one catch-all (Signifyd's UK regions: "Other"; Found
      // Energy's US states: "Not a current US resident"). The chooser found nothing for "Langley, British Columbia".
      if (!texts && /\b(locat\w*|resid\w*|live|based)\b/i.test(h.desc.label)) {
        const elsewhere = options.filter((o) =>
          /^(other\b|outside\b|international\b|none of the above|not (a )?(current )?[\w. ]{0,20}resident)/i.test(
            o.trim(),
          ),
        );
        if (elsewhere.length === 1) texts = elsewhere;
      }
      if (!texts) return flag(`Suggested: ${answerOf(op)}`);
      return fillDropdown(h, h.desc.multiple ? texts : texts.slice(0, 1), answerOf(op));
    }
    case "typeahead": {
      const answer = answerOf(op);
      const query = op.type === "intended" ? op.query || answer : answer;
      const r = await fillTypeahead(h, query, answer, async (o) => {
        const local = localMatch(answer, o);
        return local ?? (await deps.choose(h, answer, o))?.[0] ?? null;
      });
      // How they heard, with no option for it ("Company website" on 1Password's list, which lists only as you type).
      if (r.outcome === "flag" && RE_HEARD_Q.test(h.desc.label) && normalize(answer) !== "other")
        return fillTypeahead(h, "Other", "Other", async (o) => localMatch("Other", o));
      return r;
    }
    case "file": {
      if (op.type !== "file") return flag("Upload the file manually");
      const meta = deps.documents.find((d) => d.id === op.documentId);
      if (!meta) return flag("Document not found");
      const doc = compatibleDoc(meta, deps.documents, h.desc.accept);
      if (!doc) return flag(`No uploaded file matches ${h.desc.accept}`);
      const data = await deps.getDocument(doc.id);
      return data ? { ...(await fillFile(h, data.meta, data.base64)), docId: doc.id } : flag("Document not found");
    }
  }
}
