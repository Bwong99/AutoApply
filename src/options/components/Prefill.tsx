// §10.9 "Extract from résumé": proposes values only for empty fields; user ticks what to keep. The source is the
// résumé text (primary PDF's, with the user's edits) or the AI tailoring .tex résumé's untailored PDF.
import { useState } from "preact/hooks";
import { isErr, send } from "../../shared/messages";
import { pdfText } from "../pdf";
import { getPath, isEmpty, leaves, setPath, store, useProfile, useStored } from "../store";

/** The AI tailoring résumé's text, from its compiled PDF rather than the LaTeX source: same facts, far fewer tokens. */
export async function tailorText(): Promise<string> {
  const b64 = await store.getDoc("tailor-pdf");
  return b64 ? pdfText(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer).catch(() => "") : "";
}

const show = (v: unknown) =>
  Array.isArray(v)
    ? v
        .map((x) =>
          typeof x === "object" ? Object.values(x as object).filter((s) => s && typeof s === "string")[0] : x,
        )
        .join(", ")
    : String(v);

export function Prefill() {
  const [profile, update] = useProfile();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [diff, setDiff] = useState<{ path: string; value: unknown; on: boolean }[] | null>(null);
  const primary = useStored("documentsIndex")?.find((d) => d.isPrimaryResume);
  const tailor = useStored("tailorResume");
  const [pick, setPick] = useState<"pdf" | "tex" | null>(null);
  // Re-derived each render, so removing either file never leaves a stale pick.
  const source = tailor && (pick === "tex" || !primary) ? "tex" : "pdf";

  const run = async () => {
    if (!profile) return;
    setErr("");
    setDiff(null);
    setBusy(true);
    const text = source === "tex" ? await tailorText() : profile.resumeText;
    if (!text.trim()) {
      setBusy(false);
      return setErr(
        source === "tex"
          ? "Couldn’t read any text from your AI tailoring résumé. Try uploading the .tex again."
          : "Upload a résumé (or paste its text) first.",
      );
    }
    const r = await send({ type: "PARSE_RESUME", text });
    setBusy(false);
    if (isErr(r)) return setErr(r.error.message);
    const items = leaves(r.proposed)
      .filter(([path, v]) => !isEmpty(v) && isEmpty(getPath(profile, path)))
      .map(([path, value]) => ({ path, value, on: true }));
    setDiff(items);
  };

  const apply = () => {
    update((p) => diff!.filter((d) => d.on).forEach((d) => setPath(p, d.path, d.value)));
    setDiff(null);
  };

  return (
    <div class="prefill">
      {tailor && (
        <fieldset class="field" disabled={busy}>
          <legend>Extract from</legend>
          <label class="inline">
            <input
              type="radio"
              name="prefill-source"
              checked={source === "pdf"}
              disabled={!primary}
              onChange={() => setPick("pdf")}
            />
            Primary résumé (.pdf) <span class="muted">{primary ? `· ${primary.label}` : "· none chosen"}</span>
          </label>
          <label class="inline">
            <input type="radio" name="prefill-source" checked={source === "tex"} onChange={() => setPick("tex")} />
            AI tailoring résumé (.tex) <span class="muted">· {tailor.fileName}</span>
          </label>
          <p class="help">
            {source === "pdf"
              ? "Uses the text above, including your edits."
              : "Uses the text of your .tex résumé as uploaded, before any tailoring."}
          </p>
        </fieldset>
      )}
      <button type="button" class="btn" onClick={() => void run()} disabled={busy}>
        {busy ? "Reading résumé…" : "Extract from résumé"}
      </button>
      {err && <p class="err">{err}</p>}
      {diff && (
        <div class="panel-box">
          <h3>Review proposed values</h3>
          {diff.length === 0 ? (
            <p>Nothing new: every field the résumé covers is already filled.</p>
          ) : (
            <ul class="diff">
              {diff.map((d, i) => (
                <li>
                  <label>
                    <input
                      type="checkbox"
                      checked={d.on}
                      onChange={(e) => {
                        const next = [...diff];
                        next[i] = { ...d, on: e.currentTarget.checked };
                        setDiff(next);
                      }}
                    />{" "}
                    <span class="mono">{d.path}</span> → {show(d.value)}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div class="row">
            <button type="button" class="btn primary" onClick={apply} disabled={!diff.some((d) => d.on)}>
              Save checked
            </button>
            <button type="button" class="btn" onClick={() => setDiff(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
