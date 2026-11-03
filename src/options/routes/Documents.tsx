import { useEffect, useState } from "preact/hooks";
import { toBase64 } from "../../shared/base64";
import type { DocumentMeta } from "../../shared/types";
import { Prefill } from "../components/Prefill";
import { downloadDoc, ResumeModes, TailorPrompt, TailorUpload } from "../components/ResumeTailoring";
import { pdfText } from "../pdf";
import { markSaved, save, store, useProfile, useStored } from "../store";

const MAX = 5 * 1024 * 1024;
const KINDS: [DocumentMeta["kind"], string][] = [
  ["resume", "Résumé"],
  ["cover_letter", "Cover letter"],
  ["transcript", "Transcript"],
  ["other", "Other"],
];

/** A PDF's or TXT's text; "" for a DOCX, which has no extractor. */
async function docText(d: DocumentMeta): Promise<string> {
  const b64 = await store.getDoc(d.id);
  if (!b64) return "";
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (d.mimeType === "application/pdf" || /\.pdf$/i.test(d.fileName)) return pdfText(bytes.buffer);
  return /\.txt$/i.test(d.fileName) ? new TextDecoder().decode(bytes) : "";
}

/**
 * Keeps `resumeTexts` to one text per résumé document, however documents change (upload, kind, import, delete), so
 * the background can match résumé variants to jobs. Extraction happens here: pdf.js isn't in the service worker.
 */
export function useResumeTexts() {
  const docs = useStored("documentsIndex");
  const texts = useStored("resumeTexts");
  useEffect(() => {
    if (!docs || !texts) return;
    const resumes = docs.filter((d) => d.kind === "resume");
    if (resumes.length === Object.keys(texts).length && resumes.every((d) => d.id in texts)) return;
    let live = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const d of resumes) next[d.id] = texts[d.id] ?? (await docText(d).catch(() => ""));
      if (live) await store.set({ resumeTexts: next });
    })();
    return () => void (live = false);
  }, [docs, texts]);
}

/** The AI tailoring résumé's text, from its compiled PDF rather than the LaTeX source: same facts, far fewer tokens. */
async function tailorText(): Promise<string> {
  const b64 = await store.getDoc("tailor-pdf");
  return b64 ? pdfText(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer).catch(() => "") : "";
}

/** Replaces the editable résumé text with a résumé's own text; a second click confirms discarding what's there. */
function ReloadResumeText() {
  const [profile, update] = useProfile();
  const primary = useStored("documentsIndex")?.find((d) => d.isPrimaryResume);
  const tailor = useStored("tailorResume");
  const [pick, setPick] = useState<"pdf" | "tex" | null>(null);
  const [confirm, setConfirm] = useState<"pdf" | "tex" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (!profile || (!primary && !tailor)) return null;
  // Re-derived each render, so removing either file never leaves a stale pick.
  const source = tailor && (pick === "tex" || !primary) ? "tex" : "pdf";

  const reload = async () => {
    setErr("");
    if (profile.resumeText.trim() && confirm !== source) return setConfirm(source);
    setConfirm(null);
    setBusy(true);
    const text = await (source === "pdf" ? docText(primary!) : tailorText()).catch(() => "");
    setBusy(false);
    // Never swap the user's text for nothing (e.g. a scanned PDF with no text layer).
    if (!text.trim()) return setErr("Couldn’t read any text from that résumé.");
    update((p) => void (p.resumeText = text));
  };

  const buttons = (
    <>
      <button type="button" class="btn small" onClick={() => void reload()}>
        {confirm === source ? "Replace the text below? Click again" : tailor ? "Reload" : "Reload from primary résumé"}
      </button>
      {confirm && (
        <button type="button" class="btn small" onClick={() => setConfirm(null)}>
          Cancel
        </button>
      )}
    </>
  );

  return (
    <>
      <fieldset class="field" disabled={busy}>
        {tailor ? (
          <>
            <legend>Extract from</legend>
            <p class="help above">
              {source === "pdf"
                ? "Reload uses the text of your primary résumé."
                : "Reload uses the text of your .tex résumé as uploaded, before any tailoring."}
            </p>
            <div class="row">
              <label class="inline">
                <input
                  type="radio"
                  name="reload-source"
                  checked={source === "pdf"}
                  disabled={!primary}
                  onChange={() => setPick("pdf")}
                />
                Primary résumé (.pdf) <span class="muted">{primary ? `· ${primary.label}` : "· none chosen"}</span>
              </label>
              <label class="inline">
                <input type="radio" name="reload-source" checked={source === "tex"} onChange={() => setPick("tex")} />
                AI tailoring résumé (.tex) <span class="muted">· {tailor.fileName}</span>
              </label>
              {buttons}
            </div>
          </>
        ) : (
          <div class="row">{buttons}</div>
        )}
      </fieldset>
      {err && <p class="err">{err}</p>}
    </>
  );
}

export function DocumentUpload() {
  const docs = useStored("documentsIndex") ?? [];
  const [, update] = useProfile();
  const [label, setLabel] = useState("Résumé");
  const [kind, setKind] = useState<DocumentMeta["kind"]>("resume");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const upload = async (file: File) => {
    setErr("");
    if (file.size > MAX) return setErr("Files must be 5 MB or smaller.");
    if (!/\.(pdf|docx|txt)$/i.test(file.name)) return setErr("Upload a PDF, DOCX or TXT file.");
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const isPdf = /\.pdf$/i.test(file.name);
      const primary = kind === "resume" && isPdf && !docs.some((d) => d.isPrimaryResume);
      const meta: DocumentMeta = {
        id: crypto.randomUUID(),
        label: label.trim() || file.name,
        kind,
        fileName: file.name,
        mimeType: file.type || (isPdf ? "application/pdf" : "application/octet-stream"),
        size: file.size,
        isPrimaryResume: primary,
        uploadedAt: Date.now(),
      };
      await store.setDoc(meta.id, toBase64(buf));
      await save({ documentsIndex: [...docs, meta] });
      if (primary) {
        const text = await docText(meta);
        update((p) => void (p.resumeText = text));
      }
    } catch (e) {
      setErr(`Could not read the file: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="inline-form">
      <label>
        Label
        <input value={label} onInput={(e) => setLabel(e.currentTarget.value)} />
      </label>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.currentTarget.value as DocumentMeta["kind"])}>
          {KINDS.map(([v, t]) => (
            <option value={v}>{t}</option>
          ))}
        </select>
      </label>
      <label>
        File (PDF, DOCX or TXT, max 5 MB)
        <input
          type="file"
          accept=".pdf,.docx,.txt,application/pdf,text/plain"
          disabled={busy}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void upload(f);
            e.currentTarget.value = "";
          }}
        />
      </label>
      {busy && <span class="muted">Uploading…</span>}
      {err && <p class="err">{err}</p>}
    </div>
  );
}

export function Documents() {
  const docs = useStored("documentsIndex") ?? [];
  const [profile, update] = useProfile();

  const makePrimary = async (d: DocumentMeta) => {
    await save({ documentsIndex: docs.map((x) => ({ ...x, isPrimaryResume: x.id === d.id })) });
    const text = await docText(d);
    update((p) => void (p.resumeText = text));
  };

  const edit = (id: string, patch: Partial<DocumentMeta>) =>
    save({ documentsIndex: docs.map((d) => (d.id === id ? { ...d, ...patch } : d)) });

  const remove = async (id: string) => {
    await store.removeDoc(id);
    await save({ documentsIndex: docs.filter((d) => d.id !== id) });
    markSaved();
  };

  return (
    <section>
      <h1>Documents</h1>
      <p class="intro">
        With Variant select, your primary résumé is attached automatically to résumé/CV upload fields. Its text is used
        as AI context either way.
      </p>
      <ResumeModes />
      <p class="intro">
        <strong>Résumé variants:</strong> upload each tailored résumé (e.g. JavaScript, Systems) with kind Résumé. Each
        application gets the variant whose contents and label best match the job’s title and description, judged by what
        sets the variants apart, so a label of spelled-out keywords (“React TypeScript”) helps. With no clear match, or
        for a DOCX (its text can’t be read), the label alone decides, then your primary résumé.
      </p>
      <div class="panel-box">
        <h2>Upload</h2>
        <DocumentUpload />
      </div>
      {docs.length > 0 && (
        <table class="table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Kind</th>
              <th>File</th>
              <th>Primary résumé</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr>
                <td>
                  <input
                    aria-label={`Label of ${d.fileName}`}
                    value={d.label}
                    onChange={(e) => void edit(d.id, { label: e.currentTarget.value.trim() || d.fileName })}
                  />
                </td>
                <td>
                  <select
                    aria-label={`Kind of ${d.fileName}`}
                    value={d.kind}
                    onChange={(e) => {
                      const kind = e.currentTarget.value as DocumentMeta["kind"];
                      // Only a résumé can be the primary one.
                      void edit(d.id, kind === "resume" ? { kind } : { kind, isPrimaryResume: false });
                    }}
                  >
                    {KINDS.map(([v, t]) => (
                      <option value={v}>{t}</option>
                    ))}
                  </select>
                </td>
                <td>
                  {d.fileName} <span class="muted">({Math.round(d.size / 1024)} KB)</span>
                </td>
                <td>
                  {d.kind !== "resume" || d.mimeType === "application/pdf" || /\.pdf$/i.test(d.fileName) ? (
                    <input
                      type="radio"
                      name="primary"
                      aria-label={`Make ${d.label} the primary résumé`}
                      disabled={d.kind !== "resume"}
                      checked={d.isPrimaryResume}
                      onChange={() => void makePrimary(d)}
                    />
                  ) : (
                    <span class="muted">PDF résumés only</span>
                  )}
                </td>
                <td class="doc-actions">
                  <button
                    type="button"
                    class="btn small"
                    onClick={() => void downloadDoc(d.id, d.fileName, d.mimeType)}
                  >
                    Download
                  </button>
                  <button type="button" class="btn small danger" onClick={() => void remove(d.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <TailorUpload />
      <TailorPrompt />
      {profile && (
        <div class="panel-box">
          <h2>Résumé text</h2>
          <div class="field">
            <label for="resume-text">Extracted text (editable)</label>
            <p class="help above">
              Sent to the AI as context for answers and essays. Edit it if extraction garbled anything.
            </p>
            <ReloadResumeText />
            <textarea
              id="resume-text"
              rows={5}
              value={profile.resumeText}
              onInput={(e) => update((p) => void (p.resumeText = e.currentTarget.value))}
            />
          </div>
          <Prefill />
        </div>
      )}
    </section>
  );
}
