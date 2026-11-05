// §14.7 file upload: DataTransfer into <input type=file>, or drop onto a dropzone.
import { RE_DROPZONE, RE_RESUME_FILE, RE_UPLOAD_BUTTON } from "../../shared/constants";
import { collapse, normalize } from "../../shared/normalize";
import type { DocumentMeta } from "../../shared/types";
import type { FieldHandle, ScanState } from "../scan/fields";
import { deepQueryAll, shadowOf } from "../scan/traverse";
import { isVisible } from "../scan/visibility";
import { clickForPicker, dispatching, isForbiddenClick, waitFor } from "./events";
import type { FillResult } from "./native";

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
  if ((fileInputIn(h.el) ?? fileInputIn(h.container))?.files?.[0]?.name === meta.fileName)
    return { outcome: "ok", shown: meta.fileName };
  const before = collapse(deepText(h.container));
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
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

/**
 * Résumé dropzones that have no file input at all become pseudo file fields. Legacy Greenhouse's "Attach, Dropbox, …"
 * box clicks a file input in a separate upload form, and its question ("Resume/CV") sits beside it.
 */
export function findDropzones(handles: FieldHandle[], state: ScanState): FieldHandle[] {
  const out: FieldHandle[] = [];
  for (const box of deepQueryAll('[class*="drop" i],[class*="upload" i],[class*="attach" i]')) {
    const own = collapse(box.textContent ?? "");
    const z = RE_RESUME_FILE.test(own) || !box.parentElement ? box : box.parentElement;
    const text = z === box ? own : collapse(z.textContent ?? "");
    if (!RE_RESUME_FILE.test(text) || !RE_DROPZONE.test(text) || text.length > 300 || !isVisible(z)) continue;
    if (fileInputIn(z) || handles.some((h) => h.container.contains(z) || z.contains(h.el))) continue;
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
