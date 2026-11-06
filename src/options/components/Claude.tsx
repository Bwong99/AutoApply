import { useEffect, useState } from "preact/hooks";
import { isErr, send } from "../../shared/messages";
import type { AiTask, ClaudeTask } from "../../shared/settings";
import { formatDateTime } from "../../shared/time";
import type { ClaudeModel, Settings } from "../../shared/types";
import { installerScript, setupCommand, uninstallCommand, type SetupOs } from "../claudeSetup";
import { save, useStored } from "../store";

const PROVIDERS: [Settings["aiProvider"], string, string][] = [
  [
    "gemini",
    "Gemini",
    "Free API keys from Google AI Studio. Calls go directly from your browser to Google Gemini; keys are sent only to Google, never to web pages or content scripts.",
  ],
  [
    "claude",
    "Claude",
    "Your Claude Pro or Max plan, through Claude Code on this computer. No API key; usage counts against your plan's limits.",
  ],
];

/** Which AI answers every feature: autofill, essays, cover letters, résumé import and YOLO. */
export function ProviderPicker() {
  const s = useStored("settings");
  if (!s) return null;
  return (
    <section class="panel-box">
      <h2>Provider</h2>
      <div class="seg" role="radiogroup" aria-label="AI provider">
        {PROVIDERS.map(([v, t]) => (
          <button
            type="button"
            role="radio"
            aria-checked={s.aiProvider === v}
            class={s.aiProvider === v ? "on" : ""}
            onClick={() => void save({ settings: { ...s, aiProvider: v } })}
          >
            {t}
          </button>
        ))}
      </div>
      <p class="help">{PROVIDERS.find(([v]) => v === s.aiProvider)?.[2]}</p>
    </section>
  );
}

type Check = { state: "busy" | "ok" | "err"; text: string } | null;

export function ClaudeConnect() {
  const ready = useStored("claudeReady");
  const [os, setOs] = useState<SetupOs | "unsupported">();
  const [copied, setCopied] = useState(false);
  const [check, setCheck] = useState<Check>(null);
  const test = async (restarted?: boolean) => {
    setCheck({ state: "busy", text: "Asking Claude Code…" });
    const r = await send({ type: "CLAUDE_TEST", restarted });
    setCheck(
      isErr(r)
        ? { state: "err", text: `✗ ${r.error.message}` }
        : { state: "ok", text: `✓ Connected · ${r.model} · answered in ${(r.ms / 1000).toFixed(1)} s` },
    );
  };
  useEffect(() => {
    void chrome.runtime
      .getPlatformInfo()
      .then(({ os }) => setOs(os === "win" || os === "mac" || os === "linux" ? os : "unsupported"));
    // Reopened by the restart that finishes connecting (background CLAUDE_TEST): finish the test Connect began.
    if (location.search === "?claude-restarted") {
      history.replaceState(null, "", location.pathname + location.hash);
      void test(true);
    }
  }, []);
  if (!os) return null;
  if (os === "unsupported")
    return (
      <section class="panel-box">
        <h2>Connect Claude Code</h2>
        <p class="err">Claude needs Windows, macOS or Linux: Claude Code doesn't run on this device.</p>
      </section>
    );
  const id = chrome.runtime.id;
  const command = setupCommand(os, id);

  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };
  const connect = async () => {
    // First, inside the click: Chrome only shows the permission prompt for a user gesture.
    const granted = await chrome.permissions.request({ permissions: ["nativeMessaging"] }).catch(() => false);
    if (!granted) return setCheck({ state: "err", text: "✗ AutoApply needs that permission to talk to Claude Code." });
    await test();
  };

  return (
    <section class="panel-box">
      <h2>Connect Claude Code</h2>
      <p>
        AutoApply runs Claude Code, Anthropic's app for your terminal, signed in with your own Claude plan. Your sign-in
        stays inside Claude Code: AutoApply only hands it prompts, with its tools, plugins and memory switched off and
        nothing saved.
      </p>
      <ol class="claude-steps">
        <li>
          <b>Install Claude Code and sign in.</b> Follow the{" "}
          <a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noreferrer">
            install guide
          </a>
          , then run <code>claude</code> once in a terminal and sign in with your Claude account.
        </li>
        <li>
          <b>Install AutoApply's bridge to it.</b> Paste this into {os === "win" ? "PowerShell" : "Terminal"} and press
          Enter:
          <pre class="cmd">{command}</pre>
          <button type="button" class="btn small" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy command"}
          </button>
          <details>
            <summary>What this runs</summary>
            <pre class="cmd tall">{installerScript(os, id)}</pre>
          </details>
          <details>
            <summary>Uninstall</summary>
            <pre class="cmd">{uninstallCommand(os)}</pre>
          </details>
        </li>
        <li>
          <b>Connect.</b> Chrome asks once to let AutoApply talk to apps on this computer, then AutoApply restarts and
          reopens this page.{" "}
          <button
            type="button"
            class="btn primary small"
            disabled={check?.state === "busy"}
            onClick={() => void connect()}
          >
            {ready ? "Test connection" : "Connect"}
          </button>
          {check ? (
            <p class={check.state === "err" ? "err" : check.state === "ok" ? "ok" : "muted"} role="status">
              {check.text}
            </p>
          ) : (
            ready && <p class="ok">✓ Connected</p>
          )}
        </li>
      </ol>
    </section>
  );
}

/** Until Claude Code has listed its models (not connected yet, or a bridge set up before model lists). */
const BUILT_IN: [string, string][] = [
  ["haiku", "Haiku (fastest)"],
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["fable", "Fable (may use usage credits)"],
];
/** True of an alias whichever model it points to. */
const NOTES: Record<string, string> = { haiku: "fastest", fable: "may use usage credits" };

/** [value, label, description] for one task's model select, Default first. */
function modelOptions(listed: ClaudeModel[], chosen: string): [string, string, string?][] {
  const names = listed.map((m) => m.displayName);
  const opts: [string, string, string?][] = listed.length
    ? listed.map((m) => {
        const dup = names.indexOf(m.displayName) !== names.lastIndexOf(m.displayName);
        const notes = [dup && m.value, NOTES[m.value]].filter(Boolean);
        return [m.value, notes.length ? `${m.displayName} (${notes.join(", ")})` : m.displayName, m.description];
      })
    : BUILT_IN;
  // A choice Claude Code no longer lists stays shown, rather than the select silently showing another.
  if (chosen && !opts.some(([v]) => v === chosen)) opts.push(BUILT_IN.find(([v]) => v === chosen) ?? [chosen, chosen]);
  return [["", "Default"], ...opts];
}
const EFFORTS: [ClaudeTask["effort"], string][] = [
  ["", "Default"],
  ["low", "Low (fastest)"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
];
const TASKS: [AiTask, string, string][] = [
  [
    "fill",
    "Autofill & YOLO screening",
    "Field answers, dropdown picks, the answer check, and YOLO's job relevance check. A fill waits on these.",
  ],
  ["write", "Essays & cover letters", "Drafted essay answers and tailored cover letter PDFs."],
  ["resume", "Résumé import", "Reading your résumé into the profile (Prefill)."],
  [
    "review",
    "Answer review & YOLO navigation",
    "Page reviews enabled separately in Behavior and YOLO Mode, and YOLO's independently enabled AI navigation on unfamiliar pages. Accuracy matters most here: the strongest model and effort you have.",
  ],
];

export function ClaudeModels() {
  const s = useStored("settings");
  const ready = useStored("claudeReady");
  const listed = useStored("claudeModels") ?? [];
  const fetchedAt = useStored("claudeModelsFetchedAt") ?? 0;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState("");
  const refresh = async (force: boolean) => {
    setRefreshing(true);
    const r = await send({ type: "CLAUDE_MODELS", force });
    setRefreshErr(isErr(r) ? r.error.message : "");
    setRefreshing(false);
  };
  // Once connected, Claude Code's own list: new models show up without an AutoApply update.
  useEffect(() => {
    if (ready) void refresh(false);
  }, [ready]);
  if (!s) return null;
  const set = (task: AiTask, patch: Partial<ClaudeTask>) =>
    void save({ settings: { ...s, claude: { ...s.claude, [task]: { ...s.claude[task], ...patch } } } });
  return (
    <section class="panel-box">
      <h2>Models</h2>
      <p>
        A model and effort for each kind of work; Default uses Claude Code's own setting. Haiku at Low effort answers
        fastest; larger models and higher effort are slower and use more of your plan's limits.
      </p>
      {ready && (
        <div class="row">
          <button type="button" class="btn" onClick={() => void refresh(true)} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh list"}
          </button>
          <span class="muted">Last updated {fetchedAt ? formatDateTime(fetchedAt) : "never"}</span>
        </div>
      )}
      {ready && refreshErr && <p class="err">{refreshErr}</p>}
      <table class="table">
        <thead>
          <tr>
            <th>Work</th>
            <th>Model</th>
            <th>Effort</th>
          </tr>
        </thead>
        <tbody>
          {TASKS.map(([k, label, help]) => (
            <tr>
              <td>
                {label}
                <div class="help">{help}</div>
              </td>
              <td>
                <select
                  aria-label={`${label}: model`}
                  value={s.claude[k].model}
                  onChange={(e) => set(k, { model: e.currentTarget.value })}
                >
                  {modelOptions(listed, s.claude[k].model).map(([v, t, d]) => (
                    <option value={v} title={d}>
                      {t}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <select
                  aria-label={`${label}: effort`}
                  value={s.claude[k].effort}
                  onChange={(e) => set(k, { effort: e.currentTarget.value as ClaudeTask["effort"] })}
                >
                  {EFFORTS.map(([v, t]) => (
                    <option value={v}>{t}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
