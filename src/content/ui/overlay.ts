// §16.1 overlay panel (top frame only): collapsed 44 px button, expandable status panel, draggable vertically.
import { ellipsize } from "../../shared/normalize";
import type { ApiError, JobBrief, NeedsYouItem, StatusCounts, UploadedDoc } from "../../shared/types";
import { el, onOutsideClick, uiLayer } from "./root";

export interface OverlayView {
  counts: StatusCounts;
  needsYou: NeedsYouItem[];
  running: boolean;
  /** The AI review is checking the answers. */
  reviewing?: boolean;
  /** Résumés and cover letters the fill uploaded, opened in a new tab on click. */
  uploads: UploadedDoc[];
  error: ApiError | null;
  model: string | null;
  debug: string;
  /** A warning about the page itself ("YOLO already applied here"). */
  notice?: string;
}

export interface OverlayHandlers {
  onRerun(): void;
  onStop(): void;
  onRetry(): void;
  onOpenSettings(): void;
  onFocus(item: NeedsYouItem): void;
  onMove(bottom: number): void;
  onOpenDoc(id: string): void;
  /** The job details an AI-made upload was written from; null when no longer kept. */
  onJobInfo(id: string): Promise<JobBrief | null>;
}

const JOB_ROWS: [keyof JobBrief, string][] = [
  ["company", "Company"],
  ["title", "Job title"],
  ["location", "Location"],
  ["url", "Page"],
  ["description", "Description"],
];

/** One job brief as label/value rows; the description scrolls on its own so the panel stays short. */
function jobRows(b: JobBrief | null): HTMLElement {
  const rows = JOB_ROWS.filter(([k]) => b?.[k]);
  if (!rows.length)
    return el("div", {
      className: "muted",
      textContent: b ? "No job details were found on the page" : "No longer available",
    });
  return el(
    "dl",
    {},
    ...rows.flatMap(([k, label]) => [
      el("dt", { textContent: label }),
      el("dd", { className: k === "description" ? "desc" : "", textContent: b![k] }),
    ]),
  );
}

export function statusLine(c: StatusCounts, running: boolean, reviewing = false): string {
  if (running && reviewing) return `Reviewing answers… ${c.total - pendingOf(c)}/${c.total}`;
  if (running) return `Filling… ${c.total - pendingOf(c)}/${c.total}`;
  return `Done · ${c.filled} filled · ${c.aiDrafted} AI draft${c.aiDrafted === 1 ? "" : "s"} · ${c.needsYou + c.failed} need you`;
}
const pendingOf = (c: StatusCounts) =>
  Math.max(0, c.total - c.filled - c.needsYou - c.failed - c.prefilled - c.skipped);

const DONE_PIN_MS = 1500; // how long the panel stays open after a run finishes

export function createOverlay(h: OverlayHandlers, initialBottom: number | null) {
  const layer = uiLayer();
  let bottom = initialBottom ?? 16;
  let expanded = false;
  let pinnedUntil = 0;
  let collapseTimer: ReturnType<typeof setTimeout> | undefined;

  const count = el("span", { className: "count" });
  const fab = el("button", { className: "fab", type: "button", title: "AutoApply" }, "A", count);
  fab.setAttribute("aria-label", "Open AutoApply panel");
  const status = el("div", { className: "status" });
  const model = el("div", { className: "muted" });
  const notice = el("div", { className: "notice" });
  const error = el("div", { className: "error" });
  const needs = el("ul", { className: "needs" });
  const files = el("ul", { className: "files" });
  // Collapsed by default and fetched on first open: what the AI was told about the job, for tailoring/cover letters.
  const jobBody = el("div");
  const jobInfo = el(
    "details",
    { className: "jobinfo" },
    el("summary", { textContent: "Job details the AI used" }),
    jobBody,
  );
  let jobDocs: UploadedDoc[] = [];
  let jobKey = "";
  const loadJob = async () => {
    const key = jobKey;
    const briefs = await Promise.all(jobDocs.map((d) => h.onJobInfo(d.id)));
    if (key !== jobKey) return;
    // The résumé and cover letter usually share one job; captions only when they were given different details.
    const shown = briefs
      .map((b, i) => ({ b, d: jobDocs[i] }))
      .filter((x, i) => briefs.findIndex((b) => JSON.stringify(b) === JSON.stringify(x.b)) === i);
    jobBody.replaceChildren(
      ...shown.flatMap(({ b, d }) => [
        ...(shown.length > 1
          ? [el("div", { className: "caption", textContent: d.kind === "resume" ? "Résumé" : "Cover letter" })]
          : []),
        jobRows(b),
      ]),
    );
  };
  jobInfo.ontoggle = () => {
    if (jobInfo.open && !jobBody.childElementCount) void loadJob();
  };
  const timings = el("pre", { className: "timings" });
  const close = el("button", { className: "icon", type: "button", textContent: "×", title: "Collapse" });
  close.setAttribute("aria-label", "Collapse panel");
  const head = el("div", { className: "head" }, el("b", { textContent: "AutoApply" }), close);
  const btn = (text: string, fn: () => void, cls = "btn") => {
    const b = el("button", { className: cls, type: "button", textContent: text });
    b.onclick = fn;
    return b;
  };
  const panel = el(
    "div",
    { className: "panel" },
    head,
    el("div", { className: "body" }, status, notice, model, error, needs, files, jobInfo, timings),
    el("div", { className: "actions" }, btn("Re-run", h.onRerun, "btn primary"), btn("Stop", h.onStop)),
  );
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "AutoApply status");
  status.setAttribute("aria-live", "polite");
  panel.dataset.testid = "autoapply-panel";
  layer.append(fab, panel);

  const render = () => {
    fab.style.bottom = panel.style.bottom = `${bottom}px`;
    fab.style.display = expanded ? "none" : "";
    panel.style.display = expanded ? "" : "none";
  };
  const expand = (v: boolean) => {
    expanded = v;
    render();
  };
  const collapse = () => {
    pinnedUntil = 0;
    expand(false);
  };
  fab.onclick = () => expand(true);
  close.onclick = collapse;
  onOutsideClick(panel, () => expanded && collapse());

  // Drag the header (or the button) vertically along the right edge.
  const drag = (handle: HTMLElement) =>
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".icon")) return;
      const startY = e.clientY;
      const start = bottom;
      let moved = false;
      const move = (ev: PointerEvent) => {
        const next = Math.max(8, Math.min(innerHeight - 60, start - (ev.clientY - startY)));
        if (Math.abs(next - bottom) > 2) moved = true;
        bottom = next;
        render();
      };
      const up = () => {
        removeEventListener("pointermove", move, true);
        removeEventListener("pointerup", up, true);
        if (moved) h.onMove(bottom);
      };
      addEventListener("pointermove", move, true);
      addEventListener("pointerup", up, true);
    });
  drag(head);
  render();

  let wasRunning = false;
  return {
    update(v: OverlayView) {
      const c = v.counts;
      status.textContent = statusLine(c, v.running, v.reviewing);
      model.textContent = v.model ? `Model: ${v.model}` : "";
      notice.textContent = v.notice ?? "";
      notice.style.display = v.notice ? "" : "none";
      count.textContent = v.error ? "!" : String(v.needsYou.length || c.filled);
      count.style.background = v.error ? "var(--red)" : v.needsYou.length ? "" : "var(--green)";
      count.style.color = v.error ? "#fff" : "";
      error.style.display = v.error ? "" : "none";
      error.replaceChildren();
      if (v.error) {
        error.append(el("div", { textContent: v.error.message }));
        const fix =
          v.error.kind === "noKey" || v.error.kind === "noModel" || v.error.kind === "modelGone"
            ? btn("Open settings", h.onOpenSettings)
            : btn("Retry", h.onRetry);
        error.append(el("div", { className: "actions" }, fix));
      }
      needs.replaceChildren(
        ...v.needsYou.map((n) => {
          const label = n.label || "(unlabeled field)";
          const b = el(
            "button",
            { type: "button", textContent: ellipsize(label, 110) },
            el("span", { textContent: n.note }),
          );
          b.onclick = () => h.onFocus(n);
          return el("li", {}, b);
        }),
      );
      files.replaceChildren(
        ...v.uploads.map((d) => {
          const b = el(
            "button",
            { type: "button", textContent: ellipsize(d.fileName, 110), title: "Open in a new tab" },
            el("span", { textContent: d.kind === "resume" ? "Résumé submitted" : "Cover letter submitted" }),
          );
          b.onclick = () => h.onOpenDoc(d.id);
          return el("li", {}, b);
        }),
      );
      const ai = v.uploads.filter((d) => d.ai);
      jobInfo.style.display = ai.length ? "" : "none";
      if (ai.map((d) => d.id).join() !== jobKey) {
        jobKey = ai.map((d) => d.id).join();
        jobDocs = ai;
        jobBody.replaceChildren();
        if (jobInfo.open && ai.length) void loadJob();
      }
      timings.textContent = v.debug;
      timings.style.display = v.debug ? "" : "none";
      // Auto-expand while filling and for DONE_PIN_MS after it ends.
      if (v.running || v.error) {
        panel.classList.remove("done");
        pinnedUntil = Infinity;
        expand(true);
      } else if (wasRunning) {
        panel.classList.add("done"); // plays the finish animation (styles.css)
        pinnedUntil = Date.now() + DONE_PIN_MS;
        clearTimeout(collapseTimer);
        collapseTimer = setTimeout(() => {
          if (Date.now() >= pinnedUntil) expand(false);
        }, DONE_PIN_MS);
      }
      wasRunning = v.running;
    },
    expand,
    toggle() {
      pinnedUntil = 0;
      expand(!expanded);
    },
  };
}

export type Overlay = ReturnType<typeof createOverlay>;
