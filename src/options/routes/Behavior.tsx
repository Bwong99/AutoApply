import { NumberInput, SelectInput, TagInput, Toggle } from "../components/controls";
import { save, useStored } from "../store";
import type { Settings } from "../../shared/types";
import { MAX_BATCH_APPLICATIONS } from "../../shared/yolo";

type Bool = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
type Num = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];

const TOGGLES: [Bool, string, string][] = [
  ["overwritePrefilled", "Overwrite pre-filled fields", "Off: fields that already have a value are left alone."],
  [
    "autoAcceptAcknowledgements",
    "Auto-accept required consents",
    "Consents needed to apply (privacy notice, terms, attestations). Off: they are flagged for you instead of accepted.",
  ],
  [
    "draftEssays",
    "Draft essays with AI",
    "Open-ended questions are drafted and badged “AI draft – review”. Off: they are flagged for you.",
  ],
  [
    "coverLetterPdfs",
    "Write cover letters",
    "If no cover letter is uploaded in Documents, generate a tailored cover letter for the job from your cover letter template. Off: the field is flagged for you. YOLO has its own setting.",
  ],
  [
    "reviewFills",
    "Review manual fills with AI",
    "After a manual fill, AI checks answers against your profile, corrects mistakes and fills missed fields. Adds time and AI usage; choose the review model under AI. Off: the usual autofill without a second review.",
  ],
  ["showBadges", "Show field badges", "Colored outlines and tags on each field. The overlay list works either way."],
  [
    "learnPrompts",
    "Offer to save my answers",
    "After you answer a field the extension couldn't, offer to remember it.",
  ],
  [
    "debugLogging",
    "Debug logging",
    "Logs prompts and responses to the service-worker console (never API keys), shows stage timings, and keeps each YOLO application's answers (Applications → Debug logs).",
  ],
];

const NUMBERS: [Num, string, string, number, number][] = [
  // First: it sits right under the Debug logging toggle it belongs to.
  [
    "debugLogLimit",
    "Debug logs kept",
    "How many recent YOLO applications' debug logs are kept.",
    1,
    MAX_BATCH_APPLICATIONS,
  ],
  [
    "maxFieldsPerRequest",
    "Fields per AI request",
    "Larger pages are split into parallel requests of this size.",
    1,
    200,
  ],
  [
    "requestTimeoutMs",
    "Request timeout (ms)",
    "Per AI request; essays get twice this, and Claude twice again (Claude Code starts up each time).",
    1000,
    120000,
  ],
  [
    "maxConcurrentRequests",
    "Parallel AI requests",
    "How many AI calls may run at once (with Claude, each runs Claude Code).",
    1,
    16,
  ],
];

export function Behavior() {
  const s = useStored("settings");
  if (!s) return <p>Loading…</p>;
  const set = (patch: Partial<Settings>) => void save({ settings: { ...s, ...patch } });
  return (
    <section>
      <h1>Behavior</h1>
      <div class="form">
        {TOGGLES.map(([k, label, help]) => (
          <>
            <Toggle label={label} help={help} checked={s[k]} onChange={(v) => set({ [k]: v })} />
            {k === "autoAcceptAcknowledgements" && (
              <SelectInput
                label="Optional consents"
                help="Consents you can skip (contact about other jobs, talent community, marketing)."
                value={s.optionalConsents}
                options={[
                  ["decline", "Auto-decline"],
                  ["accept", "Auto-accept"],
                  ["ask", "Flag for me"],
                ]}
                onChange={(v) => set({ optionalConsents: v as Settings["optionalConsents"] })}
              />
            )}
            {k === "coverLetterPdfs" && (
              <SelectInput
                label="Upload résumés"
                help="Variant select: the résumé PDF in Documents that best fits the job (fast, no AI). AI tailor: your LaTeX résumé, tailored to the job by the AI (slower, uses tokens). Flag for me: résumé uploads are left for you. YOLO has its own setting."
                value={s.resumeUpload}
                options={[
                  ["variants", "Variant select"],
                  ["tailor", "AI tailor"],
                  ["flag", "Flag for me"],
                ]}
                onChange={(v) => set({ resumeUpload: v as Settings["resumeUpload"] })}
              />
            )}
          </>
        ))}
        {NUMBERS.map(([k, label, help, min, max]) => (
          <NumberInput label={label} help={help} value={s[k]} min={min} max={max} onChange={(v) => set({ [k]: v })} />
        ))}
        <TagInput
          label="Excluded sites"
          help="Host names where the extension does nothing at all, e.g. mail.google.com."
          value={s.excludedHosts}
          onChange={(v) =>
            set({
              excludedHosts: v.map((h) =>
                h
                  .toLowerCase()
                  .replace(/^https?:\/\//, "")
                  .replace(/\/.*$/, ""),
              ),
            })
          }
        />
      </div>
    </section>
  );
}
