import {
  hasReviewRules,
  SOURCE_GROUPS,
  SOURCE_NAMES,
  type SubmissionReview as Policy,
  type Yolo,
} from "../../shared/yolo";
import fortune from "../../background/yolo/fortune.json";
import { NumberInput, SelectInput, TagInput, Toggle } from "./controls";

export function SubmissionReview({ y, set }: { y: Yolo; set: (p: Partial<Yolo>) => void }) {
  const r = y.submissionReview;
  const update = (patch: Partial<Policy>) => set({ submissionReview: { ...r, ...patch } });
  const rules = [
    ...r.sources.map((s) => SOURCE_NAMES[s]),
    ...(r.fortune === "off" ? [] : [`US Fortune ${r.fortune}`]),
    ...(r.companies.some((c) => c.trim()) ? ["your company list"] : []),
    ...(r.guessedAnswers ? ["guessed or screening-policy answers"] : []),
  ];
  return (
    <>
      <h2>Review before submission</h2>
      <p class="intro">
        Let YOLO fill applications, then review and submit them yourself. This is independent of the AI check of filled
        answers.
      </p>
      <div class="form">
        <SelectInput
          label="Require my review"
          value={r.mode}
          options={[
            ["off", "Off — submit automatically"],
            ["all", "All applications"],
            ["matching", "Matching applications"],
          ]}
          help="Changes apply to applications started next. Applications already awaiting your review always remain manual."
          onChange={(mode) => update({ mode: mode as Policy["mode"] })}
        />
        {r.mode === "matching" && (
          <div class="review-rules field full">
            <fieldset>
              <legend>Review applications found through</legend>
              <p class="help">
                Choose any combination. A job found through more than one source needs review when any of its sources
                matches.
              </p>
              {SOURCE_GROUPS.map((s) => (
                <label class="review-check" key={s}>
                  <input
                    type="checkbox"
                    checked={r.sources.includes(s)}
                    onChange={(e) =>
                      update({
                        sources: e.currentTarget.checked ? [...r.sources, s] : r.sources.filter((x) => x !== s),
                      })
                    }
                  />{" "}
                  {SOURCE_NAMES[s]}
                </label>
              ))}
            </fieldset>
            <SelectInput
              label="Company ranking"
              value={r.fortune}
              options={[
                ["off", "No ranking rule"],
                ["500", "US Fortune 500"],
                ["1000", "US Fortune 1000 (includes Fortune 500)"],
              ]}
              help={`Uses the ${fortune.year} US list, verified ${fortune.verifiedAt}. Includes subsidiaries and brands with verified aliases; ownership is never guessed. Other subsidiaries can be added below.`}
              onChange={(fortune) => update({ fortune: fortune as Policy["fortune"] })}
            />
            <TagInput
              label="Also review these companies"
              value={r.companies}
              onChange={(companies) => update({ companies })}
              help="Company names, such as Google or Stripe. Matches whole normalized names and verified aliases, rather than partial words."
            />
            <Toggle
              label="Review whenever YOLO guesses an answer"
              checked={r.guessedAnswers}
              onChange={(guessedAnswers) => update({ guessedAnswers })}
              help="Includes best guesses and screening-policy answers. Normal profile-based essay and cover-letter drafts do not trigger this rule. Uses inactive tabs for all applications so a later guess can be handed to you without filling twice; adds no AI calls."
            />
          </div>
        )}
        {r.mode !== "off" && (
          <>
            <p
              class={`review-summary field full${r.mode === "matching" && !hasReviewRules(r) ? " err" : ""}`}
              role="status"
            >
              {r.mode === "all"
                ? "Every YOLO application will wait for your review."
                : hasReviewRules(r)
                  ? `Review when any rule matches: ${rules.join("; ")}. Other applications submit automatically.`
                  : "Select at least one review rule. New applications are paused until you do."}
            </p>
            <NumberInput
              label="Maximum pending reviews"
              value={r.maxPending}
              min={1}
              max={50}
              onChange={(maxPending) => update({ maxPending })}
              help="Filled applications stay in inactive tabs in AutoApply Review. At this limit, new applications pause while discovery continues. Submit or dismiss reviews to resume. Lost tabs still count; use Refill for review when needed."
            />
            <p class="help field full">
              Open Applications → Ready for your review to inspect answers and uploaded files. Submit with the site's
              own button. Keep review tabs open: refreshing, closing, or restarting Chrome may lose answers and uploads.
            </p>
          </>
        )}
      </div>
    </>
  );
}
