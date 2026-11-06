// One YOLO application on one live job URL, headless, with the real built extension.
// usage: node tools/yolo-sweep/run.mjs <url> [outPrefix]
// env: REAL=1 (submit for real; default is the dry build that stops before the final Submit)
//      PORT (CDP port, default random), MAXMIN (timeout minutes, default 10), TITLE/COMPANY (listing meta),
//      TABHOST=<host> (run in a background tab, not the hidden frame), YOLO='{json}' (YOLO setting overrides),
//      AI_PROVIDER (default: the export's, or gemini when that is the Claude bridge, which needs the native host),
//      EARLY=<js file> (evaluated in the page every 2 s), EXP=<js file> (evaluated at the end instead of the dump),
//      EXPHOST=<substring> (which frame/page EXP and the final dump target)
// Writes <out>.report.txt (compact, read this first), <out>.json (summary), <out>.log (SW + step log),
// <out>.html (final DOM, grep it), <out>.ai.json (AI requests/responses), <out>.snaps.txt (every page's dump).
import fs from "node:fs";
import path from "node:path";
import {
  ACCOUNT_KINDS,
  STATE,
  extDir,
  kindOfUrl,
  loadExport,
  mkdirp,
  nameFor,
  profileChecks,
  tenantOf,
} from "./lib.mjs";
import { DUMP, launch, pageLines, providerFor, reviewLines, seed } from "./harness.mjs";

const [url, outArg] = process.argv.slice(2);
if (!url) throw new Error("usage: node tools/yolo-sweep/run.mjs <url> [outPrefix]");
const real = process.env.REAL === "1";
const ext = extDir(real);
if (!fs.existsSync(path.join(ext, "manifest.json")))
  throw new Error(`No build at ${ext}: run node tools/yolo-sweep/build.mjs${real ? " --real" : ""}`);
const out = outArg ?? path.join(mkdirp(path.join(STATE, "runs", "adhoc")), nameFor(url));
mkdirp(path.dirname(out));
const kind = kindOfUrl(url);
const port = process.env.PORT ?? String(9300 + Math.floor(Math.random() * 600));
const log = [];
const say = (...a) => {
  const s = a.join(" ");
  log.push(s);
  if (process.env.VERBOSE) console.log(s);
};
const exp = loadExport();
const provider = providerFor(exp);

// Account-based ATSs keep a browser profile per tenant (the password vault lives in it) and a plus address,
// so reruns sign in instead of hitting "account already exists".
let profileDir = "";
const yoloOver = {};
if (ACCOUNT_KINDS.has(kind)) {
  profileDir = mkdirp(path.join(STATE, "profiles", `${real ? "real" : "dry"}-${kind}-${tenantOf(url)}`));
  // A persistent profile caches the extension's service worker: a rebuilt extension would not load.
  fs.rmSync(path.join(profileDir, "Default", "Service Worker"), { recursive: true, force: true });
  const base = exp.yolo?.email || exp.profile?.personal?.email || "";
  if (base.includes("@") && process.env.PLUS !== "0")
    yoloOver.email = base.replace(/(\+[^@]*)?@/, (_, tag) => `${tag ? tag + "-" : "+"}${tenantOf(url)}@`);
}

const { ctx, sw } = await launch(ext, profileDir, port, say);
const yolo = {
  ...exp.yolo,
  enabled: true,
  batchSize: 1,
  dailyCap: 40,
  aiRelevanceCheck: false,
  careerSites: [],
  boards: [],
  feeds: [],
  ...yoloOver,
  ...(process.env.YOLO ? JSON.parse(process.env.YOLO) : {}),
};
const meta = { company: process.env.COMPANY, title: process.env.TITLE, tab: process.env.TABHOST };
await seed(
  sw,
  exp,
  { aiProvider: provider },
  {
    yoloQueue: [
      {
        key: url,
        alt: "",
        url,
        company: meta.company ?? new URL(url).hostname,
        title: meta.title ?? "Software Engineer Intern",
        location: "",
        source: "careers",
        postedAt: 1,
        addedAt: Date.now(),
      },
    ],
    applications: [],
    yoloRejected: {},
    yoloState: {},
    yoloInFlight: null,
    yoloTabHosts: meta.tab ? [meta.tab] : [],
  },
);
await sw.evaluate(async (yolo) => {
  chrome.offscreen.closeDocument = async () => {}; // keep the hidden frame for the final dump
  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === "YOLO_STEP")
      console.log(
        "YOLO FACTS",
        JSON.stringify({
          path: m.facts.path,
          h: m.facts.headings.slice(-80),
          al: m.facts.alerts.slice(0, 160),
          f: m.facts.fields,
          req: m.facts.requiredFields,
          on: m.facts.onward,
          ap: m.facts.applyKind,
        }),
      );
  });
  await chrome.storage.local.set({ yolo: { ...yolo, enabled: false } });
  await chrome.storage.local.set({ yolo });
}, yolo);

const THIRD =
  /google|recaptcha|hcaptcha|doubleclick|facebook|linkedin\.com|cloudflare|stripe|youtube|vimeo|hotjar|cookielaw|onetrust/;
const targets = async () =>
  (await (await fetch(`http://localhost:${port}/json/list`)).json()).filter(
    (x) => /^https?:/.test(x.url) && (x.type === "iframe" || x.type === "page") && !THIRD.test(new URL(x.url).hostname),
  );
async function evalIn(t, expression, ms = 1500) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j), setTimeout(j, ms)));
  const r = await new Promise((res) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id === 1) res(d);
    };
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
    setTimeout(() => res({}), ms * 4);
  });
  ws.close();
  return r.result?.result?.value;
}

// Snapshot every page every 2 s and keep each step's last one: multi-step forms (Workday) leave earlier steps.
const t0 = Date.now();
const snaps = new Map();
const snapper = setInterval(async () => {
  try {
    for (const t of await targets()) {
      if (process.env.EARLY) await evalIn(t, fs.readFileSync(process.env.EARLY, "utf8")).catch(() => {});
      const v = JSON.parse((await evalIn(t, DUMP).catch(() => null)) ?? "null");
      if (v?.rows.length) snaps.set(`${new URL(t.url).pathname}|${v.step || v.heading}`, v);
    }
  } catch {
    /* page navigating */
  }
}, 2000);

const maxMs = Number(process.env.MAXMIN ?? 10) * 60_000;
let last = "";
let s;
let steps = [];
let host = "";
let timedOut = true;
while (Date.now() - t0 < maxMs) {
  await new Promise((r) => setTimeout(r, 3000));
  s = await sw.evaluate(async () => ({
    run: (await chrome.storage.session.get("yoloRun")).yoloRun,
    apps: (await chrome.storage.local.get("applications")).applications ?? [],
    q: (await chrome.storage.local.get("yoloQueue")).yoloQueue ?? [],
    st: (await chrome.storage.local.get("yoloState")).yoloState,
  }));
  if (s.run) {
    steps = s.run.steps.map((x) => String(x).split("|")[0]);
    host = s.run.host;
  }
  const line = `${s.run ? `${s.run.host} [${steps.join(">")}] ${String(s.run.steps.slice(-1)[0] ?? "(loading)").slice(0, 200)}` : "idle"} | done ${s.apps.length} | queue ${s.q.length} ${s.st?.pauseReason ?? ""}`;
  if (line !== last) say(`[${Math.round((Date.now() - t0) / 1000)}s] ${line}`);
  last = line;
  if (!s.run && !s.q.length && s.apps.length >= 1) {
    timedOut = false;
    break;
  }
}
clearInterval(snapper);
const elapsed = Math.round((Date.now() - t0) / 1000);

// Final state of the page that ran (hidden frame or tab).
let final = null;
let finalUrl = "";
try {
  const cand = await targets();
  const t =
    (process.env.EXPHOST && cand.find((x) => x.url.includes(process.env.EXPHOST))) ||
    cand.find((x) => new URL(x.url).hostname === new URL(url).hostname) ||
    cand.at(-1);
  if (t) {
    finalUrl = t.url;
    if (process.env.EXP) say(`--- EXP ${t.url}\n${await evalIn(t, fs.readFileSync(process.env.EXP, "utf8"), 5000)}`);
    final = JSON.parse((await evalIn(t, DUMP, 5000)) ?? "null");
    fs.writeFileSync(`${out}.html`, (await evalIn(t, "document.documentElement.outerHTML", 5000)) ?? "");
  }
} catch (e) {
  say("final dump failed", e.message);
}
const o = await sw.evaluate(async () => ({
  apps: (await chrome.storage.local.get("applications")).applications ?? [],
  ai: globalThis.__log,
}));
await ctx.close();

// ---- compact report ----
const a = o.apps[0];
const reason = a?.reason ?? "";
const dry = /^Dry run before/.test(reason);
const status = timedOut ? "TIMEOUT" : !a ? "ERROR" : dry ? "DRY-OK" : a.status.toUpperCase();
const checks = profileChecks(exp.profile ?? {});
const pages = [...snaps.values()];
if (final?.rows.length && !pages.some((p) => p.url === final.url && p.step === final.step)) pages.push(final);
const lines = [
  `URL ${url}`,
  `KIND ${kind} | HOST ${host || "?"} | ${elapsed}s | ${real ? "REAL" : "DRY"} | provider ${provider}`,
  `RESULT ${status}${dry ? "" : reason ? " — " + reason.split("\n")[0].slice(0, 300) : ""}${a?.doneUrl ? " — done " + a.doneUrl : ""}`,
  `STEPS ${steps.join(" > ") || "(none)"}`,
];
const answers = [
  // Profile fills ("[filled]") show in the page rows already.
  ...(dry
    ? reason
        .split("\n")
        .slice(1)
        .filter((x) => x.trim() && !x.endsWith("[filled]"))
    : []),
  ...(a?.guesses ?? []).map((g) => `${g.q} = ${g.a} (guess)`),
];
if (answers.length) lines.push(`AI ANSWERS (${answers.length})`, ...answers.map((x) => "  " + x.slice(0, 200)));
if (a?.notes?.length) lines.push(`NOTES`, ...a.notes.map((n) => "  " + n.slice(0, 400)));
const rv = reviewLines(o.ai);
if (rv.length) lines.push(`REVIEW`, ...rv);
const pl = pageLines(pages, checks);
const flags = pl.flags;
lines.push(...pl.lines);
if (status !== "SUBMITTED" && status !== "DRY-OK" && final)
  lines.push(`--- FINAL TEXT ${final.text.slice(0, 600)}`, `BUTTONS ${final.buttons.join(" ; ")}`);
const summary = {
  url,
  kind,
  name: path.basename(out),
  status,
  reason: reason.split("\n")[0].slice(0, 300),
  flags,
  elapsed,
  finalUrl,
  out,
};
fs.writeFileSync(`${out}.report.txt`, lines.join("\n") + "\n");
fs.writeFileSync(`${out}.json`, JSON.stringify(summary, null, 1));
fs.writeFileSync(`${out}.log`, log.join("\n"));
fs.writeFileSync(`${out}.ai.json`, JSON.stringify(o.ai ?? [], null, 1));
fs.writeFileSync(`${out}.snaps.txt`, pages.map((p) => JSON.stringify(p)).join("\n"));
console.log(`${status} flags=${flags} ${elapsed}s ${url}\n  report: ${out}.report.txt`);
process.exit(0);
