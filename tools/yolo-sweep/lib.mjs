// Shared paths and helpers for the YOLO sweep tools (see README.md).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const TOOLS = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
/** The main checkout, also when run from a git worktree: state, builds and the export live there. */
export const ROOT = path.dirname(git("-C", TOOLS, "rev-parse", "--path-format=absolute", "--git-common-dir"));
export const STATE = path.join(ROOT, ".yolo-sweep");
export const EXPORT = process.env.AA_EXPORT ?? path.join(ROOT, "autoapply-export.json");
/** One fixed build path per mode, so the extension ID (and the per-ID password vault) stays the same. */
// AA_EXT: another build to run instead (e.g. a copy of an earlier one, for before/after sweeps).
export const extDir = (real) => process.env.AA_EXT ?? path.join(STATE, real ? "ext-real" : "ext-dry");
export const mkdirp = (d) => (fs.mkdirSync(d, { recursive: true }), d);
export const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
export const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));

export function loadExport() {
  if (!fs.existsSync(EXPORT))
    throw new Error(
      `No ${EXPORT}. Fill in your profile and résumé in the extension, then Options → Data → Export, and save the file there (or set AA_EXPORT).`,
    );
  return JSON.parse(fs.readFileSync(EXPORT, "utf8"));
}

/** Applicant-tracking system of a job URL. Account-based ones need a persistent browser profile per tenant. */
const KINDS = [
  ["workday", /myworkdayjobs\.com|myworkdaysite\.com|workday\.com/],
  ["greenhouse", /greenhouse\.io|[?&]gh_jid=/],
  ["lever", /lever\.co/],
  ["ashby", /ashbyhq\.com/],
  ["smartrecruiters", /smartrecruiters\.com/],
  ["icims", /icims\.com|[?&]icims=1/],
  ["workable", /workable\.com/],
  ["successfactors", /successfactors|sapsf|jobs\.sap\.com|[?&]ats=successfactors/],
  ["oracle", /oraclecloud\.com/],
  ["taleo", /taleo\.net/],
  ["jobvite", /jobvite\.com/],
  ["bamboohr", /bamboohr\.com/],
  ["breezy", /breezy\.hr/],
  ["avature", /avature\.net/],
  ["eightfold", /eightfold\.ai/],
  ["rippling", /rippling\.com/],
  ["jazzhr", /applytojob\.com/],
  ["teamtailor", /teamtailor\.com/],
  ["recruitee", /recruitee\.com/],
  ["paylocity", /paylocity\.com/],
  ["ukg", /ultipro\.com|ukg\.net/],
  ["adp", /adp\.com/],
  ["dayforce", /dayforcehcm\.com/],
  ["jibe", /jibeapply\.com/],
  ["gem", /jobs\.gem\.com/],
];
/** Sweep modes: YOLO (run.mjs) or manual autofill with YOLO off (fill.mjs). Each keeps its own tested list. */
export const MODE = process.env.MODE === "manual" ? "manual" : "yolo";
export const testedFile = (mode = MODE) => path.join(STATE, mode === "manual" ? "tested-manual.json" : "tested.json");
export const ACCOUNT_KINDS = new Set(["workday", "oracle", "successfactors", "icims", "taleo", "avature"]);
export const kindOfUrl = (url) => KINDS.find(([, re]) => re.test(url))?.[0] ?? "other";
/** Tenant: Workday/Oracle/etc. accounts are per subdomain. */
export const tenantOf = (url) => new URL(url).hostname.split(".")[0].replace(/[^a-z0-9-]/gi, "");
/** Company: host plus first path segment (Greenhouse/Lever/Ashby name the company in the path). */
export const companyOf = (url) => {
  const u = new URL(url);
  return `${u.hostname.replace(/^(www|careers|jobs|apply|job-boards|boards)\./, "")}/${u.pathname.split("/")[1] ?? ""}`.toLowerCase();
};
const NOISE =
  /^(com|co|io|net|ai|hr|p|jobs?|careers?|careersection|apply|recruiting|campus|about|en|us|eu|ca|ta|wd\d+|fa|ocs|saasfaprod\d*|myworkdayjobs|oraclecloud|greenhouse|lever|ashbyhq|smartrecruiters|workable|bamboohr|breezy|avature|eightfold|applytojob|rippling|ats|jibeapply|taleo|jobvite|icims|paylocity)$/;
/** File-friendly run name, e.g. workday-cibc, greenhouse-later. */
export const nameFor = (url) => {
  const words = companyOf(url)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.test(w));
  return `${kindOfUrl(url)}-${words.join("-") || tenantOf(url)}`.slice(0, 40).replace(/-+$/, "");
};

/** Profile facts a field label can be checked against without AI (label regex → expected value). */
export function profileChecks(p) {
  const pe = p.personal ?? {};
  const ed = (p.education ?? [])[0] ?? {};
  const a = pe.address ?? {};
  const l = pe.links ?? {};
  const digits = (s) => String(s ?? "").replace(/\D/g, "");
  return [
    [/^(legal )?first name|given name/i, pe.firstName],
    [/^(legal )?last name|surname|family name/i, pe.lastName],
    [/e-?mail/i, pe.email, (v, e) => v.toLowerCase().replace(/\+[^@]*@/, "@") === e.toLowerCase()],
    [
      /^(?!.*(type|code|ext|opt-in)).*(phone|mobile)/i,
      pe.phone?.number,
      (v, e) => digits(v).endsWith(digits(e).slice(-10)),
    ],
    // Location typeaheads hold "City, Region, Country".
    [/^city\b|city of residence/i, a.city, (v, e) => v.toLowerCase().startsWith(e.toLowerCase())],
    [/postal|zip/i, a.postalCode, (v, e) => v.replace(/\s/g, "").toLowerCase() === e.replace(/\s/g, "").toLowerCase()],
    [
      /linkedin/i,
      l.linkedin,
      (v, e) => v.replace(/\/$/, "").endsWith(e.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")),
    ],
    [
      /github/i,
      l.github,
      (v, e) => v.replace(/\/$/, "").endsWith(e.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")),
    ],
    [/^(school|university|college|institution)/i, ed.school],
    [/\bgpa\b|grade point/i, ed.gpa, (v, e) => parseFloat(v) === parseFloat(e)],
  ].filter(([, e]) => e);
}
