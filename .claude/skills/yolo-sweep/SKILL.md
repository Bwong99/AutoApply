---
name: yolo-sweep
description: Test YOLO mode or manual autofill (YOLO off) on live job postings headlessly and fix what breaks. Use for "test YOLO", "YOLO sweep", "test manual autofill", reproducing a YOLO bug on a live site, or reading .yolo-sweep reports.
---

# YOLO sweep

Tools in `tools/yolo-sweep/` (human setup: its README.md). All browsers are headless; never open one in the foreground.
State is in `.yolo-sweep/` at the main checkout (gitignored). Your profile comes from `autoapply-export.json` (gitignored).

## Commands

- `node tools/yolo-sweep/build.mjs [--real]`: build the checkout you are in. Dry (default) stops before the final Submit and reports every answer. Rebuild after every source change.
- `node tools/yolo-sweep/run.mjs <url> [outPrefix]`: one YOLO application. Prints `STATUS flags=N` and the report path.
  Env: `REAL=1` (real build, submits), `MAXMIN` (default 10), `TABHOST=<host>` (background tab instead of the hidden frame), `YOLO='{json}'` (settings), `EARLY=<js file>` (run in the page every 2 s, guard with a window flag), `EXP=<js file>` (run at the end), `EXPHOST=<substring>` (frame to target), `VERBOSE=1`.
  In loop.mjs sessions, use the Bash tool and set env vars as `env KEY=value node …` (that's what the permissions allow).
- `node tools/yolo-sweep/fill.mjs <url> [outPrefix]`: manual autofill (YOLO off) on one posting. It stands in for the user: clicks Apply / "I'm interested" until a form shows, presses Fill the way the popup does, waits for the overlay's `Done ·`, then clicks Next and fills each page. Uses the dry build (manual fill doesn't use the YOLO driver).
  Env: `REAL=1` (click the final Submit: applies), `MAXMIN` (fill timeout per page, default 3), `PAGES` (default 6), `EXP=<js file>` (run in every frame at the end), `VERBOSE=1`.
- `MODE=manual` makes pick.mjs/batch.mjs use fill.mjs and `.yolo-sweep/tested-manual.json`, and skips sign-in ATSs (Workday, Oracle, SuccessFactors, iCIMS, Taleo, Avature) whose forms the manual harness can't reach. `loop.mjs --mode manual` runs the whole flow for manual autofill.
- `AI_PROVIDER=claude|gemini` picks the provider for any command; Claude works headless through the installed bridge (harness builds request `nativeMessaging`). `AA_EXT=<dir>` runs another build (before/after comparisons).
- `node tools/yolo-sweep/pick.mjs --per 1 --out list.txt`: varied untested postings (a few per ATS, intern/co-op first).
- `node tools/yolo-sweep/batch.mjs list.txt <outDir>`: run a list, 3 at a time (`P`); records results in `.yolo-sweep/tested.json`.
- `node tools/yolo-sweep/loop.mjs`: the whole unattended flow (sweep → triage → one fix session per bug → repeat).

## Reading results (cheapest first)

1. `<out>.report.txt`: RESULT, STEPS, AI ANSWERS, then each page's fields. Row marks:
   `! BLANK*` required and empty · `? empty` optional and empty · `! SUS` disagrees with the profile · `! ERROR` page error text · `profile-ok N` rows matching the profile, collapsed · plain rows: `kind | label = value`.
   `REVIEW` lists each AI review call's non-ok verdicts and missed questions, and each navigator call (why → step); `NOTES` the application's notes (what the review corrected or found).
   RESULT: `DRY-OK` (dry run reached the final Submit), `SUBMITTED`, `NEEDS`/`FAILED`/`BLOCKED`/`SKIPPED` (with reason), `TIMEOUT`, `ERROR`/`CRASH`.
   Manual reports (fill.mjs) instead have RESULT `FILLED` / `NO-FORM` (no form reached) / `TIMEOUT` (overlay never said Done) / `ERROR` / `SUBMITTED` / `SUBMIT-UNCONFIRMED`, plus `OVERLAY` (its Done line), `NAV` (what the harness clicked) and `BADGES not filled` (the extension's own Needs you / Check / Failed badges, `~ color Field: Label. tooltip`).
2. Grep, never read whole: `<out>.html` (final DOM), `<out>.snaps.txt` (one JSON dump per page/step), `<out>.log` (SW log, `YOLO FACTS` per step), `<out>.ai.json` (AI requests/responses).
3. Live DOM facts: write a small `EARLY`/`EXP` script that returns a short summary (never raw HTML).

## Expected stops (not bugs)

- Email needed: Workday "verify your account", Oracle emailed PIN, Greenhouse security code, verification links. Gmail can't connect headless.
- CAPTCHAs (BambooHR reCAPTCHA, JazzHR, Lever/Workable hCaptcha, Ashby "flagged as possible spam"). CAPTCHAs are the only user input allowed.
- Workday Voluntary Self-Identification of Disability (CC-305) final save returns HTTP 400 "Error Code: VPS" for any body.
- SuccessFactors "Account Already Exists" on reruns (it dedups by phone): use another posting.
- Closed postings: Ashby "Application submission is unavailable" or "Page not found", 404s, "no longer accepting".
- After about 30 headless runs in a day Workable, Lever and Glassdoor CAPTCHA every load: stop testing them that day.

## Traps

- Pages are snapshotted every 2 s and each step keeps its last snapshot, so a `! BLANK*` on a page that isn't the last one can be a snapshot taken mid-fill. Reproduce before fixing.
- Lever/Ashby location typeaheads time out under parallel load: re-run alone before calling it a bug.
- The hidden frame never renders: rAF, idle callbacks, Resize/IntersectionObservers and CSS transitions don't run (shimmed in `src/content/pageTimers.ts`), and `el.focus()` fires no focus events.
- Many company pages hide the form until "Apply" is clicked, or embed Greenhouse (`job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>`).
- Profiles for account ATSs (Workday, Oracle, SuccessFactors, iCIMS, Taleo, Avature) persist per tenant in `.yolo-sweep/profiles/` with a plus-addressed email, so reruns sign in. Delete a profile to start that tenant fresh.
- Source edits with backslashes in regexes: use the Edit tool, not shell heredocs (`\b` becomes a backspace).

## Fix rules

- Root-cause fix in shared code; grep every caller. No change to any other pre-existing behavior.
- Prefer fixing the AI review / navigator's inputs, prompts or guards (content/review, background/services/reviewForm.ts, navigate.ts) over new site heuristics when the review already sees the problem.
- AutoApply Autofill Priorities, in order: accuracy, speed, little background resource use, minimal AI tokens. Decide profile-derivable answers in code, not by prompt tweaks.
- Unit test in `test/unit` when testable offline; `npm test`, `npx tsc --noEmit`, `npx eslint <files>` pass; re-run the posting and a same-ATS posting that passed.
- One commit per fix, only its files, Conventional Commits, the configured git author, no Co-Authored-By trailer.
- Put new site quirks a future session needs in `.yolo-sweep/notes.md` (one line each).
