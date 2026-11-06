import { useEffect, useState } from "preact/hooks";
import { isErr, send } from "../../shared/messages";
import { normalize } from "../../shared/normalize";
import { formatDateTime } from "../../shared/time";
import type { Application } from "../../shared/yolo";
import { store, useStored } from "../store";
import { SourceCheck } from "../components/SourceCheck";

const STATUS: Record<Application["status"], string> = {
  submitted: "Submitted",
  needs: "Needs you",
  failed: "Failed",
  skipped: "Skipped",
  review: "Ready for your review",
};

/** Saves a file a debug log kept: the PDF uploaded, or text in older logs. */
function download(f: { name: string; base64?: string; text?: string }) {
  const data = f.base64 ? Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)) : (f.text ?? "");
  const url = URL.createObjectURL(new Blob([data], { type: f.base64 ? "application/pdf" : "text/plain" }));
  Object.assign(document.createElement("a"), { href: url, download: f.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Applications() {
  const apps = useStored("applications");
  const queue = useStored("yoloQueue");
  const settings = useStored("settings");
  const logs = useStored("yoloLogs");
  const yoloState = useStored("yoloState");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [reviewTabs, setReviewTabs] = useState<{ live: string[]; refilling: string[] }>({ live: [], refilling: [] });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const loadReviews = () =>
    void send({ type: "YOLO_REVIEW_LIST" })
      .then(setReviewTabs)
      .catch(() => undefined);
  useEffect(() => {
    if (!apps?.some((a) => a.review)) return;
    loadReviews();
    window.addEventListener("focus", loadReviews);
    return () => window.removeEventListener("focus", loadReviews);
  }, [apps, yoloState?.reviewUpdatedAt]);
  const reviewAction = async (
    type: "YOLO_REVIEW_OPEN" | "YOLO_REVIEW_REFILL" | "YOLO_REVIEW_DISMISS" | "YOLO_REVIEW_MARK_SUBMITTED",
    key: string,
  ) => {
    setBusy(key);
    setMessage("");
    try {
      const r = await send({ type, key });
      if (isErr(r)) setMessage(r.error.message);
      else if (type === "YOLO_REVIEW_REFILL")
        setMessage(
          "Refill requested. It will start after the current application finishes and will stop before submission.",
        );
      loadReviews();
    } catch {
      setMessage("Couldn't reach AutoApply. Please try again.");
    } finally {
      setBusy("");
    }
  };
  if (!apps || !queue || !settings || !logs) return <p>Loading…</p>;
  const nq = normalize(q);
  const rows = [...apps]
    .reverse()
    .filter(
      (a) =>
        (!status || a.status === status) &&
        (!nq || normalize(`${a.company} ${a.title} ${a.reason} ${a.source}`).includes(nq)),
    );
  const today = apps.filter((a) => a.status === "submitted" && a.at >= new Date().setHours(0, 0, 0, 0)).length;
  const pending = apps.filter((a) => a.review && ["review", "needs", "failed"].includes(a.status)).length;
  return (
    <section>
      <h1>Applications</h1>
      <p class="intro">
        Every application YOLO made, and the ones you submitted yourself after a fill: none of these is applied to
        again. {today} submitted today.
      </p>
      {pending > 0 && (
        <p class="review-summary">
          {pending} application{pending === 1 ? " is" : "s are"} waiting for your review. Open the filled tab, check
          your answers, and submit using the site's button.{" "}
          <button class="btn small" onClick={() => setStatus("review")}>
            Show ready applications
          </button>
        </p>
      )}
      {message && (
        <p role="status" class="help">
          {message}
        </p>
      )}
      <SourceCheck />
      <div class="row">
        <input
          type="search"
          class="search"
          placeholder="Search applications"
          aria-label="Search applications"
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
        />
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">All</option>
          {Object.entries(STATUS).map(([v, t]) => (
            <option value={v}>{t}</option>
          ))}
        </select>
        <button
          type="button"
          class="btn small"
          disabled={!settings.debugLogging}
          title={
            settings.debugLogging
              ? `What YOLO filled in and saw on its last ${settings.debugLogLimit} applications`
              : "Turn on Debug logging in Behavior first"
          }
          aria-expanded={showLogs && settings.debugLogging}
          onClick={() => setShowLogs(!showLogs)}
        >
          Debug logs
        </button>
      </div>
      {showLogs &&
        settings.debugLogging &&
        (logs.length ? (
          <div class="logs">
            {[...logs].reverse().map((l) => (
              <>
                <pre class="mono">
                  {formatDateTime(l.at)} {l.text}
                </pre>
                {l.files?.map((f) => (
                  <details class="log-file">
                    <summary>
                      {f.name}{" "}
                      <button
                        type="button"
                        class="btn small"
                        onClick={(e) => {
                          e.preventDefault(); // not the details' toggle
                          download(f);
                        }}
                      >
                        Download
                      </button>
                    </summary>
                    {f.text && <pre class="mono">{f.text}</pre>}
                  </details>
                ))}
              </>
            ))}
          </div>
        ) : (
          <p class="muted">No logs yet: they're kept for YOLO applications made while Debug logging is on.</p>
        ))}
      {rows.length === 0 ? (
        <p class="muted">{apps.length ? "No matches." : "Nothing yet."}</p>
      ) : (
        <table class="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Job</th>
              <th>Status</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr>
                <td class="muted">{formatDateTime(a.at)}</td>
                <td>
                  <a
                    href={a.doneUrl || a.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      if (a.review && ["review", "needs", "failed"].includes(a.status)) {
                        e.preventDefault();
                        void reviewAction("YOLO_REVIEW_OPEN", a.key);
                      }
                    }}
                  >
                    {a.company} – {a.title || "(untitled)"}
                  </a>
                  {a.guesses.length > 0 && (
                    <details>
                      <summary class="muted">{a.guesses.length} guessed answers</summary>
                      <ul>
                        {a.guesses.map((g) => (
                          <li>
                            {g.q}: <b>{g.a}</b>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {a.notes?.map((n) => (
                    <div class="muted">{n}</div>
                  ))}
                  {a.review && <div class="muted">Review rules: {a.review.reasons.join("; ")}</div>}
                </td>
                <td>
                  {STATUS[a.status]}
                  {a.mode === "manual" || a.submittedBy === "user" ? " (by you)" : ""}
                  {a.reason && <div class="muted">{a.reason}</div>}
                </td>
                <td class="muted">{a.source}</td>
                <td>
                  {a.review && ["review", "needs", "failed"].includes(a.status) ? (
                    <div class="review-actions">
                      <button
                        type="button"
                        class="btn small primary"
                        disabled={busy === a.key || reviewTabs.refilling.includes(a.key)}
                        onClick={() =>
                          void reviewAction(
                            reviewTabs.live.includes(a.key) ? "YOLO_REVIEW_OPEN" : "YOLO_REVIEW_REFILL",
                            a.key,
                          )
                        }
                      >
                        {reviewTabs.refilling.includes(a.key)
                          ? "Refill pending…"
                          : reviewTabs.live.includes(a.key)
                            ? "Review application"
                            : "Refill for review"}
                      </button>
                      {!reviewTabs.live.includes(a.key) && (
                        <span class="help">
                          The original filled page is unavailable. Refilling may lose earlier edits.
                        </span>
                      )}
                      <details>
                        <summary class="muted">More actions</summary>
                        <button
                          type="button"
                          class="btn small"
                          disabled={busy === a.key || reviewTabs.refilling.includes(a.key)}
                          onClick={() => void reviewAction("YOLO_REVIEW_MARK_SUBMITTED", a.key)}
                        >
                          Mark submitted
                        </button>{" "}
                        <button
                          type="button"
                          class="btn small danger"
                          disabled={busy === a.key || reviewTabs.refilling.includes(a.key)}
                          onClick={() => void reviewAction("YOLO_REVIEW_DISMISS", a.key)}
                        >
                          Dismiss &amp; close tab
                        </button>
                      </details>
                    </div>
                  ) : (
                    (a.status === "needs" || a.status === "failed") && (
                      <button
                        type="button"
                        class="btn small"
                        title="Opens it in a tab and continues there"
                        onClick={() => void send({ type: "YOLO_RESUME", key: a.key })}
                      >
                        Resume
                      </button>
                    )
                  )}{" "}
                  {!(a.review && ["review", "needs", "failed"].includes(a.status)) && (
                    <button
                      type="button"
                      class="btn small danger"
                      title="Remove from the log, so YOLO may apply to it again"
                      onClick={() => void send({ type: "YOLO_FORGET", key: a.key })}
                    >
                      Forget
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {queue.length > 0 && (
        <>
          <h2>
            Queued ({queue.length}){" "}
            <button
              type="button"
              class="btn small danger"
              title="Drop every queued job for now; YOLO can queue them again when it next checks"
              onClick={() => store.set({ yoloQueue: [] })}
            >
              Clear queue
            </button>
          </h2>
          <ul class="queue">
            {queue.map((i) => (
              <li>
                <a href={i.url} target="_blank" rel="noreferrer">
                  {i.company} – {i.title}
                </a>{" "}
                <span class="muted">{i.source}</span>{" "}
                <button
                  type="button"
                  class="btn small danger"
                  title="Drop this job for now; YOLO can queue it again when it next checks"
                  aria-label={`Remove ${i.company} – ${i.title} from the queue`}
                  onClick={async () =>
                    store.set({ yoloQueue: (await store.get("yoloQueue")).filter((x) => x.key !== i.key) })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
