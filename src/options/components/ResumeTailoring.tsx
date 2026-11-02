// Documents: how résumé uploads are answered (Behavior / YOLO → Upload résumés), and AI tailor's LaTeX résumé and
// prompt.
import { useState } from "preact/hooks";
import { toBase64 } from "../../shared/base64";
import { compileErrors, parseTex, unsupported } from "../../shared/latex";
import { resumeProblem } from "../../shared/resumeMode";
import { DEFAULT_TAILOR_PROMPT } from "../../shared/settings";
import type { Settings } from "../../shared/types";
import { compileTex } from "../../latex/engine";
import { pdfText } from "../pdf";
import { markSaved, save, store, useProfile, useStored } from "../store";

const MAX_TEX = 1024 * 1024;
const NAMES = { variants: "Variant select", tailor: "AI tailor", flag: "Flag for me" } as const;

const bytesOf = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Which upload mode autofill and YOLO use, what each does, and what's missing for them. */
export function ResumeModes() {
  const s = useStored("settings");
  const y = useStored("yolo");
  const docs = useStored("documentsIndex");
  const tailor = useStored("tailorResume");
  if (!s || !y || !docs || tailor === undefined) return null;
  const problems = [
    resumeProblem(s.resumeUpload, docs, !!tailor, "Autofill"),
    resumeProblem(y.resumeUpload, docs, !!tailor, "YOLO"),
  ].filter(Boolean);
  return (
    <div class="panel-box">
      <h2>How résumés are uploaded</h2>
      <p>
        Autofill: <strong>{NAMES[s.resumeUpload]}</strong> (<a href="#/behavior">change</a>) · YOLO:{" "}
        <strong>{NAMES[y.resumeUpload]}</strong> (<a href="#/yolo">change</a>)
      </p>
      <ul class="help">
        <li>
          <strong>Variant select</strong> uploads one of your résumé documents below (kind Résumé): the variant that
          best fits each job. Fast, and uses no AI.
        </li>
        <li>
          <strong>AI tailor</strong> uploads your LaTeX résumé (under “Résumé for AI tailoring”) after the AI tailors it
          to each job: it rewords and reorders bullets, entries and sections without touching your template’s layout,
          then it’s compiled to PDF on this computer. Slower (several seconds, while the rest of the form fills) and
          uses AI tokens. If anything goes wrong, the untailored PDF made when you uploaded it is used.
        </li>
        <li>
          <strong>Flag for me</strong> (autofill only) leaves résumé uploads for you to do.
        </li>
      </ul>
      <p class="muted">
        The two kinds are kept apart: résumé documents are only ever variants and the .tex is only ever tailored, so
        autofill and YOLO can each use either one.
      </p>
      {problems.map((p) => (
        <p class="note" role="alert">
          {p}
        </p>
      ))}
    </div>
  );
}

/** The one LaTeX résumé: checked and test-compiled on upload, so problems show here and never mid-fill. */
export function TailorUpload() {
  const tailor = useStored("tailorResume");
  const variants = useStored("tailorVariants") ?? [];
  const s = useStored("settings");
  const y = useStored("yolo");
  const [profile, update] = useProfile();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const used = s?.resumeUpload === "tailor" || y?.resumeUpload === "tailor";

  /** `extra`: added as another résumé to choose from, not replacing the main one. */
  const upload = async (file: File, extra = false) => {
    setErrors([]);
    if (!/\.tex$/i.test(file.name)) return setErrors(["Upload a .tex file."]);
    if (file.size > MAX_TEX) return setErrors(["The .tex file must be 1 MB or smaller."]);
    setBusy(true);
    try {
      const src = await file.text();
      const bundle = (await (await fetch(chrome.runtime.getURL("texlive/packages.json"))).json()) as {
        packages: string[];
        classes: string[];
      };
      const missing = unsupported(src, bundle);
      if (missing.length) return setErrors(missing);
      if (!parseTex(src)) return setErrors(["No \\begin{document} … \\end{document} found in this file."]);
      const r = await compileTex(src, 60_000);
      if (!r.pdf) return setErrors(compileErrors(r.log));
      if (extra) {
        const id = crypto.randomUUID();
        await store.setDoc(`tailor-tex:${id}`, toBase64(new TextEncoder().encode(src)));
        await store.setDoc(`tailor-pdf:${id}`, r.pdf);
        const info = { id, fileName: file.name, size: file.size, uploadedAt: Date.now(), pages: r.pages };
        return void (await save({ tailorVariants: [...variants, info] }));
      }
      await store.setDoc("tailor-tex", toBase64(new TextEncoder().encode(src)));
      await store.setDoc("tailor-pdf", r.pdf);
      await save({ tailorResume: { fileName: file.name, size: file.size, uploadedAt: Date.now(), pages: r.pages } });
      // With no PDF résumé, its text is the AI's résumé context too.
      if (profile && !profile.resumeText.trim()) {
        const text = await pdfText(bytesOf(r.pdf).buffer).catch(() => "");
        if (text) update((p) => void (p.resumeText = text));
      }
    } catch (e) {
      setErrors([`Could not check the file: ${(e as Error).message}`]);
    } finally {
      setBusy(false);
    }
  };

  const download = async (variant?: { id: string; fileName: string }) => {
    const b64 = await store.getDoc(variant ? `tailor-pdf:${variant.id}` : "tailor-pdf");
    if (!b64) return;
    const url = URL.createObjectURL(new Blob([bytesOf(b64)], { type: "application/pdf" }));
    const name = (variant?.fileName ?? tailor?.fileName ?? "resume.tex").replace(/\.tex$/i, ".pdf");
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const removeVariant = async (id: string) => {
    await store.removeDoc(`tailor-tex:${id}`);
    await store.removeDoc(`tailor-pdf:${id}`);
    await save({ tailorVariants: variants.filter((v) => v.id !== id) });
    markSaved();
  };

  // The next résumé, if any, becomes the main one: AI tailor stays usable.
  const remove = async () => {
    const [next, ...rest] = variants;
    if (next) {
      const [tex, pdf] = await Promise.all([
        store.getDoc(`tailor-tex:${next.id}`),
        store.getDoc(`tailor-pdf:${next.id}`),
      ]);
      await store.setDoc("tailor-tex", tex ?? "");
      await store.setDoc("tailor-pdf", pdf ?? "");
      await store.removeDoc(`tailor-tex:${next.id}`);
      await store.removeDoc(`tailor-pdf:${next.id}`);
      const { fileName, size, uploadedAt, pages } = next;
      await save({ tailorResume: { fileName, size, uploadedAt, pages }, tailorVariants: rest });
      return markSaved();
    }
    await store.removeDoc("tailor-tex");
    await store.removeDoc("tailor-pdf");
    await save({ tailorResume: null });
    markSaved();
  };

  return (
    <div class="panel-box">
      <h2>Résumé for AI tailoring (.tex)</h2>
      {!used && <p class="muted">Not used: neither autofill nor YOLO has Upload résumés set to AI tailor.</p>}
      <p class="help">
        One self-contained pdfLaTeX file (no images or other files it inputs). Jake’s Resume, moderncv (classic, casual,
        banking) and article-based templates using common packages (geometry, titlesec, enumitem, hyperref, xcolor,
        fontawesome5, tabularx, fancyhdr, babel, marvosym, TikZ…) work; XeLaTeX/LuaLaTeX templates (fontspec,
        Awesome-CV, Deedy) don’t. It’s test-compiled when you upload it.
      </p>
      {tailor && (
        <p>
          <strong>{tailor.fileName}</strong>{" "}
          <span class="muted">
            ({Math.round(tailor.size / 1024)} KB · {tailor.pages} page{tailor.pages === 1 ? "" : "s"} · uploaded{" "}
            {new Date(tailor.uploadedAt).toLocaleDateString()})
          </span>{" "}
          <button type="button" class="btn small" onClick={() => void download()}>
            Download untailored PDF
          </button>
          <button type="button" class="btn small danger" onClick={() => void remove()}>
            Remove
          </button>
        </p>
      )}
      <label class="inline-form">
        <span>{tailor ? "Replace with another .tex file" : "Upload a .tex file (max 1 MB)"}</span>
        <input
          type="file"
          accept=".tex,text/x-tex"
          aria-label="Résumé for AI tailoring (.tex)"
          disabled={busy}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) void upload(f);
            e.currentTarget.value = "";
          }}
        />
      </label>
      {tailor && (
        <>
          <p class="help">
            Applying to different kinds of roles? Add a résumé for each. A fill tailors the one whose words best fit the
            job, chosen without AI; with no clear difference, the main one above.
          </p>
          {variants.map((v) => (
            <p>
              <strong>{v.fileName}</strong>{" "}
              <span class="muted">
                ({Math.round(v.size / 1024)} KB · {v.pages} page{v.pages === 1 ? "" : "s"} · uploaded{" "}
                {new Date(v.uploadedAt).toLocaleDateString()})
              </span>{" "}
              <button type="button" class="btn small" onClick={() => void download(v)}>
                Download untailored PDF
              </button>
              <button type="button" class="btn small danger" onClick={() => void removeVariant(v.id)}>
                Remove
              </button>
            </p>
          ))}
          <label class="inline-form">
            <span>Add another .tex file</span>
            <input
              type="file"
              accept=".tex,text/x-tex"
              aria-label="Another LaTeX résumé"
              disabled={busy}
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) void upload(f, true);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </>
      )}
      {busy && <span class="muted">Checking and compiling…</span>}
      {errors.length > 0 && (
        <div class="err" role="alert">
          <p>This file wasn’t uploaded:</p>
          <ul>
            {errors.map((e) => (
              <li>
                <code>{e}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** AI tailor's instructions, editable; enabled while autofill or YOLO uses AI tailor. */
export function TailorPrompt() {
  const s = useStored("settings");
  const y = useStored("yolo");
  const [confirm, setConfirm] = useState(false);
  if (!s || !y) return null;
  const used = s.resumeUpload === "tailor" || y.resumeUpload === "tailor";
  const set = (patch: Partial<Settings>) => void save({ settings: { ...s, ...patch } });
  return (
    <div class="panel-box">
      <h2>AI tailoring prompt</h2>
      {!used && <p class="muted">Set Upload résumés to AI tailor (Behavior or YOLO) to use this prompt.</p>}
      <div class="field full">
        <label for="tailor-prompt">What the AI is told about tailoring your résumé</label>
        <textarea
          id="tailor-prompt"
          rows={16}
          disabled={!used}
          value={s.tailorPrompt}
          onInput={(e) => set({ tailorPrompt: e.currentTarget.value })}
        />
        <p class="help">
          Edit it to change what the AI may do; it overrides the defaults (for example, to let it add more bullets).
          AutoApply always adds its own rules for the answer format and LaTeX safety, and keeps only edits that leave
          your template’s layout, packages and commands as they are.
        </p>
      </div>
      <button
        type="button"
        class="btn small"
        disabled={!used || s.tailorPrompt === DEFAULT_TAILOR_PROMPT}
        onClick={() => {
          if (!confirm) return setConfirm(true);
          set({ tailorPrompt: DEFAULT_TAILOR_PROMPT });
          setConfirm(false);
        }}
      >
        {confirm ? "Replace your prompt with the default? Click again" : "Reset default prompt"}
      </button>
      {confirm && (
        <button type="button" class="btn small" onClick={() => setConfirm(false)}>
          Cancel
        </button>
      )}
    </div>
  );
}
