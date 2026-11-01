// The whole YOLO bug-fix flow, unattended: sweep varied live postings → triage the reports (cheap model)
// → one fresh fix session per bug (strong model) → next round, until a round finds no bugs.
// usage: node tools/yolo-sweep/loop.mjs [options]   (see README.md)
//   --mode yolo|manual (default yolo; manual = autofill with YOLO off, via fill.mjs)
//   --rounds N (default 5)  --per N (postings per ATS weight, default 1)  --max-fixes N per round (default 15)
//   --submit       after the dry rounds, really submit the postings that passed dry (applies to jobs for you)
//   --triage-model sonnet --triage-effort medium --fix-model opus --fix-effort high
//   --perm <permission mode for the Claude sessions> (default acceptEdits)   --no-merge   --branch <name>
//   --remove-worktree   delete .yolo-sweep/wt safely (keeps the branch); never rm -rf it: node_modules in it is a junction
// State lives in .yolo-sweep/ (gitignored): rounds/, bugs.json, tested.json, notes.md, wt/ (the worktree fixes go in).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATE, TOOLS, kindOfUrl, loadExport, mkdirp, readJson, testedFile, writeJson } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const flag = (k) => argv.includes(k);
const ROUNDS = Number(opt("--rounds", 5));
const PER = opt("--per", "1");
const MAX_FIXES = Number(opt("--max-fixes", 15));
const PERM = opt("--perm", "acceptEdits");
const MANUAL = opt("--mode", "yolo") === "manual";
const ENV = { MODE: MANUAL ? "manual" : "yolo" };
/** What each mode's prompts say: its runner, its passing status, and what counts as a failure. */
const M = MANUAL
  ? {
      MODE_NAME: "manual-autofill (YOLO off)",
      RUNNER: "fill.mjs",
      OK: "FILLED",
      GOAL: "Manual autofill (YOLO off): the user opens the application form and presses Fill, and every field must be shown and filled with accurate information. The harness clicks Apply and Next itself.",
      FAILURES:
        "fill failures: RESULT TIMEOUT or ERROR, `BADGES not filled` rows, and NO-FORM when the page plainly has an application form (not when it needs a sign-in or the posting is closed).",
    }
  : {
      MODE_NAME: "YOLO-mode",
      RUNNER: "run.mjs",
      OK: "DRY-OK",
      GOAL: "YOLO must apply with no user input at all except CAPTCHAs, with every field filled with accurate information.",
      FAILURES:
        "open/navigate/submit failures: RESULT other than DRY-OK/SUBMITTED, unless it is an expected stop listed in the skill.",
    };
const SKILL = path.join(ROOT, ".claude", "skills", "yolo-sweep", "SKILL.md");
const NOTES = path.join(STATE, "notes.md");
const PROFILE = path.join(STATE, "profile.txt");
const BUGS = path.join(STATE, "bugs.json");
const WT = path.join(STATE, "wt");
const say = (s) => console.log(`[${new Date().toLocaleTimeString()}] ${s}`);
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
const node = (args, env = {}, cwd = WT) =>
  execFileSync(process.execPath, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
const fill = (t, vars) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

const LINKED = ["node_modules", "test/fixtures/vendor"];
if (flag("--remove-worktree")) {
  // Unlink the junctions first (non-recursive rm removes only the link): a recursive delete would empty the real ones.
  for (const d of LINKED) fs.rmSync(path.join(WT, d), { force: true });
  git(ROOT, "worktree", "remove", "--force", WT);
  say(`removed ${WT} (its branch is kept)`);
  process.exit(0);
}
mkdirp(STATE);
const exp = loadExport();
// The profile without keys or documents, for triage to judge accuracy against.
fs.writeFileSync(PROFILE, JSON.stringify(exp.profile, null, 1));

// Fixes go in their own worktree and branch, so other work in the main tree is neither built nor committed.
const base = git(ROOT, "rev-parse", "--abbrev-ref", "HEAD");
const branch = opt("--branch", `yolo-sweep/${new Date().toISOString().slice(0, 10)}`);
if (!fs.existsSync(path.join(WT, ".git"))) {
  const exists = git(ROOT, "branch", "--list", branch);
  git(ROOT, "worktree", "add", ...(exists ? [WT, branch] : ["-b", branch, WT, "HEAD"]));
}
try {
  // A reused worktree whose fixes were merged catches up with the base branch; unmerged fixes stay as they are.
  git(WT, "merge", "--ff-only", base);
} catch {
  /* diverged: keep building on its own fixes */
}
const worktreeBranch = git(WT, "rev-parse", "--abbrev-ref", "HEAD");
for (const d of LINKED) {
  const src = path.join(ROOT, d);
  if (fs.existsSync(src) && !fs.existsSync(path.join(WT, d))) fs.symlinkSync(src, path.join(WT, d), "junction");
}
say(`worktree ${WT} on ${worktreeBranch}`);

const ALLOWED = [
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  ...[
    "node",
    "npm",
    "npx",
    "git add",
    "git commit",
    "git diff",
    "git status",
    "git log",
    "git show",
    "git stash list",
    "grep",
    "rg",
    "cat",
    "head",
    "tail",
    "sed -n",
    "ls",
    "find",
    "wc",
    "od",
    "mkdir",
    "env",
  ].map((c) => `Bash(${c}:*)`),
];
/** One fresh, non-interactive Claude session; returns its final text. */
function claude(prompt, model, effort, cwd, logFile) {
  const args = [
    "-p",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    PERM,
    "--output-format",
    "json",
    "--strict-mcp-config",
    "--no-chrome",
    "--add-dir",
    STATE,
    "--add-dir",
    TOOLS,
    "--add-dir",
    path.dirname(SKILL),
    "--allowedTools",
    ALLOWED.join(","),
    "--disallowedTools",
    "Bash(git push:*),Bash(git reset:*),Bash(git checkout:*),Bash(git rebase:*)",
    "--settings",
    JSON.stringify({ includeCoAuthoredBy: false, attribution: { commit: "", pr: "" } }),
  ];
  return new Promise((res) => {
    const c = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => {
      fs.writeFileSync(logFile, out);
      try {
        const j = JSON.parse(out);
        const denied = j.permission_denials?.length
          ? `, ${j.permission_denials.length} tool calls denied (see ${logFile})`
          : "";
        say(`  session: ${j.num_turns ?? "?"} turns, $${(j.total_cost_usd ?? 0).toFixed(2)} API-equivalent${denied}`);
        res(String(j.result ?? ""));
      } catch {
        res(out);
      }
    });
    c.stdin.end(prompt);
  });
}

const bugs = readJson(BUGS, []);
const save = () => writeJson(BUGS, bugs);
const reportsOf = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".report.txt"))
    .map((f) => path.join(dir, f));

async function triage(dir) {
  const known = bugs.map((b) => `- ${b.id} [${b.status}] ${b.kind}: ${b.title}`).join("\n") || "(none)";
  const t = fill(fs.readFileSync(path.join(TOOLS, "prompts", "triage.md"), "utf8"), {
    ...M,
    SKILL,
    NOTES,
    PROFILE,
    REPORTS: reportsOf(dir).join("\n"),
    KNOWN: known,
  });
  const text = await claude(
    t,
    opt("--triage-model", "sonnet"),
    opt("--triage-effort", "medium"),
    WT,
    path.join(dir, "triage-session.json"),
  );
  const found = [];
  for (const m of text.matchAll(/^BUG (\{.*\})\s*$/gm)) {
    try {
      found.push(JSON.parse(m[1]));
    } catch {
      say(`  unparsable BUG line: ${m[1].slice(0, 120)}`);
    }
  }
  return found;
}

async function fix(b, round, real) {
  const tested = readJson(testedFile(ENV.MODE), {});
  const regress = Object.entries(tested)
    .filter(([u, t]) => t.status === M.OK && kindOfUrl(u) === b.kind && !b.urls.includes(u))
    .slice(-2)
    .map(([u]) => u);
  const out = mkdirp(path.join(STATE, "rounds", String(round), "fix-" + b.id));
  const t =
    fill(fs.readFileSync(path.join(TOOLS, "prompts", "fix.md"), "utf8"), {
      ...M,
      SKILL,
      NOTES,
      TOOLS,
      OUT: out,
      ID: b.id,
      KIND: b.kind,
      CATEGORY: b.category,
      TITLE: b.title,
      EVIDENCE: b.evidence,
      URLS: b.urls.join(" "),
      REPORTS: (b.reports ?? []).join(" "),
      REGRESS: regress.join(" ") || "(none yet)",
    }) +
    (real
      ? `\nThis bug came from a real submission: you may re-run with REAL=1${MANUAL ? "" : " (build with --real)"} to verify the submit.`
      : "");
  const text = await claude(
    t,
    opt("--fix-model", "opus"),
    opt("--fix-effort", "high"),
    WT,
    path.join(out, "session.json"),
  );
  const m = /RESULT: (fixed|not-a-bug|unfixable|gave-up)\s*(.*)$/m.exec(text);
  b.status = m?.[1] ?? "gave-up";
  b.result = (m?.[2] ?? text.slice(-300)).trim();
  // Uncommitted leftovers (a session that gave up) would leak into the next fix: park them, nothing is lost.
  if (git(WT, "status", "--porcelain")) {
    git(WT, "stash", "push", "-u", "-m", `yolo-sweep ${b.id} leftovers`);
    b.result += " (leftover changes stashed in the worktree)";
  }
  save();
  say(`  ${b.id} → ${b.status} ${b.result}`);
}

async function round(r, real, list) {
  const dir = mkdirp(path.join(STATE, "rounds", String(r)));
  const urls = path.join(dir, "urls.txt");
  if (list) fs.writeFileSync(urls, list.join("\n") + "\n");
  else node([path.join(TOOLS, "pick.mjs"), "--per", PER, "--out", urls], ENV);
  if (!fs.readFileSync(urls, "utf8").trim()) return (say("no untested postings left"), 0);
  node([path.join(TOOLS, "build.mjs"), ...(real && !MANUAL ? ["--real"] : [])]);
  say(
    `round ${r}${real ? " (REAL submits)" : ""}: running ${fs.readFileSync(urls, "utf8").trim().split("\n").length} postings`,
  );
  node([path.join(TOOLS, "batch.mjs"), urls, dir], { ...ENV, ...(real ? { REAL: "1" } : {}) });
  const found = await triage(dir);
  say(`round ${r}: ${found.length} new bug(s)`);
  for (const [i, f] of found.entries())
    bugs.push({ id: `r${r}b${i + 1}`, round: r, mode: ENV.MODE, status: "open", ...f });
  save();
  // Widest bugs first; leftovers stay open for the next run.
  const open = bugs.filter((b) => b.status === "open").sort((a, b) => b.urls.length - a.urls.length);
  for (const b of open.slice(0, MAX_FIXES)) {
    say(`fixing ${b.id} ${b.kind}: ${b.title}`);
    await fix(b, r, real);
  }
  return found.length;
}

const state = readJson(path.join(STATE, "state.json"), { round: 0 });
let clean = false;
for (let i = 0; i < ROUNDS && !clean; i++) {
  state.round++;
  writeJson(path.join(STATE, "state.json"), state);
  clean = (await round(state.round, false)) === 0 && !bugs.some((b) => b.status === "open");
}
if (flag("--submit")) {
  const tested = readJson(testedFile(ENV.MODE), {});
  const ok = Object.entries(tested)
    .filter(([, t]) => t.status === M.OK)
    .map(([u]) => `${path.basename(tested[u].run)} ${u}`);
  state.round++;
  writeJson(path.join(STATE, "state.json"), state);
  if (ok.length) await round(state.round, true, ok);
}

const commits = git(WT, "log", "--oneline", `${base}..HEAD`);
say(
  `done. bugs: ${["fixed", "open", "unfixable", "not-a-bug", "gave-up"].map((s) => `${s} ${bugs.filter((b) => b.status === s).length}`).join(", ")}`,
);
say(`commits on ${worktreeBranch}:\n${commits || "(none)"}`);
if (commits && !flag("--no-merge")) {
  try {
    git(ROOT, "merge", "--ff-only", worktreeBranch);
    say(`fast-forwarded ${base} to ${worktreeBranch}`);
  } catch {
    say(
      `could not fast-forward ${base} (it moved, or uncommitted changes touch the same files). Run: git rebase ${base} ${worktreeBranch} (in ${WT}), then git merge --ff-only ${worktreeBranch} here`,
    );
  }
}
