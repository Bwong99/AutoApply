// §10.9 "Prefill Profile using extracted résumé": proposes values only for empty fields; user ticks what to keep. The source is the
// editable résumé text (Documents → Résumé text), including the user's edits.
import { useState } from "preact/hooks";
import { isErr, send } from "../../shared/messages";
import { getPath, isEmpty, leaves, newEntries, setPath, useProfile } from "../store";

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

  const run = async () => {
    if (!profile) return;
    setErr("");
    setDiff(null);
    setBusy(true);
    const text = profile.resumeText;
    if (!text.trim()) {
      setBusy(false);
      return setErr("Upload a résumé (or paste its text) first.");
    }
    const r = await send({ type: "PARSE_RESUME", text });
    setBusy(false);
    if (isErr(r)) return setErr(r.error.message);
    // Lists (projects, experience, skills…) propose only the entries the profile lacks, even when it already has some.
    const items = leaves(r.proposed).flatMap(([path, v]) => {
      const have = getPath(profile, path);
      const value = Array.isArray(v) && Array.isArray(have) ? newEntries(path, have, v) : v;
      return !isEmpty(value) && (Array.isArray(value) || isEmpty(have)) ? [{ path, value, on: true }] : [];
    });
    setDiff(items);
  };

  const apply = () => {
    update((p) =>
      diff!
        .filter((d) => d.on)
        .forEach((d) => {
          const have = getPath(p, d.path);
          setPath(p, d.path, Array.isArray(d.value) && Array.isArray(have) ? [...have, ...d.value] : d.value);
        }),
    );
    setDiff(null);
  };

  return (
    <div class="prefill">
      <button type="button" class="btn" onClick={() => void run()} disabled={busy}>
        {busy ? "Reading résumé…" : "Prefill Profile using extracted résumé"}
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
                    <span class="mono">{d.path}</span> → {isEmpty(getPath(profile, d.path)) ? "" : "add "}
                    {show(d.value)}
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
