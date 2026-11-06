import { useEffect, useState } from "preact/hooks";
import { ensureContentScript, isErr, send, type TabStatusResponse } from "../shared/messages";
import { formatTime } from "../shared/time";
import type { StatusCounts } from "../shared/types";
import { createStorage } from "../shared/storage";
import type { YoloStatus } from "../shared/yolo";

const store = createStorage("popup");

export function statusText(r: TabStatusResponse | null): string {
  const frames = Object.values(r?.status?.frames ?? {});
  if (!frames.length) return "Not a job form";
  if (frames.some((f) => f.running)) return "Working…";
  const err = frames.find((f) => f.error)?.error;
  if (err) return `Error: ${err}`;
  const c = frames.reduce<StatusCounts>(
    (a, f) => {
      for (const k of Object.keys(a) as (keyof StatusCounts)[]) a[k] += f.counts[k];
      return a;
    },
    { total: 0, filled: 0, aiMatched: 0, aiDrafted: 0, needsYou: 0, failed: 0, prefilled: 0, skipped: 0 },
  );
  if (!c.total) return "Not a job form";
  const need = c.needsYou + c.failed;
  return `Filled ${c.filled}/${c.total}${need ? ` · ${need} need you` : ""}`;
}

export function yoloText(y: YoloStatus): string {
  if (!y.enabled) return "Finds new jobs matching your searches and applies to them in the background.";
  return [
    y.running ? `Applying: ${y.running}` : y.nextCheckAt ? `Next batch ${formatTime(y.nextCheckAt)}` : "",
    y.preparedBatch
      ? `${y.appliedBatch} submitted · ${y.preparedBatch} prepared for review this batch`
      : `${y.appliedBatch}/${y.batchSize} applied this batch`,
    y.pendingReviews ? `${y.pendingReviews} awaiting your review` : "",
    y.queued ? `${y.queued} queued` : "",
    y.needsYou ? `${y.needsYou} need you` : "",
    y.paused,
  ]
    .filter(Boolean)
    .join(" · ");
}

const openOptions = (hash: string) =>
  void chrome.tabs.create({ url: chrome.runtime.getURL(`src/options/index.html#${hash}`) });

export function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null>(null);
  const [info, setInfo] = useState<TabStatusResponse | null>(null);
  const [msg, setMsg] = useState("");
  const [yolo, setYolo] = useState<YoloStatus | null>(null);
  const [startingBatch, setStartingBatch] = useState(false);
  const [batchError, setBatchError] = useState("");

  const host = (() => {
    try {
      return new URL(tab?.url ?? "").hostname;
    } catch {
      return "";
    }
  })();

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t ?? null));
    const loadYolo = () => void send({ type: "YOLO_STATUS" }).then(setYolo);
    loadYolo();
    // A source check finishing after turn-on lands here, so its warning shows while the popup is open.
    return store.onChange(["yoloState"], loadYolo);
  }, []);

  const setYoloOn = async (enabled: boolean) => {
    setBatchError("");
    const r = await send({ type: "YOLO_SET", enabled });
    // Turning it on with no résumé for its upload mode is refused.
    setMsg(isErr(r) ? r.error.message : "");
    setYolo(await send({ type: "YOLO_STATUS" }));
  };

  const forceBatch = async () => {
    if (startingBatch) return;
    setStartingBatch(true);
    setBatchError("");
    try {
      const r = await send({ type: "YOLO_FORCE_BATCH" });
      if (isErr(r)) setBatchError(r.error.message);
      setYolo(await send({ type: "YOLO_STATUS" }));
    } catch {
      setBatchError("Couldn't start a batch. Please try again.");
    } finally {
      setStartingBatch(false);
    }
  };

  useEffect(() => {
    if (tab?.id === undefined) return;
    const load = () => void send({ type: "TAB_STATUS", tabId: tab.id! }).then(setInfo);
    load();
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [tab?.id]);

  const fill = async () => {
    if (tab?.id === undefined) return;
    try {
      const reachable = await ensureContentScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_FILL", force: true });
      setMsg(reachable ? "" : "Part of this page can't be filled until you reload it.");
    } catch {
      setMsg("This page can't be filled (reload it, or it's a browser page).");
    }
  };

  return (
    <div class="popup">
      <h1 class="brand">
        <a href="https://github.com/ExxML/AutoApply" target="_blank" rel="noreferrer">
          <img src="/icons/48.png" alt="" width={24} height={24} /> AutoApply
        </a>
      </h1>
      <div class="host">{host || "No page"}</div>
      <div class="status" role="status">
        {statusText(info)}
      </div>
      <button type="button" class="btn primary" onClick={() => void fill()} disabled={!host}>
        Fill this page
      </button>
      {msg && <p class="err">{msg}</p>}
      <div class="meta">
        {info?.ready ? "Ready" : "Setup needed"} · Model: {info?.model ?? "none"}
        {info?.provider !== "claude" && ` · ${info?.keysTotal ?? 0} keys · ${info?.keysHealthy ?? 0} healthy`}
      </div>
      {yolo && (
        <button
          type="button"
          // Nothing to search yet: the card leads to setup instead of acting as a switch.
          role={yolo.searches || yolo.enabled ? "switch" : undefined}
          aria-checked={yolo.searches || yolo.enabled ? yolo.enabled : undefined}
          aria-labelledby="yolo-label"
          aria-describedby="yolo-help"
          class={`yolo${yolo.enabled ? " on" : ""}`}
          onClick={() => void (yolo.searches || yolo.enabled ? setYoloOn(!yolo.enabled) : openOptions("/yolo"))}
        >
          <span class="yolo-head">
            <span id="yolo-label">YOLO Mode</span>
            <span class={`btn small${yolo.enabled ? " primary" : ""}`}>{yolo.enabled ? "On" : "Off"}</span>
          </span>
          <span id="yolo-help" class="help">
            {yolo.searches ? yoloText(yolo) : "Add a job search query to turn it on"}
          </span>
          {yolo.warnings.map((w) => (
            <span class="help err" role="alert">
              {w}
            </span>
          ))}
        </button>
      )}
      {yolo?.enabled && !!yolo.sourceProblems && (
        <p class="help err">
          {yolo.sourceProblems} source{yolo.sourceProblems === 1 ? "" : "s"} had problems at the last check.{" "}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              openOptions("/applications");
            }}
          >
            See report
          </a>
        </p>
      )}
      {yolo?.enabled && yolo.searches > 0 && (
        <div class="yolo-actions">
          <button
            type="button"
            class="btn"
            onClick={() => void forceBatch()}
            disabled={startingBatch}
            aria-describedby="force-batch-help"
            aria-busy={startingBatch}
          >
            {startingBatch ? "Starting batch…" : "Force start batch"}
          </button>
          <p id="force-batch-help" class="help">
            Starts a new batch now and resets the next batch timer.
          </p>
          {batchError && (
            <p class="err" role="alert">
              {batchError}
            </p>
          )}
        </div>
      )}
      <div class="links">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            openOptions("/profile/personal");
          }}
        >
          Edit profile
        </a>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            openOptions("/applications");
          }}
        >
          Applications
        </a>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void chrome.runtime.openOptionsPage();
          }}
        >
          Settings
        </a>
      </div>
    </div>
  );
}
