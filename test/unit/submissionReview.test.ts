import { describe, expect, it } from "vitest";
import {
  ApplicationSchema,
  defaultYolo,
  hasReviewRules,
  SubmissionReviewSchema,
  sourceGroup,
} from "../../src/shared/yolo";
import {
  companyName,
  completedSince,
  fortuneRank,
  needsReviewTab,
  pendingReview,
  reviewReasons,
} from "../../src/background/yolo/submissionReview";
import fortune from "../../src/background/yolo/fortune.json";

const item = {
  key: "a",
  alt: "",
  listing: "",
  company: "Google",
  source: "greenhouse",
  url: "https://example.com/job",
  title: "Engineer",
  location: "",
  postedAt: 0,
  addedAt: 0,
};
const policy = (p = {}) => SubmissionReviewSchema.parse({ mode: "matching", ...p });

describe("human submission review", () => {
  it("keeps legacy settings automatic and validates each review setting independently", () => {
    expect(defaultYolo().submissionReview).toEqual({
      mode: "off",
      sources: [],
      fortune: "off",
      companies: [],
      guessedAnswers: false,
      maxPending: 10,
    });
    expect(SubmissionReviewSchema.parse({ mode: "all", maxPending: -1 }).mode).toBe("all");
    expect(SubmissionReviewSchema.parse({ maxPending: 51 }).maxPending).toBe(10);
    expect(hasReviewRules(policy())).toBe(false);
    expect(hasReviewRules(policy({ companies: [" "] }))).toBe(false);
  });
  it("matches any selected rule, preserves source provenance, and never holds when off", () => {
    const r = policy({ sources: ["feeds"], companies: ["Google"], fortune: "500", guessedAnswers: true });
    expect(reviewReasons(r, { ...item, sourceGroups: ["careers", "feeds"] }, true)).toHaveLength(4);
    expect(reviewReasons({ ...r, mode: "off" }, item, true)).toEqual([]);
    expect(reviewReasons({ ...r, mode: "all" }, item)).toEqual(["All YOLO applications"]);
    expect(sourceGroup("workday")).toBe("careers");
    expect(sourceGroup("SimplifyJobs/Summer2027-Internships")).toBe("feeds");
    expect(reviewReasons(policy({ sources: ["careers"] }), item)).toEqual(["Company career sites"]);
  });
  it("uses the complete dated list, preserves tied ranks, and respects the 500 boundary", () => {
    expect(fortune.companies).toHaveLength(1000);
    expect(new Set(fortune.companies.map((c) => c.name)).size).toBe(1000);
    expect(fortune.year).toBe(2026);
    expect(fortuneRank("Google LLC")).toBe(fortuneRank("Alphabet"));
    for (const rank of [499, 500, 501, 1000]) {
      const company = fortune.companies.find((c) => c.rank === rank)!.name;
      expect(reviewReasons(policy({ fortune: "500" }), { ...item, company }).length > 0).toBe(rank <= 500);
      expect(reviewReasons(policy({ fortune: "1000" }), { ...item, company })).toHaveLength(1);
    }
    expect(fortuneRank("Definitely not a Fortune employer")).toBeUndefined();
  });
  it("matches complete normalized company names and verified aliases, without substring collisions", () => {
    expect(companyName("  Target, Inc. ")).toBe("target");
    expect(reviewReasons(policy({ companies: ["Target"] }), { ...item, company: "On Target Labs" })).toEqual([]);
    expect(reviewReasons(policy({ companies: ["Alphabet"] }), item)).toEqual(["Your company list"]);
    expect(reviewReasons(policy({ companies: [" "] }), { ...item, company: "" })).toEqual([]);
  });
  it("reserves a tab for a guess on a later page, even before a guessed answer exists", () => {
    const r = policy({ guessedAnswers: true });
    expect(needsReviewTab(r, item)).toBe(true);
    expect(reviewReasons(r, item, false)).toEqual([]);
    expect(reviewReasons(r, item, true)).toEqual(["Guessed or screening-policy answers"]);
    expect(needsReviewTab(policy({ sources: ["linkedin"] }), item)).toBe(false);
  });
  it("spends a batch slot once at preparation, retaining it after submission or dismissal", () => {
    const a = ApplicationSchema.parse({ ...item, status: "review", at: 100, review: { preparedAt: 100, reasons: [] } });
    expect(pendingReview(a)).toBe(true);
    for (const status of ["review", "submitted", "skipped"] as const) {
      const changed = { ...a, status, at: 300 };
      expect(completedSince([changed], 50)).toBe(1);
      expect(completedSince([changed], 200)).toBe(0);
    }
    expect(completedSince([{ ...a, review: { preparedAt: 0, reasons: [] }, status: "needs" }], 50)).toBe(0);
    expect(completedSince([ApplicationSchema.parse({ ...item, status: "submitted", at: 100 })], 50)).toBe(1);
  });
});
