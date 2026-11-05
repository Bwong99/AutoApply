# YOLO sweep

Tests YOLO mode, or manual autofill with YOLO off, on live job postings with the real extension (headless Chromium) and lets Claude Code fix what breaks, unattended.

```
pick postings ─► run each (dry) ─► triage reports ─► one fresh fix session per bug ─► next round
  pick.mjs         batch.mjs         Sonnet             Opus, commits on a branch        until a round is clean
```

Each step works on small files instead of raw pages: `run.mjs` writes a compact report per posting (status, every field as `label = value`, rows flagged blank / not matching your profile), so Claude reads a few KB per site, and every bug gets its own short session.

## Setup (once)

1. Node 22+, `npm install`, `npx playwright install chromium`, and [Claude Code](https://claude.com/claude-code) (`claude` on PATH, signed in).
2. In the extension: fill in your profile, add your résumé, add Gemini API keys or set up Claude (the harness reuses the installed Claude bridge; it uses Gemini when your keys are there unless `AI_PROVIDER=claude`), and set YOLO's email.
3. Options → Data → Export, and save the file as `autoapply-export.json` at the repo root (gitignored; or point `AA_EXPORT` at it).

## Run the whole flow

```
node tools/yolo-sweep/loop.mjs                 # YOLO mode
node tools/yolo-sweep/loop.mjs --mode manual   # manual autofill (YOLO off)
```

Manual mode stands in for the user: it opens the form (Apply, "I'm interested"), presses Fill like the popup, waits for the overlay's Done, and clicks Next through multi-page forms. It skips ATSs that need a sign-in first (Workday, Oracle, SuccessFactors, iCIMS, Taleo, Avature): YOLO mode covers those.

Options: `--rounds 5`, `--per 1` (postings per ATS per round; Workday, Greenhouse etc. get a few times that), `--max-fixes 15` per round, `--submit` (after the dry rounds, really submit the postings that passed: **this applies to those jobs for you**), `--triage-model sonnet --triage-effort medium --fix-model opus --fix-effort high`, `--perm acceptEdits` (permission mode of the Claude sessions), `--branch <name>`, `--no-merge`.

- Fixes are made in a git worktree (`.yolo-sweep/wt`) on a branch `yolo-sweep/<date>`, so uncommitted work in your checkout is neither built nor committed. At the end the branch is fast-forwarded into the branch you had checked out when that is possible; otherwise it prints the commands.
- Commits use your git author, with no Claude trailer.
- Stop with Ctrl+C at any time. Rerunning continues: tested postings are skipped, open bugs get fixed first.
- Without `--submit` nothing is submitted: the dry build stops before the final Submit button, and manual mode never clicks it.
- Remove the worktree with `node tools/yolo-sweep/loop.mjs --remove-worktree`, not `rm -rf`: its `node_modules` is a junction to yours.

## Pieces (also usable by hand)

| Command                                              | What it does                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `node tools/yolo-sweep/build.mjs [--real]`           | Build the current checkout into `.yolo-sweep/ext-dry` (or `ext-real`).                          |
| `node tools/yolo-sweep/run.mjs <url> [outPrefix]`    | One application; writes `<out>.report.txt`, `.json`, `.log`, `.html`, `.snaps.txt`, `.ai.json`. |
| `node tools/yolo-sweep/fill.mjs <url> [outPrefix]`   | One manual autofill (YOLO off); same files. `REAL=1` clicks Submit.                             |
| `node tools/yolo-sweep/pick.mjs [--per N] [--out f]` | Untested SWE intern/co-op postings from the Simplify feeds, spread over ~25 ATS kinds.          |
| `node tools/yolo-sweep/batch.mjs <list> <outDir>`    | Run a list, 3 browsers at a time (`P`), and record results in `.yolo-sweep/tested.json`.        |

Agent-facing details (report format, expected stops, traps): `.claude/skills/yolo-sweep/SKILL.md`, also available as `/yolo-sweep` in Claude Code.

## State (`.yolo-sweep/`, gitignored)

`rounds/<n>/` reports and fix-session runs · `bugs.json` every bug and its outcome · `tested.json` / `tested-manual.json` every posting run per mode · `notes.md` site quirks sessions found · `profiles/` per-tenant browser profiles (accounts) · `feeds/` daily feed cache · `wt/` the worktree.
