// Shared TypeScript types. Type-only re-exports keep zod out of the content bundle.
import type { FIELD_KINDS, LearnedAnswer, Profile } from "./profileSchema";
import type { Settings } from "./settings";

export type { Profile, LearnedAnswer, Settings };

export type YesNo = "yes" | "no" | "";
export type YesNoDecline = "yes" | "no" | "decline" | "";
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldDescriptor {
  id: string;
  kind: FieldKind;
  label: string;
  hint?: string;
  section?: string;
  required: boolean;
  placeholder?: string;
  inputType?: string;
  autocomplete?: string;
  nameAttr?: string;
  maxLength?: number;
  options?: string[];
  optionsKnown: boolean;
  multiple?: boolean;
  currentValue?: string;
  accept?: string;
}

export type DecisionAction = "fill" | "essay" | "consent" | "skip" | "flag";
export type Confidence = "high" | "medium" | "low";

export interface Decision {
  fieldId: string;
  action: DecisionAction;
  text?: string;
  optionIndexes?: number[];
  intendedAnswer?: string;
  searchQuery?: string;
  checked?: boolean;
  documentId?: string;
  confidence: Confidence;
  sources?: string[];
  note?: string;
  /** Best guess kept for the tooltip when a decision is downgraded to flag. */
  suggestion?: string;
}

export interface DocumentMeta {
  id: string;
  label: string;
  kind: "resume" | "cover_letter" | "transcript" | "other";
  fileName: string;
  mimeType: string;
  size: number;
  isPrimaryResume: boolean;
  uploadedAt: number;
}

export type UploadedDoc = Pick<DocumentMeta, "id" | "kind" | "fileName"> & {
  /** Tailored or written by the AI for this job: the overlay offers the job details it was given. */
  ai?: boolean;
};

/** The job as the AI's writing services were given it (background/services/jobBrief.ts). */
export interface JobBrief {
  company?: string;
  title?: string;
  url?: string;
  location?: string;
  description?: string;
}

export interface ApiKeyEntry {
  id: string;
  label: string;
  key: string;
  addedAt: number;
}

export interface KeyState {
  invalid?: { reason: string; at: number };
  cooldownUntil?: number;
  perModel?: Record<string, { exhaustedUntil?: number; unavailableUntil?: number }>;
  lastUsedAt?: number;
  lastError?: { status: number; message: string; at: number };
  successCount: number;
  errorCount: number;
}

export interface CatalogEntry {
  firstSeenAt: number;
  apiIndex: number;
  displayName: string;
  description: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  thinking?: boolean;
  lastSeenAt: number;
}

/** A model in Claude Code's list: `value` is what --model takes (an alias like "opus", or a full id). */
export interface ClaudeModel {
  value: string;
  displayName: string;
  description: string;
}

export type ThinkingCap =
  | { kind: "level"; value: "minimal" | "low" | "high" }
  /** 0 turns thinking off; -1 lets the model decide how much (2.5 models). */
  | { kind: "budget"; value: 0 | -1 }
  | { kind: "none" };

export interface ModelCaps {
  thinking: ThinkingCap;
  schema: "responseSchema" | "promptOnly";
  verifiedAt: number;
  essayThinking?: ThinkingCap;
  /** The AI review's deeper thinking (reviewThinking), or the model's own tier when it refused that. */
  reviewThinking?: ThinkingCap;
}

/** A pay range read from a job posting; `currency` is "" for a bare "$". */
export interface Pay {
  min: number;
  max: number;
  period: "hour" | "year";
  currency: string;
}

export interface JobContext {
  url: string;
  title: string;
  company: string;
  jobTitle: string;
  text: string;
  /** Page text above the form when there is no description: apply pages still name the job's location there. */
  header?: string;
  /** Where the job is, from its JSON-LD or location label; descriptions often leave it out (Okta, Dublin). */
  location?: string;
  /** Sent by a child frame (an embedded application), which knows the description but not the page's job. */
  embedded?: boolean;
  /** Read from the tab that opened this one (a job board's posting), for an application without a description. */
  borrowed?: boolean;
  capturedAt: number;
}

export interface LearnedAnswerInput {
  question: string;
  kind: FieldKind;
  options?: string[];
  answer: string;
  host: string;
}

export interface StatusCounts {
  total: number;
  filled: number;
  aiMatched: number;
  aiDrafted: number;
  needsYou: number;
  failed: number;
  prefilled: number;
  skipped: number;
}

export interface NeedsYouItem {
  fieldId: string;
  label: string;
  note: string;
  frameId?: number;
}

export interface FrameStatus {
  frameId: number;
  counts: StatusCounts;
  needsYou: NeedsYouItem[];
  running: boolean;
  /** The AI review is reading this frame's page. */
  reviewing?: boolean;
  error?: string;
  /** Résumés and cover letters this frame's fill uploaded, for the overlay to preview. */
  uploads?: UploadedDoc[];
  detected?: boolean;
  /** When the background got it (Date.now()). */
  at?: number;
}

export interface TabStatus {
  frames: Record<string, FrameStatus>;
  updatedAt: number;
}

export interface ChooseItem {
  fieldId: string;
  question: string;
  intendedAnswer: string;
  options: string[];
  multiple: boolean;
}

export interface Choice {
  fieldId: string;
  optionIndexes: number[] | null;
  confidence: Confidence;
}

export interface EssayItem {
  fieldId: string;
  question: string;
  hint?: string;
  maxChars?: number;
  maxWords?: number;
  kind: "essay" | "cover_letter";
}

export interface DeterministicProfile {
  personal: Profile["personal"];
  /** Set: AI-review consents are answered from the profile instead of the consent settings. */
  aiReviewConsent: Profile["background"]["consentToAiReview"];
  /** Set: optional job-opportunity and marketing opt-ins are answered from the profile instead of the settings. */
  optInConsents: Pick<Profile["background"], "consentToJobOpportunities" | "consentToMarketing">;
  learnedAnswers: Pick<LearnedAnswer, "id" | "question" | "normalizedQuestion" | "kind" | "options" | "answer">[];
}

/** Filled profile entries per repeatable form section (sections opened with an "Add" button). */
export type EntryCounts = Record<
  "experience" | "education" | "certifications" | "languages" | "projects" | "websites",
  number
>;

export interface RuntimeConfig {
  settings: Settings;
  profileSnapshotForDeterministic: DeterministicProfile;
  entryCounts: EntryCounts;
  documentsIndex: DocumentMeta[];
  /** A LaTeX résumé for AI tailoring is uploaded (and compiled). */
  tailorReady: boolean;
  /** The tab's host is in settings.excludedHosts. */
  excluded: boolean;
  selectedModel: string | null;
  hasKeys: boolean;
  overlayBottom: number | null;
  /** YOLO already submitted an application for this posting (shown as a warning, if the user wants it). */
  appliedBefore?: { at: number; url: string };
}

export type ApiErrorKind = "allKeysExhausted" | "noKey" | "noModel" | "modelGone" | "blocked" | "badOutput" | "other";

export interface ApiError {
  kind: ApiErrorKind;
  message: string;
  earliestRetryAt?: number;
}
