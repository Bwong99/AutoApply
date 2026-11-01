You fix one YOLO-mode bug in the AutoApply extension. Read {{SKILL}} first (harness commands, report format, traps), and {{NOTES}} if it exists.

Bug {{ID}} ({{KIND}}, {{CATEGORY}}): {{TITLE}}
Evidence: {{EVIDENCE}}
Postings: {{URLS}}
Reports: {{REPORTS}}
Regression postings (same ATS, passed before): {{REGRESS}}

YOLO must apply with no user input at all except CAPTCHAs, with every field filled with accurate information.

1. Rebuild (`node {{TOOLS}}/build.mjs`) and reproduce with `node {{TOOLS}}/run.mjs <url> {{OUT}}/<name>`. Read the .report.txt first; grep the .html/.snaps.txt/.ai.json only for the flagged fields; probe the page with EARLY/EXP scripts when you need live DOM facts. Browsers run headless only, never in the foreground.
2. Find the root cause and fix it cleanly, once, in the shared code. Grep every caller of what you change. The fix must not alter any other pre-existing behavior: everything that worked before must keep working.
3. Keep the AutoApply Autofill Priorities, in order: (1) every autofill as accurate as possible, (2) autofill completes fast, (3) little to no background resource use, (4) minimal AI token use.
4. Add a unit test in test/unit for the new behavior when it is testable without the live site. Then `npm test`, `npx tsc --noEmit` and `npx eslint <changed files>` must pass.
5. Rebuild and re-run the bug's postings, then the regression postings; they must end DRY-OK (or the same expected stop as before) with the fields right.
6. Commit only this fix: `git add` just its files, a concise Conventional Commits message (`fix(scope): …`). Use the configured git author; no Co-Authored-By trailer and no mention of Claude.
7. If you learned a non-obvious site quirk a future session would need, append one line to {{NOTES}}.

If it is not a bug (an expected stop, closed posting, load flake that passes alone) or it cannot be fixed on our side, do not commit.
Your final line must be exactly one of:
RESULT: fixed <commit sha>
RESULT: not-a-bug <one-line reason>
RESULT: unfixable <one-line reason>
RESULT: gave-up <one-line reason>
