// §14.7 file upload: DataTransfer into <input type=file>, or drop onto a dropzone.
import {
  RE_ACTION_LABEL,
  RE_COVER_LETTER,
  RE_DROPZONE,
  RE_RESUME_FILE,
  RE_RESUME_ONLY,
  RE_UPLOAD_BUTTON,
} from "../../shared/constants";
import { collapse, normalize } from "../../shared/normalize";
import type { DocumentMeta } from "../../shared/types";
import type { FieldHandle, ScanState } from "../scan/fields";
import { deepQueryAll, shadowOf } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { clickForPicker, dispatching, isForbiddenClick, waitFor } from "./events";
import type { FillResult } from "./native";

/** The kinds of document an upload's own words ask for, besides the résumé and cover letter. */
const RE_TRANSCRIPT_DOC = /\btranscripts?\b|\bgrades?\b|\bacademic record|\bproof of (enrol|registration)/i;
const RE_OTHER_DOC =
  /\bportfolio|\bwriting sample|\bwork samples?\b|\breferences?\b|\brecommendation|\bcertificat|\blicen[cs]e|\bpassport|\bwork permit|\bvisa\b|\bproof of (enrol|registration)/i;

/**
 * Whether a document of `kind` is what this upload asks for. A wrong document gets an applicant turned down (Teck's
 * cover letter got the transcript, its uploader named only by its tooltip): an upload naming documents takes only
 * those; one naming none (Attachments) takes what was chosen for it.
 */
export function documentFits(h: FieldHandle, kind: DocumentMeta["kind"]): boolean {
  const own = `${h.desc.label} ${h.desc.hint ?? ""}`;
  const box = collapse(h.container?.textContent ?? "");
  const text = box.length <= 400 ? `${own} ${box}` : own;
  const wants = new Set<DocumentMeta["kind"]>();
  if (RE_COVER_LETTER.test(text)) wants.add("cover_letter");
  if (RE_RESUME_ONLY.test(text.replace(RE_COVER_LETTER_MENTION, " "))) wants.add("resume");
  if (RE_TRANSCRIPT_DOC.test(text)) wants.add("transcript");
  if (RE_OTHER_DOC.test(text)) wants.add("other");
  return !wants.size || wants.has(kind);
}
/** An upload for work samples: "Please provide work samples (either portfolio site or code repository)". */
const RE_PORTFOLIO_UPLOAD =
  /\bportfolios?\b|\b(work|code|design) samples?\b|\bsamples? of (your |my )?(work|code)\b|\bcode repositor(y|ies)\b/i;
/** Documents a link PDF can't stand in for: an upload also asking for one of these wants that document. */
const RE_NOT_PORTFOLIO =
  /r[ée]sum[ée]|\bcv\b|cover letter|\btranscripts?\b|\bgrades?\b|\bwriting samples?\b|\breferences?\b|\brecommendation|\bcertificat|\blicen[cs]e|\bpassport|\bwork permit|\bvisa\b|\bproof of\b/i;

/** Whether this upload asks only for a portfolio or work samples, and takes a PDF: a PDF of the portfolio link answers it. */
export function isPortfolioUpload(h: FieldHandle): boolean {
  const text = `${h.desc.label} ${h.desc.hint ?? ""}`;
  return (
    h.desc.kind === "file" &&
    RE_PORTFOLIO_UPLOAD.test(text) &&
    !RE_NOT_PORTFOLIO.test(text) &&
    accepts(h.desc.accept, { fileName: "x.pdf", mimeType: "application/pdf" } as DocumentMeta)
  );
}

/** "Complement your resume with a cover letter": a cover letter's box naming the résumé it accompanies. */
// No leading \b: a box's text runs its heading into it ("Cover LetterComplement your resume").
const RE_COVER_LETTER_MENTION = /(complement|accompany|accompanies|along with|with|to) your r[ée]sum[ée]\b/gi;

export function accepts(accept: string | undefined, meta: DocumentMeta): boolean {
  if (!accept?.trim()) return true;
  const ext = "." + (meta.fileName.split(".").pop() ?? "").toLowerCase();
  return accept
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .some((t) => t === ext || t === meta.mimeType || (t.endsWith("/*") && meta.mimeType.startsWith(t.slice(0, -1))));
}

/** Pick a document of the same kind whose type the field accepts. */
export function compatibleDoc(meta: DocumentMeta, docs: DocumentMeta[], accept?: string): DocumentMeta | null {
  if (accepts(accept, meta)) return meta;
  return docs.find((d) => d.kind === meta.kind && accepts(accept, d)) ?? null;
}

const fileInputIn = (el: Element) =>
  el instanceof HTMLInputElement && el.type === "file" ? el : el.querySelector<HTMLInputElement>("input[type=file]");

/** Text including shadow roots: SmartRecruiters lists the uploaded file inside its dropzone's shadow root. */
function deepText(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? "";
  if (n instanceof Element && n.matches("style,script")) return "";
  const sr = n instanceof Element ? shadowOf(n) : null;
  return [...(sr ? [sr] : []), ...n.childNodes].map(deepText).join(" ");
}

const RE_UPLOADED = /uploaded|attached|✓/i;

/** `before`: the box's text before the upload; a word like "uploaded" there already ("Files uploaded must be PDFs") proves nothing. */
function uploadedIn(h: FieldHandle, name: string, before?: string): boolean {
  const input = fileInputIn(h.el) ?? fileInputIn(h.container);
  if (input?.files?.[0]?.name === name) return true;
  const text = collapse(deepText(h.container));
  return normalize(text).includes(normalize(name)) || (RE_UPLOADED.test(text) && !RE_UPLOADED.test(before ?? ""));
}

export async function fillFile(h: FieldHandle, meta: DocumentMeta, base64: string): Promise<FillResult> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const current = (fileInputIn(h.el) ?? fileInputIn(h.container))?.files?.[0];
  // Regenerated documents keep their filename: skip an upload only when its bytes also match.
  if (current?.name === meta.fileName && current.size === bytes.length) {
    const previous = await current.arrayBuffer().then(
      (buffer) => new Uint8Array(buffer),
      () => null,
    );
    if (previous && bytes.every((b, i) => b === previous[i])) return { outcome: "ok", shown: meta.fileName };
  }
  const before = collapse(deepText(h.container));
  const file = new File([bytes], meta.fileName, { type: meta.mimeType });
  const dt = new DataTransfer();
  dt.items.add(file);
  const setInput = (input: HTMLInputElement) =>
    dispatching(() => {
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

  let input = fileInputIn(h.el);
  if (input) setInput(input);
  else {
    dispatching(() => {
      for (const type of ["dragenter", "dragover", "drop"])
        h.el.dispatchEvent(new DragEvent(type, { bubbles: true, composed: true, cancelable: true, dataTransfer: dt }));
    });
    // An "Upload"/"Attach" button reveals the real input, or clicks one kept elsewhere to open its picker.
    const btn = [...h.container.querySelectorAll<HTMLElement>("button,[role=button]")].find(
      (b) => RE_UPLOAD_BUTTON.test(b.textContent ?? "") && !isForbiddenClick(b),
    );
    if (btn && !uploadedIn(h, meta.fileName, before)) {
      input = clickForPicker(btn) ?? (await waitFor(() => fileInputIn(h.container), 500));
      if (input) setInput(input);
    }
  }
  const ok = await waitFor(() => uploadedIn(h, meta.fileName, before), 3000);
  return ok ? { outcome: "ok", shown: meta.fileName } : { outcome: "flag", note: "Upload the file manually" };
}

/** The parent, or across a shadow root its host. */
const up = (e: Element): HTMLElement | null =>
  e.parentElement ?? ((e.getRootNode() as ShadowRoot).host as HTMLElement | undefined) ?? null;
/** Whether `box` holds `e`, shadow roots included. */
const holds = (box: Element, e: Element) => {
  for (let n: Element | null = e; n; n = up(n)) if (n === box) return true;
  return false;
};

/**
 * Résumé dropzones that have no file input at all become pseudo file fields. Legacy Greenhouse's "Attach, Dropbox, …"
 * box clicks a file input in a separate upload form, and its question ("Resume/CV") sits beside it.
 */
export function findDropzones(handles: FieldHandle[], state: ScanState): FieldHandle[] {
  const out: FieldHandle[] = [];
  // Also the box around a bare "Browse" button: SuccessFactors' new application (SAP UI5's FileUploader, "sapUiFup")
  // names no upload in its classes, and its Next stays disabled until the résumé is in (Teck).
  // Its parts sit in shadow roots (the Browse button, the input), so the box is found across them.
  const browse = deepQueryAll("button,[role=button]").flatMap((b) => {
    if (!RE_ACTION_LABEL.test(collapse(b.textContent ?? "")) || !isVisible(b)) return [];
    for (let box: HTMLElement | null = b, i = 0; box && i < 8; box = up(box), i++) {
      const t = collapse(box.textContent ?? "");
      if (t.length > 300) break;
      if (RE_RESUME_FILE.test(t)) return [box];
    }
    return [];
  });
  for (const box of [...deepQueryAll('[class*="drop" i],[class*="upload" i],[class*="attach" i]'), ...browse]) {
    const own = collapse(box.textContent ?? "");
    const z = RE_RESUME_FILE.test(own) || !box.parentElement ? box : box.parentElement;
    const text = z === box ? own : collapse(z.textContent ?? "");
    // A Browse button is an upload by itself; other boxes must say so.
    if (!RE_RESUME_FILE.test(text) || text.length > 300 || !isVisible(z)) continue;
    if (!browse.includes(box) && !RE_DROPZONE.test(text)) continue;
    // UI5's hidden input is scanned unlabeled, or named by its tooltip ("All files will be replaced on each upload",
    // Teck's cover letter, which the review then took for a transcript upload): the box's words name it.
    const bare =
      browse.includes(box) &&
      handles.find(
        (h) =>
          h.desc.kind === "file" &&
          (!h.desc.label || h.desc.label === (h.el as HTMLInputElement).title) &&
          holds(z, h.el),
      );
    if (bare) {
      bare.desc.label = text.slice(0, 120);
      bare.container = z;
      continue;
    }
    if (fileInputIn(z) || handles.some((h) => h.container.contains(z) || holds(z, h.el))) continue;
    if (out.some((o) => o.el.contains(z) || z.contains(o.el))) continue;
    let id = state.ids.get(z);
    if (!id) state.ids.set(z, (id = `f${state.next++}`));
    const required = z.getAttribute("aria-required") === "true" || /\*/.test(text);
    const desc = { id, kind: "file" as const, label: text.slice(0, 120), required, optionsKnown: true };
    out.push({
      id,
      desc,
      el: z,
      container: z,
      prefilled: false,
      sensitive: false,
      consent: false,
    });
  }
  return out;
}
