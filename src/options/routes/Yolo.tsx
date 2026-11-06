import { useEffect, useState } from "preact/hooks";
import { Field, NumberInput, SelectInput, TagInput, TextInput, Toggle } from "../components/controls";
import { save, useStored } from "../store";
import { isErr, send, type Responses } from "../../shared/messages";
import { SubmissionReview } from "../components/SubmissionReview";
import { formatDateTime } from "../../shared/time";
import {
  BOARDS,
  MAX_BATCH_APPLICATIONS,
  type Board,
  type QueueSort,
  type SourceGroup,
  type Yolo as YoloConfig,
} from "../../shared/yolo";

const BOARD_NAMES: Record<Board, string> = { linkedin: "LinkedIn", indeed: "Indeed", glassdoor: "Glassdoor" };
const SOURCE_NAMES: Record<SourceGroup, string> = {
  careers: "Company career sites",
  feeds: "GitHub job lists",
  ...BOARD_NAMES,
  jobright: "Jobright",
};
const SORT_NAMES: [QueueSort, string][] = [
  ["newest", "Newest posted first"],
  ["oldest", "Oldest posted first"],
  ["foundFirst", "First found first"],
  ["foundLast", "Last found first"],
  ["random", "Random"],
];

function QueueOrder(props: { y: YoloConfig; set: (p: Partial<YoloConfig>) => void }) {
  const { y, set } = props;
  const move = (i: number, to: number) => {
    const o = y.sourceOrder.slice();
    [o[i], o[to]] = [o[to], o[i]];
    set({ sourceOrder: o });
  };
  return (
    <div>
      <SelectInput
        label="Apply order"
        help="Which queued job YOLO applies to next. Newest first gets you in among the early applicants. Jobs whose source gives no posting date count as posted when found."
        value={y.queueSort}
        options={SORT_NAMES}
        onChange={(v) => set({ queueSort: v as QueueSort })}
      />
      <Toggle
        label="Rank by source first"
        help="Applies to every job from the top source, in the order above, before any from the next."
        checked={y.queueBySource}
        onChange={(queueBySource) => set({ queueBySource })}
      />
      {y.queueBySource && (
        <ol class="order">
          {y.sourceOrder.map((g, i) => (
            <li>
              <span>{SOURCE_NAMES[g]}</span>
              <button
                type="button"
                class="btn small"
                disabled={i === 0}
                aria-label={`Move ${SOURCE_NAMES[g]} up`}
                onClick={() => move(i, i - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                class="btn small"
                disabled={i === y.sourceOrder.length - 1}
                aria-label={`Move ${SOURCE_NAMES[g]} down`}
                onClick={() => move(i, i + 1)}
              >
                ↓
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Accounts() {
  const [rows, setRows] = useState<Responses["YOLO_ACCOUNTS"]>([]);
  const [shown, setShown] = useState<Record<string, string>>({});
  const load = () => void send({ type: "YOLO_ACCOUNTS" }).then(setRows);
  useEffect(load, []);
  if (!rows.length) return <p class="muted">None yet. YOLO creates one when a site requires it (Workday does).</p>;
  return (
    <table class="table">
      <thead>
        <tr>
          <th>Site</th>
          <th>Email</th>
          <th>Created</th>
          <th>Password</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr>
            <td>{a.site}</td>
            <td>{a.email}</td>
            <td class="muted">{formatDateTime(a.createdAt)}</td>
            <td>
              {shown[a.site] ? (
                <code>{shown[a.site]}</code>
              ) : (
                <button
                  type="button"
                  class="btn small"
                  onClick={async () => {
                    const r = await send({ type: "YOLO_REVEAL", site: a.site });
                    setShown({ ...shown, [a.site]: isErr(r) ? r.error.message : r.password });
                  }}
                >
                  Reveal
                </button>
              )}
            </td>
            <td>
              <button
                type="button"
                class="btn small danger"
                onClick={() => void send({ type: "YOLO_DELETE_ACCOUNT", site: a.site }).then(load)}
              >
                Forget
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Gmail(props: { y: YoloConfig; set: (p: Partial<YoloConfig>) => void }) {
  const state = useStored("yoloState");
  const [error, setError] = useState("");
  const redirect = chrome.identity?.getRedirectURL() ?? "";
  // Gmail can be disconnected from Google's side: ask once per visit. Later failures arrive through yoloState.
  const ready = !!(props.y.gmailClientId && props.y.gmailClientSecret);
  useEffect(() => {
    if (ready) void send({ type: "YOLO_GMAIL_CHECK" });
  }, []);
  const status = error || (state?.gmailNeedsAuth ? "Gmail needs to be reconnected." : "");
  return (
    <div class="field wide">
      <TextInput
        label="Gmail OAuth client ID"
        value={props.y.gmailClientId}
        onInput={(v) => props.set({ gmailClientId: v.trim() })}
        placeholder="1234-abc.apps.googleusercontent.com"
        help="Optional. Lets YOLO read (read-only) the verification emails job sites send when it creates accounts for you. Without it, emailed codes still work if the YOLO email's Gmail is signed in to this browser, but sites that email a verification link are left for you to finish."
      />
      <TextInput
        label="Gmail OAuth client secret"
        type="password"
        value={props.y.gmailClientSecret}
        onInput={(v) => props.set({ gmailClientSecret: v.trim() })}
        placeholder="GOCSPX-…"
        help="From the same client. With it, YOLO stays connected through extension reloads and browser restarts."
      />
      <details class="help">
        <summary>Set up the client (once, about 5 minutes)</summary>
        <ol>
          <li>In Google Cloud Console, create a project and enable the Gmail API.</li>
          <li>OAuth consent screen: External.</li>
          <li>
            Branding: any app name; any email for the support and developer contacts (it doesn't matter: no one but you
            can use this app, since it needs your client ID and secret); no logo (a logo needs Google's review);
            homepage <code>https://exxml.github.io/AutoApply</code>; privacy policy{" "}
            <code>https://exxml.github.io/AutoApply/PRIVACY</code>.
          </li>
          <li>
            Audience → Publish app: while it's in Testing, Google ends the sign-in every 7 days. Skip verification.
            Google calls the app unverified when you sign in: Advanced → Go to (your app).
          </li>
          <li>
            Credentials → Create OAuth client ID → Web application, with this authorized redirect URI:{" "}
            <code>{redirect}</code>
          </li>
          <li>
            Paste the client ID and secret above, then press Connect and sign in with the Gmail account the YOLO email
            arrives in.
          </li>
          <li>If this extension's folder moves, its redirect URI changes: update it in the client.</li>
        </ol>
      </details>
      <div class="row">
        <button
          type="button"
          class="btn"
          disabled={!ready}
          onClick={async () => {
            const r = await send({ type: "YOLO_GMAIL_CONNECT" });
            setError(isErr(r) ? r.error.message : "");
          }}
        >
          Connect Gmail
        </button>{" "}
        <span class={status ? "err" : "ok"} role="status">
          {status || (state?.gmailConnected ? "Connected." : "")}
        </span>
      </div>
    </div>
  );
}

/** What each choice does, and what it costs. */
const REAL_CHOICES: [YoloConfig["realInput"], string, string][] = [
  [
    "off",
    "Off",
    "Script input only. No permission, no debugging bar, fastest. Bot checks can tell script events from a person’s, so graded sites may score the application lower.",
  ],
  [
    "clicks",
    "Clicks",
    "Real mouse movement over the form and real Next/Submit clicks. Covers what score checks weigh most (the submit click and the pointer before it) for little cost: the bar shows for about 3–5 seconds per press.",
  ],
  [
    "typing",
    "Typing",
    "Real keystrokes into text answers (long answers are pasted in one go, as a person would). Adds about 60 ms per character of short answers, and the bar shows while the page is filled. Clicks stay script-made.",
  ],
  [
    "both",
    "Both",
    "Real typing and real clicks: the most human-looking, and the slowest, with the bar showing for the whole fill and submit.",
  ],
];

function RealInput(props: { y: YoloConfig; set: (p: Partial<YoloConfig>) => void }) {
  return (
    <Field
      label="Real input on bot-checked pages"
      help="Only on pages a bot check grades (an invisible CAPTCHA or bot-detection service), and only in a tab (never the hidden frame). AutoApply drives Chrome’s debugger there, so the check sees a person’s events, not a script’s. While it does, Chrome shows “AutoApply started debugging this browser” on every window; it closes 3 s after the last click or key. Pressing Cancel on that bar stops it for that job (script input from then on)."
      extra={
        <ul class="help">
          {REAL_CHOICES.map(([, name, text]) => (
            <li>
              <b>{name}:</b> {text}
            </li>
          ))}
        </ul>
      }
    >
      {(id) => (
        <select
          id={id}
          value={props.y.realInput}
          onChange={(e) => {
            const realInput = e.currentTarget.value as YoloConfig["realInput"];
            props.set({ realInput });
          }}
        >
          {REAL_CHOICES.map(([v, name]) => (
            <option value={v}>{name}</option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function Yolo() {
  const y = useStored("yolo");
  const state = useStored("yoloState");
  if (!y) return <p>Loading…</p>;
  const set = (patch: Partial<YoloConfig>) => void save({ yolo: { ...y, ...patch } });
  const urls = (v: string[]) => v.filter((u) => /^https?:\/\//i.test(u));
  return (
    <section class="yolo">
      <h1>YOLO Mode</h1>
      <p class="intro">
        While on, AutoApply runs a batch on a timer: it checks your searches and applies to new matching jobs by itself:
        it creates site accounts when needed, fills every field (with its best guess where your profile has no answer),
        and submits unless your review rules hold the final step for you. Automatic submissions use a hidden page;
        applications that may need your review use inactive tabs. Everything it does is listed under Applications, with
        the answers it guessed. Turn it on or off from the toolbar popup.
      </p>
      <h2>Schedule</h2>
      <div class="form">
        <NumberInput
          label="Apply batch every (minutes)"
          value={y.intervalMin}
          min={5}
          max={1440}
          onChange={(intervalMin) => set({ intervalMin })}
        />
        <NumberInput
          label="Applications per batch"
          help={`Each batch prepares for review or submits up to this many, in your queue order. With this schedule, at most ${Math.floor(1440 / y.intervalMin) * y.batchSize} a day. Higher numbers mean more AI usage, a bigger chance a job site flags or bans your account, and more bad submissions before you notice a mistake. 0 finds jobs without applying.`}
          value={y.batchSize}
          min={0}
          max={MAX_BATCH_APPLICATIONS}
          onChange={(batchSize) => set({ batchSize })}
        />
      </div>
      <h2>Search</h2>
      <div class="form">
        <TagInput
          label="Search queries"
          help='A job matches a query when its title contains every word of it, in any order (plurals and synonyms count: "intern" matches "Internship" and "Co-op"). A job needs to match only one query, so add one query per role, e.g. "software intern" and "data intern". Each query is searched separately on every job board.'
          value={y.queries}
          onChange={(queries) => set({ queries })}
        />
        <TagInput
          label="Locations"
          help={`Countries, regions or cities, e.g. "Canada", "Ontario", "Seattle". Empty: anywhere. A country includes its regions and cities ("Canada" matches "Kelowna"). "London" matches every London; enter "London, ON" or "London, UK" for one. Can miss: small towns listed alone, jobs listing just "London" when you entered "London, ON" (a bare name means its biggest namesake), and jobs naming only a country when you entered a city. Prefer full names over codes like "CA".`}
          value={y.locations}
          onChange={(locations) => set({ locations })}
        />
        <Toggle label="Include remote jobs" checked={y.remoteOk} onChange={(remoteOk) => set({ remoteOk })} />
        <NumberInput
          label="Posted within (days)"
          value={y.postedWithinDays}
          min={1}
          max={90}
          onChange={(postedWithinDays) => set({ postedWithinDays })}
        />
        <TagInput
          label="Skip titles with"
          value={y.excludeTitleWords}
          onChange={(excludeTitleWords) => set({ excludeTitleWords })}
        />
        <TagInput label="Skip companies" value={y.skipCompanies} onChange={(skipCompanies) => set({ skipCompanies })} />
        <Toggle
          label="Check matches with AI"
          help="After the filters above, one AI call per check (up to 60 jobs) screens each job's title, company and location against your queries, education, work authorization, country and relocation preference. It drops a job at a different level than your queries (e.g. a full-time role on an intern search), or one that rules you out: a degree you aren't pursuing (PhD- or MBA-only), a class year or graduation window you don't fit, or a citizenship or clearance requirement you don't meet. It doesn't read job descriptions, so it only catches what those fields show. When unsure, or if the AI call fails, it keeps the job. A dropped job is skipped without asking the AI again for the days set below. Turning this off stops new checks, but jobs already dropped stay skipped until those days pass."
          checked={y.aiRelevanceCheck}
          onChange={(aiRelevanceCheck) => set({ aiRelevanceCheck })}
        />
        <NumberInput
          label="Remember AI rejections (days)"
          help="How long a job the AI dropped is skipped before the AI is asked about it again (if it's still posted). Fewer days give a dropped job another chance sooner, at the cost of more AI usage. Changes apply from the next check, to jobs already dropped too."
          value={y.aiRejectDays}
          min={1}
          max={365}
          onChange={(aiRejectDays) => set({ aiRejectDays })}
        />
      </div>
      <h2>Sources</h2>
      <div class="form">
        <div>
          {BOARDS.map((b) => (
            <>
              <Toggle
                label={BOARD_NAMES[b]}
                help={
                  b === "indeed"
                    ? "Searches Indeed as you, so it needs you signed in to indeed.com in this browser. When Indeed asks for a bot check, that search opens in a background tab in the collapsed AutoApply group for a few seconds."
                    : undefined
                }
                checked={y.boards.includes(b)}
                onChange={(on) => set({ boards: on ? [...y.boards, b] : y.boards.filter((x) => x !== b) })}
              />
              {b === "indeed" && y.boards.includes("indeed") && state?.indeedSignedOut && (
                <p class="err" role="status">
                  Indeed answered as signed out at the last check. Sign in to indeed.com in this browser to get its
                  jobs.
                </p>
              )}
              {b === "indeed" && y.boards.includes("indeed") && !state?.indeedSignedOut && state?.indeedBlocked && (
                <p class="err" role="status">
                  Indeed showed a bot check instead of results at the last check, so it added no jobs. YOLO doesn't
                  solve these; using indeed.com yourself in this browser may clear it before the next batch.
                </p>
              )}
            </>
          ))}
          <Toggle
            label="Jobright"
            help="Reads your Jobright recommendations (jobright.ai/jobs/recommend), filtered by the roles and places in your Jobright preferences rather than your queries. Needs you signed in to jobright.ai in this browser; the other filters here still apply."
            checked={y.jobright.length > 0}
            onChange={(on) => set({ jobright: on ? ["recommendations"] : [] })}
          />
          {y.jobright.length > 0 && state?.jobrightSignedOut && (
            <p class="err" role="status">
              Jobright answered as signed out at the last check. Sign in to jobright.ai in this browser to get its jobs.
            </p>
          )}
        </div>
        <TagInput
          label="GitHub job lists"
          help="Raw URLs of a listings.json (SimplifyJobs format) or a README with a job table."
          value={y.feeds}
          onChange={(v) => set({ feeds: urls(v) })}
        />
        <TagInput
          label="Company career sites"
          help='Enter the exact page that lists jobs, not a homepage. Workday, Greenhouse, Lever, Ashby and SmartRecruiters board URLs are read through their APIs. Any other page is opened once in a hidden page and its job links are read off it; it does not click through or page. For those, use a search results URL, with "{q}" where the query goes (e.g. https://jobs.example.com/search?q={q}).'
          value={y.careerSites}
          onChange={(v) => set({ careerSites: urls(v) })}
        />
        <QueueOrder y={y} set={set} />
      </div>
      <SubmissionReview y={y} set={set} />
      <h2>Applying</h2>
      <div class="form">
        <TextInput
          label="YOLO email"
          type="email"
          value={y.email}
          onInput={(email) => set({ email: email.trim() })}
          help="Used for site accounts and on applications YOLO sends. Empty: your profile's email."
        />
        <Gmail y={y} set={set} />
        <Toggle
          label="Use emailed access codes"
          help="When a site won't go on until you type a code it emailed to the YOLO email, YOLO reads it from Gmail and types it. Off: those applications are left for you."
          checked={y.emailCodes}
          onChange={(emailCodes) => set({ emailCodes })}
        />
        <Toggle
          label="Open job verification links"
          help="When an account or a submitted application won't go through until you open a link a site emailed, YOLO opens it. Only links to the job's own sites (or a mail service's click-tracking link that lands there), and only when the application is blocked on it. Needs the Gmail client ID above. Off: those applications are left for you."
          checked={y.verifyLinks}
          onChange={(verifyLinks) => set({ verifyLinks })}
        />
        <Toggle
          label="Retry in a background tab"
          help="Sites that refuse to work hidden or show a CAPTCHA there are retried in an inactive tab (in a collapsed “AutoApply” group), closed when done. Their later jobs start in one."
          checked={y.tabFallback}
          onChange={(tabFallback) => set({ tabFallback })}
        />
        <RealInput y={y} set={set} />
        <Toggle
          label="Write optional cover letters"
          help="Required cover-letter uploads always get a PDF written for the job when Documents has none. On: optional ones do too."
          checked={y.optionalCoverLetters}
          onChange={(optionalCoverLetters) => set({ optionalCoverLetters })}
        />
        <div class="form ai-controls">
          <SelectInput
            label="Upload résumés"
            help="YOLO always uploads a résumé. Variant select: the résumé PDF in Documents that best fits the job (fast, no AI). AI tailor: your LaTeX résumé, tailored to the job by the AI (slower, uses tokens); if tailoring fails, the untailored version is uploaded."
            value={y.resumeUpload}
            options={[
              ["variants", "Variant select"],
              ["tailor", "AI tailor"],
            ]}
            onChange={(v) => set({ resumeUpload: v as YoloConfig["resumeUpload"] })}
          />
          <Toggle
            label="Review YOLO fills with AI"
            help="Checks each filled page and corrects mistakes before continuing. Adds time and AI usage; choose the review model under AI. Off: skips the review after filling."
            checked={y.reviewFills}
            onChange={(reviewFills) => set({ reviewFills })}
          />
          <Toggle
            label="Use AI navigation when stuck"
            help="Uses AI to find the next step when standard navigation gets stuck, such as an unfamiliar Apply or Next button. Adds time and AI usage; uses the review model under AI. Off: uses standard navigation only."
            checked={y.aiNavigation}
            onChange={(aiNavigation) => set({ aiNavigation })}
          />
        </div>
      </div>
      <h2>Already applied</h2>
      <div class="form">
        <Toggle
          label="Re-apply to jobs I submitted myself"
          help="Off: YOLO skips jobs you applied to after an AutoApply fill."
          checked={y.reapplyManual}
          onChange={(reapplyManual) => set({ reapplyManual })}
        />
        <Toggle
          label="Warn me on jobs YOLO applied to"
          help="When you fill a posting YOLO already submitted, the AutoApply panel says so."
          checked={y.warnOnYoloApplied}
          onChange={(warnOnYoloApplied) => set({ warnOnYoloApplied })}
        />
      </div>
      <h2>Site accounts</h2>
      <p class="intro">
        Passwords are encrypted with a key that never leaves this browser, and not included in exports.
      </p>
      <Accounts />
    </section>
  );
}
