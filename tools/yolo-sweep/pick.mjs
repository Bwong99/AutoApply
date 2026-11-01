// Picks a varied set of live, untested SWE-adjacent intern/co-op postings: a few per applicant-tracking system.
// usage: node tools/yolo-sweep/pick.mjs [--per N] [--out file]   prints "name url" lines (batch.mjs input)
// env: PREFER=<regex> location preference (default: the export's YOLO locations)
import fs from "node:fs";
import path from "node:path";
import { STATE, companyOf, kindOfUrl, loadExport, mkdirp, nameFor, readJson } from "./lib.mjs";

const FEEDS = [
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
  // New-grad postings only fill ATSs the intern feed has too few of: their forms are the same.
  "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
];
// Most applications go through these, so they get more picks per round.
const WEIGHT = { workday: 3, greenhouse: 2, ashby: 2, lever: 2, oracle: 2, smartrecruiters: 2, icims: 2, other: 6 };
const SWE = /software|ai\/ml|data|machine learning|engineering/i;
const TITLE =
  /software|developer|engineer|swe|data|machine learning|\bml\b|\bai\b|full.?stack|backend|front.?end|devops|cloud|platform|security|qa|test|firmware|embedded|it\b/i;

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const per = Number(arg("--per", 1));
const outFile = arg("--out");
const exp = loadExport();
const prefer = new RegExp(process.env.PREFER ?? ((exp.yolo?.locations ?? []).join("|") || "$^"), "i");
const tested = readJson(path.join(STATE, "tested.json"), {});

async function feed(u, i) {
  const f = path.join(mkdirp(path.join(STATE, "feeds")), `feed${i}-${new Date().toISOString().slice(0, 10)}.json`);
  if (!fs.existsSync(f)) {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
    fs.writeFileSync(f, await r.text());
  }
  return readJson(f, []);
}

const groups = new Map();
const companies = new Set(Object.keys(tested).map(companyOf));
const [intern, newGrad] = await Promise.all(FEEDS.map(feed));
const fresh = (l, isIntern) =>
  l
    .filter(
      (x) =>
        x.active &&
        x.is_visible !== false &&
        x.url &&
        !tested[x.url] &&
        SWE.test(x.category ?? "") &&
        TITLE.test(x.title),
    )
    .map((x) => ({
      ...x,
      intern: isIntern,
      coop: /co-?op/i.test(x.title),
      pref: prefer.test((x.locations ?? []).join(" ")),
    }));
for (const x of [...fresh(intern, true), ...fresh(newGrad, false)]) {
  const k = kindOfUrl(x.url);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(x);
}
const picked = [];
for (const [k, list] of groups) {
  // Intern before new grad, co-op and preferred locations first, newest first.
  list.sort((a, b) => b.intern - a.intern || b.coop - a.coop || b.pref - a.pref || b.date_posted - a.date_posted);
  let n = per * (WEIGHT[k] ?? 1);
  const seen = new Set();
  // One posting per company per round, companies never tested first: more distinct forms.
  for (const x of [
    ...list.filter((x) => !companies.has(companyOf(x.url))),
    ...list.filter((x) => companies.has(companyOf(x.url))),
  ]) {
    if (n <= 0) break;
    if (seen.has(companyOf(x.url))) continue;
    seen.add(companyOf(x.url));
    picked.push({ k, x });
    n--;
  }
}
const lines = picked.map(
  ({ x }) => `${nameFor(x.url)} ${x.url} ${JSON.stringify({ company: x.company_name, title: x.title })}`,
);
if (outFile) fs.writeFileSync(outFile, lines.join("\n") + "\n");
console.log(lines.join("\n"));
console.error(
  `${picked.length} postings across ${new Set(picked.map((p) => p.k)).size} ATS kinds: ${[...new Set(picked.map((p) => p.k))].join(", ")}`,
);
