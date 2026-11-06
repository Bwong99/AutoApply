// Human-review policy is local and independent of all AI decisions.
import { normalize } from "../../shared/normalize";
import { SOURCE_NAMES, sourceGroup, type Application, type QueueItem, type SubmissionReview } from "../../shared/yolo";
import fortune from "./fortune.json";
import aliases from "./fortuneAliases.json";

export const FORTUNE_YEAR = fortune.year;
export const companyName = (s: string) =>
  normalize(s)
    .replace(/\b(incorporated|inc|corporation|corp|limited|ltd|llc|plc)\b/g, "")
    .trim()
    .replace(/\s+/g, " ");
const ranks = new Map(fortune.companies.map((c) => [companyName(c.name), c.rank]));
const parents = new Map(aliases.map((a) => [companyName(a.name), companyName(a.parent)]));
const canonical = (s: string) => parents.get(companyName(s)) ?? companyName(s);

export function fortuneRank(company: string): number | undefined {
  return ranks.get(canonical(company));
}

export function reviewReasons(
  r: SubmissionReview,
  item: Pick<QueueItem, "company" | "source" | "sourceGroups">,
  guessed = false,
): string[] {
  if (r.mode === "off") return [];
  if (r.mode === "all") return ["All YOLO applications"];
  const reasons: string[] = [];
  const groups = item.sourceGroups?.length ? item.sourceGroups : [sourceGroup(item.source)];
  for (const g of r.sources) if (groups.includes(g)) reasons.push(SOURCE_NAMES[g]);
  const rank = fortuneRank(item.company);
  if (r.fortune !== "off" && rank && rank <= Number(r.fortune))
    reasons.push(`Fortune ${r.fortune} (${FORTUNE_YEAR}, #${rank})`);
  if (r.companies.some((c) => companyName(c) && canonical(c) === canonical(item.company)))
    reasons.push("Your company list");
  if (r.guessedAnswers && guessed) reasons.push("Guessed or screening-policy answers");
  return [...new Set(reasons)];
}

/** A guessed answer can appear on a later page: preserve the live tab from the outset. */
export const needsReviewTab = (r: SubmissionReview, item: QueueItem) =>
  r.mode !== "off" && (r.guessedAnswers || reviewReasons(r, item).length > 0);

export const pendingReview = (a: Application) =>
  !!a.review && (a.status === "review" || a.status === "needs" || a.status === "failed");

/** Manual submission/dismissal cannot spend the preparation's batch slot a second time. */
export function completedSince(apps: Application[], since: number): number {
  return apps.filter(
    (a) =>
      a.mode === "yolo" &&
      (a.review?.preparedAt ? a.review.preparedAt >= since : a.status === "submitted" && a.at >= since),
  ).length;
}
