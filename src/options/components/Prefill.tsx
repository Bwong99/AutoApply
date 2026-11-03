// §10.9 "Extract from résumé": proposes values only for empty fields; user ticks what to keep.
import { useState } from "preact/hooks";
import { isErr, send } from "../../shared/messages";
import { getPath, isEmpty, leaves, setPath, useProfile } from "../store";

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
    if (!profile?.resumeText.trim()) return setErr("Upload a résumé (or paste its text) first.");
    setBusy(true);
    setErr("");
    const r = await send({ type: "PARSE_RESUME", text: profile.resumeText });
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
