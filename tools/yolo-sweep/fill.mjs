// Manual autofill (YOLO off) on one live job URL, headless: reach the form, press Fill the way the popup does,
// wait for the overlay's "Done", and report every field. Multi-page forms: clicks Next and fills each page.
// usage: node tools/yolo-sweep/fill.mjs <url> [outPrefix]
// env: REAL=1 (click the final Submit after filling: applies to the job), MAXMIN (fill timeout per page, default 3),
//      PAGES (most form pages to fill, default 6), EXP=<js file> (evaluated in every frame at the end), VERBOSE=1
// Writes the same files as run.mjs: <out>.report.txt (read first), .json, .log, .html, .ai.json, .snaps.txt.
import fs from "node:fs";
import path from "node:path";
import { STATE, extDir, kindOfUrl, loadExport, mkdirp, nameFor, profileChecks } from "./lib.mjs";
import { DUMP, launch, pageLines, providerFor, reviewLines, seed } from "./harness.mjs";

const [url, outArg] = process.argv.slice(2);
if (!url) throw new Error("usage: node tools/yolo-sweep/fill.mjs <url> [outPrefix]");
const real = process.env.REAL === "1";
// Manual fill doesn't use the YOLO driver, so the dry build behaves like the store build here.
const ext = extDir(false);
if (!fs.existsSync(path.join(ext, "manifest.json")))
  throw new Error(`No build at ${ext}: run node tools/yolo-sweep/build.mjs`);
const out = outArg ?? path.join(mkdirp(path.join(STATE, "runs", "adhoc")), "manual-" + nameFor(url));
mkdirp(path.dirname(out));
const log = [];
const say = (...a) => {
  const s = a.join(" ");
  log.push(s);
  if (process.env.VERBOSE) console.log(s);
};
const exp = loadExport();
const provider = providerFor(exp);
const t0 = Date.now();
const since = () => `[${Math.round((Date.now() - t0) / 1000)}s]`;

const { ctx, sw } = await launch(ext, "", null, say);
await seed(
  sw,
  exp,
  { aiProvider: provider, showBadges: true },
  { yolo: { ...exp.yolo, enabled: false }, applications: [] },
);

const THIRD =
  /google|recaptcha|hcaptcha|doubleclick|facebook|linkedin\.com|cloudflare|stripe|youtube|vimeo|hotjar|cookielaw|onetrust/;
const APPLY =
  /^\s*(apply( now| for this (job|position|role)| here| online)?|i'?m interested|start (your )?application|easy apply)\s*$/i;
const NEXT = /^\s*(next( step| page)?|continue|save (and|&) continue|proceed)\s*$/i;
const SUBMIT = /^\s*(submit( (my )?application)?|send( application)?|apply|complete application)\s*$/i;
let page;
// Follow "Apply" links that open a new tab, but only from the job's own tab (the extension opens its setup tab too).
const follow = (p) => {
  page = p;
  p.on("popup", follow);
};
follow(await ctx.newPage());
const settle = async () => {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
};
const frames = () => page.frames().filter((f) => /^https?:/.test(f.url()) && !THIRD.test(new URL(f.url()).hostname));
async function dumpAll() {
  const res = [];
  for (const f of frames()) {
    const v = JSON.parse((await f.evaluate(DUMP).catch(() => null)) ?? "null");
    if (v) res.push({ f, v });
  }
  return res;
}
const fieldCount = (d) => d.reduce((n, { v }) => n + v.rows.filter((r) => r.kind !== "upload").length, 0);
async function clickText(re) {
  for (const f of frames()) {
    const b = f.locator("a,button,[role=button],input[type=submit]").filter({ hasText: re }).filter({ visible: true });
    const inputs = f.locator("input[type=submit]").filter({ visible: true });
    for (const loc of [b, inputs]) {
      for (let i = 0; i < Math.min(await loc.count(), 10); i++) {
        const el = loc.nth(i);
        const text = (await el.innerText().catch(() => "")) || (await el.getAttribute("value")) || "";
        if (!re.test(text)) continue;
        await el.click({ timeout: 5000 }).catch(() => {});
        return text.trim();
      }
    }
  }
  return null;
}

/** Press Fill in every frame (the popup's TRIGGER_FILL) and wait for the overlay to say Done. */
async function fillOnce() {
  await sw.evaluate(async (url) => {
    const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url ?? ""));
    const tab = tabs.find((t) => t.url === url) ?? tabs.at(-1);
    if (tab?.id === undefined) throw new Error(`No tab for ${url}`);
    const tabId = tab.id;
    const fr = await chrome.scripting
      .executeScript({ target: { tabId, allFrames: true }, func: () => 0 })
      .catch(() => []);
    await Promise.all(
      fr.map(async ({ frameId }) => {
        // A content script answers only after it has loaded its config; frames without one never do.
        for (let i = 0; i < 100; i++) {
          if (
            await chrome.tabs.sendMessage(tabId, { type: "TRIGGER_FILL", force: true }, { frameId }).catch(() => null)
          )
            return;
          await new Promise((r) => setTimeout(r, 50));
        }
      }),
    );
  }, page.url());
  const status = page.locator("autoapply-root .panel .status");
  const end = Date.now() + Number(process.env.MAXMIN ?? 3) * 60_000;
  // A form that changes page without reloading still shows the last "Done": wait for "Filling…" first.
  for (
    const t = Date.now() + 5000;
    Date.now() < t && !/^Filling/.test((await status.textContent().catch(() => "")) ?? "");
  )
    await page.waitForTimeout(200);
  while (Date.now() < end) {
    const text = (await status.textContent().catch(() => "")) ?? "";
    if (/^Done ·/.test(text)) return text;
    await page.waitForTimeout(500);
  }
  return null;
}

const nav = [];
let status = "FILLED";
let overlay = "";
const pages = [];
const badges = [];
try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle();
  // The harness stands in for the user: it opens the form ("Apply") before pressing Fill.
  for (let hop = 0; hop < 2 && fieldCount(await dumpAll()) < 3; hop++) {
    const clicked = await clickText(APPLY);
    if (!clicked) break;
    nav.push(`clicked "${clicked}"`);
    await page.waitForTimeout(1500);
    await settle();
  }
  if (fieldCount(await dumpAll()) < 3) status = "NO-FORM";
  for (let n = 0; status === "FILLED" && n < Number(process.env.PAGES ?? 6); n++) {
    const done = await fillOnce();
    say(since(), `page ${n + 1}: ${done ?? "fill timed out"}`);
    if (!done) status = "TIMEOUT";
    overlay = done ?? overlay;
    await page.waitForTimeout(1000);
    for (const { v } of await dumpAll()) if (v.rows.length) pages.push(v);
    for (const f of frames()) {
      const b = await f
        .evaluate(() =>
          [...(document.querySelector("autoapply-root")?.shadowRoot?.querySelectorAll(".tag") ?? [])]
            .filter((t) => /yellow|orange|red/.test(t.dataset.color ?? ""))
            .map((t) => `${t.dataset.color} ${t.getAttribute("aria-label")}`),
        )
        .catch(() => []);
      badges.push(...b);
    }
    if (status !== "FILLED") break;
    const next = await clickText(NEXT);
    if (!next) break;
    nav.push(`clicked "${next}"`);
    await page.waitForTimeout(1500);
    await settle();
  }
  if (real && status === "FILLED") {
    const sub = await clickText(SUBMIT);
    nav.push(sub ? `clicked "${sub}"` : "no submit button");
    await page.waitForTimeout(8000);
    const txt = (await page.innerText("body").catch(() => "")).slice(0, 3000);
    status = sub && /thank|received|submitted|success/i.test(txt) ? "SUBMITTED" : "SUBMIT-UNCONFIRMED";
  }
} catch (e) {
  status = "ERROR";
  say("error", e.message);
}
const final = await dumpAll();
const main = final.sort((a, b) => b.v.rows.length - a.v.rows.length)[0];
if (process.env.EXP)
  for (const f of frames())
    say(
      `--- EXP ${f.url().slice(0, 120)}\n${await f.evaluate(fs.readFileSync(process.env.EXP, "utf8")).catch((e) => e.message)}`,
    );
fs.writeFileSync(`${out}.html`, (await main?.f.content().catch(() => "")) ?? "");
const ai = await sw.evaluate(() => globalThis.__log).catch(() => []);
const elapsed = Math.round((Date.now() - t0) / 1000);
await ctx.close();

const pl = pageLines(pages, profileChecks(exp.profile ?? {}));
const lines = [
  `URL ${url}`,
  `KIND ${kindOfUrl(url)} | MANUAL | ${elapsed}s | ${real ? "REAL" : "NO SUBMIT"} | provider ${provider}`,
  `RESULT ${status}`,
  `OVERLAY ${overlay || "(none)"}`,
  `NAV ${nav.join(" > ") || "(form on the page)"}`,
];
if (badges.length)
  lines.push(`BADGES not filled (${badges.length})`, ...[...new Set(badges)].map((b) => "  ~ " + b.slice(0, 200)));
const rv = reviewLines(ai);
if (rv.length) lines.push(`REVIEW`, ...rv);
lines.push(...pl.lines);
if (status !== "FILLED" && status !== "SUBMITTED" && main)
  lines.push(`--- FINAL TEXT ${main.v.text.slice(0, 600)}`, `BUTTONS ${main.v.buttons.join(" ; ")}`);
const flags = pl.flags + badges.length;
const summary = {
  url,
  kind: kindOfUrl(url),
  name: path.basename(out),
  status,
  reason: overlay,
  flags,
  elapsed,
  finalUrl: main?.v.url ?? "",
  out,
};
fs.writeFileSync(`${out}.report.txt`, lines.join("\n") + "\n");
fs.writeFileSync(`${out}.json`, JSON.stringify(summary, null, 1));
fs.writeFileSync(`${out}.log`, log.join("\n"));
fs.writeFileSync(`${out}.ai.json`, JSON.stringify(ai ?? [], null, 1));
fs.writeFileSync(`${out}.snaps.txt`, pages.map((p) => JSON.stringify(p)).join("\n"));
console.log(`${status} flags=${flags} ${elapsed}s ${url}\n  report: ${out}.report.txt`);
process.exit(0);
