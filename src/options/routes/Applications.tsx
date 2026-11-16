import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { namesPosting } from "../../background/yolo/jobKey";
import { send, type Responses } from "../../shared/messages";
import { normalize } from "../../shared/normalize";
import { formatDateTime } from "../../shared/time";
import { FORGETTABLE, isResumable, RESUMABLE, SOURCE_NAMES, type Application } from "../../shared/yolo";
import { readPosting } from "../posting";
import { useStored } from "../store";
import { QueuedJobs } from "../components/QueuedJobs";
import { SourceCheck } from "../components/SourceCheck";
import { ApplicationSummary } from "../components/ApplicationSummary";

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
  const [reviewTabs, setReviewTabs] = useState<Responses["YOLO_REVIEW_LIST"]>({
    live: [],
    refilling: [],
    resumeAll: "",
  });
  const [busy, setBusy] = useState("");
  const [forgetting, setForgetting] = useState<"" | (typeof FORGETTABLE)[number]>("");
  const [resuming, setResuming] = useState<"" | (typeof RESUMABLE)[number]>("");
  const stopDialog = useRef<HTMLDialogElement>(null);
  const blank = { url: "", company: "", title: "" };
  const [addOpen, setAddOpen] = useState(false);
  const [added, setAdded] = useState(blank);
  // Company and title are asked for only when the posting's page doesn't name them.
  const [askDetails, setAskDetails] = useState(false);
  const [addError, setAddError] = useState("");
  const [addedText, setAddedText] = useState("");
  const [adding, setAdding] = useState<"" | "reading" | "adding">("");
  const addToggle = useRef<HTMLButtonElement>(null);
  const addForm = useRef<HTMLFormElement>(null);
  // autofocus is ignored on inputs added after load: the first empty field, on opening and when details are asked.
  useLayoutEffect(
    () => addForm.current?.querySelector<HTMLInputElement>("input:invalid")?.focus(),
    [addOpen, askDetails],
  );
  const openAdd = (open: boolean) => {
    setAddOpen(open);
    setAdded(blank);
    setAskDetails(false);
    setAddError("");
    if (open) setAddedText("");
    else addToggle.current?.focus();
  };
  const addApplication = async (e: Event) => {
    e.preventDefault();
    if (adding) return;
    setAddError("");
    const url = added.url.trim();
    if (!namesPosting(url)) return setAddError("Enter the link to the job posting itself.");
    let job = added;
    if (!askDetails) {
      setAdding("reading");
      job = { ...(await readPosting(url)), url };
      if (!job.company || !job.title) {
        setAdding("");
        setAdded(job);
        setAskDetails(true);
        return;
      }
    }
    setAdding("adding");
    await send({ type: "YOLO_ADD_APPLICATION", job })
      .then((r) => {
        if ("error" in r) return setAddError(r.error.message);
        openAdd(false);
        setAddedText(`Added ${job.company.trim()} – ${job.title.trim()}.`);
      })
      .catch(() => setAddError("Couldn't add it. Try again."))
      .finally(() => setAdding(""));
  };
  const resumeAll = async (status: (typeof RESUMABLE)[number], count: number) => {
    if (resuming || !count) return;
    setResuming(status);
    await send({ type: "YOLO_RESUME_PENDING", status })
      .then(loadReviews)
      .catch(() => undefined)
      .finally(() => setResuming(""));
  };
  const stopResuming = async (now: boolean) => {
    await send({ type: "YOLO_RESUME_STOP", now }).catch(() => undefined);
    loadReviews();
  };
  // Asked only while an application is being resumed: with none running, stopping can't cut one short.
  const askStopResuming = async () => {
    const list = await send({ type: "YOLO_REVIEW_LIST" }).catch(() => null);
    if (list?.resumeAll === "running") stopDialog.current?.showModal();
    else await stopResuming(false);
  };
  const forgetAll = async (status: (typeof FORGETTABLE)[number], count: number) => {
    const marked = `marked "${STATUS[status]}"`;
    if (
      forgetting ||
      !count ||
      !window.confirm(
        `Forget ${count} application${count === 1 ? "" : "s"} ${marked}? This removes every application ${marked} from your history, including those hidden by filters. YOLO can queue these jobs again the next time it checks. This cannot be undone.`,
      )
    )
      return;
    setForgetting(status);
    await send({ type: "YOLO_FORGET_ALL", status })
      .catch(() => undefined)
      .finally(() => setForgetting(""));
  };
  const loadReviews = () =>
    void send({ type: "YOLO_REVIEW_LIST" })
      .then(setReviewTabs)
      .catch(() => undefined);
  useEffect(() => {
    if (!apps?.some((a) => a.review || isResumable(a))) return;
    loadReviews();
    window.addEventListener("focus", loadReviews);
    return () => window.removeEventListener("focus", loadReviews);
  }, [apps, yoloState?.reviewUpdatedAt]);
  // Resume all can move on without the history changing (a run parked for the user is recorded before it ends): Stop
  // follows its run starting or ending and its queue.
  const resumingAll = !!reviewTabs.resumeAll;
  useEffect(() => {
    if (!resumingAll) return;
    const changed = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (
        area === "session" &&
        ("yoloPendingResumes" in c || (c.yoloRun && !c.yoloRun.oldValue !== !c.yoloRun.newValue))
      )
        loadReviews();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => chrome.storage.onChanged.removeListener(changed);
  }, [resumingAll]);
  const applicationAction = async (
    type: "YOLO_REVIEW_OPEN" | "YOLO_REVIEW_REFILL" | "YOLO_REVIEW_DISMISS" | "YOLO_MARK_SUBMITTED",
    key: string,
  ) => {
    setBusy(key);
    await send({ type, key })
      .then(loadReviews)
      .catch(() => undefined)
      .finally(() => setBusy(""));
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
  const pending = apps.filter((a) => a.review && ["review", "needs", "failed"].includes(a.status)).length;
  return (
    <section>
      <div class="applications-heading">
        <h1>Applications</h1>
        <QueuedJobs queue={queue} />
      </div>
      <p class="intro">
        Every application YOLO made, the ones you submitted yourself after a fill, and the ones you added: none of these
        are applied to again.
      </p>
      <ApplicationSummary applications={apps} batchAt={yoloState?.batchAt ?? 0} />
      {pending > 0 && (
        <p class="review-summary">
          {pending} application{pending === 1 ? " is" : "s are"} waiting for your review. Open the filled tab, check
          your answers, and submit using the site's button.{" "}
          <button class="btn small" onClick={() => setStatus("review")}>
            Show ready applications
          </button>
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
          ref={addToggle}
          title="Record a job you applied to outside AutoApply, so YOLO never applies to it"
          aria-expanded={addOpen}
          aria-controls="add-application"
          onClick={() => openAdd(!addOpen)}
        >
          Add application
        </button>
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
        <div class="resume-all" role="group" aria-labelledby="resume-all-label">
          <span id="resume-all-label">Resume all</span>
          {RESUMABLE.map((status) => {
            const count = apps.filter((a) => a.status === status).length;
            return (
              <button
                type="button"
                class="btn small primary"
                disabled={!!resuming || count === 0}
                title={`Resume every application marked "${STATUS[status]}", including those hidden by filters, one at a time`}
                onClick={() => void resumeAll(status, count)}
              >
                {resuming === status ? "Queueing resumes…" : `${STATUS[status]} (${count})`}
              </button>
            );
          })}
          {reviewTabs.resumeAll && (
            <button
              type="button"
              class="btn small danger"
              title="Stop resuming the remaining applications"
              aria-haspopup="dialog"
              onClick={() => void askStopResuming()}
            >
              Stop
            </button>
          )}
        </div>
        <dialog
          ref={stopDialog}
          class="stop-resuming"
          aria-labelledby="stop-resuming-title"
          aria-describedby="stop-resuming-description"
          onClose={(e) => {
            const choice = e.currentTarget.returnValue;
            e.currentTarget.returnValue = "";
            if (choice) void stopResuming(choice === "now");
          }}
        >
          <form method="dialog">
            <h2 id="stop-resuming-title">Stop resuming all?</h2>
            <p id="stop-resuming-description" class="help">
              An application is being resumed now. Stopping now closes its tab before it finishes, and it keeps its
              current status.
            </p>
            <div class="row">
              <button class="btn small" value="">
                Cancel
              </button>
              <button class="btn small" value="after">
                Stop after this application
              </button>
              <button class="btn small danger" value="now">
                Stop now
              </button>
            </div>
          </form>
        </dialog>
        <div class="forget-all" role="group" aria-labelledby="forget-all-label">
          <span id="forget-all-label">Forget all</span>
          {FORGETTABLE.map((status) => {
            const count = apps.filter((a) => a.status === status).length;
            return (
              <button
                type="button"
                class="btn small danger"
                disabled={!!forgetting || count === 0}
                title={`Remove every application marked "${STATUS[status]}" from the history, including those hidden by filters, so YOLO can queue them again`}
                onClick={() => void forgetAll(status, count)}
              >
                {forgetting === status ? "Forgetting…" : `${STATUS[status]} (${count})`}
              </button>
            );
          })}
        </div>
      </div>
      {addOpen ? (
        <form
          ref={addForm}
          id="add-application"
          class="add-application"
          aria-label="Add an application you submitted yourself"
          onSubmit={(e) => void addApplication(e)}
          onKeyDown={(e) => e.key === "Escape" && openAdd(false)}
        >
          <div class="row">
            <input
              type="url"
              class="add-application-link"
              required
              placeholder="Paste the job posting link"
              aria-label="Job posting link"
              aria-describedby="add-application-help"
              value={added.url}
              onInput={(e) => {
                // Another link is another posting: its page is read again.
                setAdded({ ...blank, url: e.currentTarget.value });
                setAskDetails(false);
              }}
            />
            {askDetails &&
              (
                [
                  ["company", "Company"],
                  ["title", "Job title"],
                ] as const
              ).map(([k, label]) => (
                <input
                  required
                  placeholder={label}
                  aria-label={label}
                  value={added[k]}
                  onInput={(e) => setAdded({ ...added, [k]: e.currentTarget.value })}
                />
              ))}
            <button type="submit" class="btn small primary" disabled={!!adding}>
              {adding === "reading" ? "Reading posting…" : adding === "adding" ? "Adding…" : "Add"}
            </button>
            <button type="button" class="btn small" onClick={() => openAdd(false)}>
              Cancel
            </button>
          </div>
          <p class="help" id="add-application-help">
            {askDetails
              ? "That page doesn't name its company and job title. Enter them, so YOLO won't apply to this job again through another site."
              : "A job you applied to outside AutoApply: YOLO won't apply to it. The company and job title are read from the posting."}
          </p>
          {addError && (
            <p role="alert" class="err">
              {addError}
            </p>
          )}
        </form>
      ) : (
        addedText && (
          <p role="status" class="ok">
            {addedText}
          </p>
        )
      )}
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
        <div class="applications-table-scroll" role="region" aria-label="Application history" tabIndex={0}>
          <table class="table applications-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Job</th>
                <th>Status</th>
                <th>Source</th>
                <th scope="col" class="application-actions-cell">
                  Actions
                </th>
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
                          void applicationAction("YOLO_REVIEW_OPEN", a.key);
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
                  <td class="muted">{a.source === "added" ? SOURCE_NAMES.added : a.source}</td>
                  <td class="application-actions-cell">
                    <div
                      class="application-actions"
                      role="group"
                      aria-label={`Actions for ${a.company} – ${a.title || "(untitled)"}`}
                    >
                      {a.review && ["review", "needs", "failed"].includes(a.status) ? (
                        <div class="review-actions">
                          <button
                            type="button"
                            class="btn small primary"
                            disabled={busy === a.key || reviewTabs.refilling.includes(a.key)}
                            onClick={() =>
                              void applicationAction(
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
                              class="btn small danger"
                              disabled={busy === a.key || reviewTabs.refilling.includes(a.key)}
                              onClick={() => void applicationAction("YOLO_REVIEW_DISMISS", a.key)}
                            >
                              Dismiss &amp; close tab
                            </button>
                          </details>
                        </div>
                      ) : (
                        (a.status === "needs" || a.status === "failed") && (
                          <button
                            type="button"
                            class="btn small primary"
                            disabled={reviewTabs.refilling.includes(a.key)}
                            title="Opens it in a tab and continues there"
                            onClick={() => void send({ type: "YOLO_RESUME", key: a.key })}
                          >
                            {reviewTabs.refilling.includes(a.key) ? "Resume pending…" : "Resume"}
                          </button>
                        )
                      )}
                      {a.status !== "submitted" && (
                        <button
                          type="button"
                          class="btn small"
                          disabled={busy === a.key}
                          title="Record that you already submitted this application on the job site"
                          onClick={() => void applicationAction("YOLO_MARK_SUBMITTED", a.key)}
                        >
                          Mark submitted
                        </button>
                      )}
                      {!(a.review && ["review", "needs", "failed"].includes(a.status)) && (
                        <button
                          type="button"
                          class="btn small danger forget"
                          title="Remove from the log, so YOLO may apply to it again"
                          onClick={() => void send({ type: "YOLO_FORGET", key: a.key })}
                        >
                          Forget
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
