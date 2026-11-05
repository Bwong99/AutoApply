// §10.4 thinking/schema capability handling.
import type { ModelCaps, ThinkingCap } from "../../shared/types";

export const PROBE_TTL = 7 * 24 * 3600 * 1000;

export const THINKING_CHAIN: ThinkingCap[] = [
  { kind: "level", value: "minimal" },
  { kind: "level", value: "low" },
  { kind: "budget", value: 0 },
  { kind: "none" },
];

const same = (a: ThinkingCap, b: ThinkingCap) => JSON.stringify(a) === JSON.stringify(b);

export function nextThinking(t: ThinkingCap): ThinkingCap | null {
  const i = THINKING_CHAIN.findIndex((c) => same(c, t));
  return THINKING_CHAIN[i + 1] ?? null;
}

export function thinkingConfig(t: ThinkingCap): Record<string, unknown> | undefined {
  if (t.kind === "level") return { thinkingLevel: t.value };
  if (t.kind === "budget") return { thinkingBudget: t.value };
  return undefined;
}

/** Essays use `low` instead of `minimal` when the model accepts it (probed lazily). */
export function essayThinking(caps: ModelCaps): ThinkingCap {
  if (caps.thinking.kind === "level" && caps.thinking.value === "minimal")
    return caps.essayThinking ?? { kind: "level", value: "low" };
  return caps.thinking;
}

/**
 * The AI review and YOLO's navigator think as much as the model allows: accuracy over speed (probed lazily; a model
 * refusing it keeps its own tier for them).
 */
export function reviewThinking(caps: ModelCaps): ThinkingCap {
  if (caps.reviewThinking) return caps.reviewThinking;
  if (caps.thinking.kind === "level") return { kind: "level", value: "high" };
  if (caps.thinking.kind === "budget") return { kind: "budget", value: -1 };
  return caps.thinking;
}

export const isFresh = (caps: ModelCaps | undefined, now = Date.now()): caps is ModelCaps =>
  !!caps && now - caps.verifiedAt < PROBE_TTL;
