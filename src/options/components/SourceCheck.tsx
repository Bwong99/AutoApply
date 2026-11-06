import { formatDateTime } from "../../shared/time";
import { SOURCE_NAMES, type SourceGroupCheck, type SourceLevel } from "../../shared/yolo";
import { useStored } from "../store";

/** Shape and word for each level, so colour never carries the meaning alone. */
const LEVELS: Record<SourceLevel, [icon: string, word: string]> = {
  ok: ["✓", "Working"],
  info: ["i", "Note"],
  warn: ["!", "Problem"],
  error: ["✕", "Failed"],
};
const TEXT: Record<SourceLevel, string> = { ok: "muted", info: "muted", warn: "warn-text", error: "err" };
/** An unfinished check older than this was cut off (the browser closed, or the worker stopped). */
const STALE_MS = 30 * 60_000;

function Group(props: { g: SourceGroupCheck; ended: boolean; finished: boolean }) {
  const { g, ended, finished } = props;
  const level: SourceLevel | null = g.done ? g.level : null;
  const counts = !g.done
    ? ended
      ? "Not read"
      : "Reading…"
    : !g.found
      ? "0 found"
      : finished
        ? `${g.found} found · ${g.fresh} new · ${g.matched} match your filters · ${g.queued} queued`
        : `${g.found} found${ended ? "" : " · filtering…"}`;
  const drops = Object.entries(g.drops).sort((a, b) => b[1] - a[1]);
  return (
    <details class="source">
      <summary>
        <span class={`source-icon ${level ?? "pending"}`} aria-hidden="true">
          {level ? LEVELS[level][0] : "…"}
        </span>
        <span class="sr-only">{level ? LEVELS[level][1] : ended ? "Not read" : "Checking"}: </span>
        <b>{SOURCE_NAMES[g.group]}</b> <span class="muted">{counts}</span>
        {g.problem && <span class={`source-problem ${level ? TEXT[level] : "muted"}`}>{g.problem}</span>}
      </summary>
      <ul class="source-rows">
        {g.rows.map((r) => (
          <li>
            {r.label} <span class="muted">· {r.found} found</span>
            {r.problem && <span class={TEXT[r.level]}> · {r.problem}</span>}
          </li>
        ))}
      </ul>
      {drops.length > 0 && (
        <p class="muted source-drops">Not queued: {drops.map(([why, n]) => `${why} (${n})`).join(" · ")}</p>
      )}
    </details>
  );
}

/** The latest discovery's per-source report: what each enabled source read and why it queued what it did. */
export function SourceCheck() {
  const c = useStored("yoloSourceCheck");
  if (!c) return null;
  const running = !c.doneAt && Date.now() - c.at < STALE_MS;
  const ended = !running;
  const finished = !!c.doneAt && !c.error;
  const problems = c.groups.filter((g) => g.level === "warn" || g.level === "error").length;
  const queued = c.groups.reduce((n, g) => n + g.queued, 0);
  const outcome = running
    ? "Checking sources…"
    : c.error
      ? `Didn't finish: ${c.error}`
      : !c.doneAt
        ? "Didn't finish"
        : `${queued} queued`;
  return (
    // Opens itself only for problems; a user's own open or close is left alone otherwise.
    <details class="card source-check" open={problems > 0} aria-busy={running}>
      <summary>
        <b>Last source check</b>{" "}
        <span class="muted">
          {formatDateTime(c.at)} ({c.topUp ? "top-up" : "batch start"})
        </span>{" "}
        <span role="status" class={c.error || (ended && !c.doneAt) ? "err" : undefined}>
          · {outcome}
          {problems > 0 && ` · ${problems} source${problems === 1 ? "" : "s"} with problems`}
        </span>
      </summary>
      {c.groups.length ? (
        c.groups.map((g) => <Group g={g} ended={ended} finished={finished} />)
      ) : (
        <p class="muted">No sources were on.</p>
      )}
    </details>
  );
}
