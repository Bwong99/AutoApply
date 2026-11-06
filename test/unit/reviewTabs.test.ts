import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chromeMock";
import { ApplicationSchema } from "../../src/shared/yolo";
import { recordApplication } from "../../src/background/yolo/applicationStore";
import {
  dismissReview,
  initReviewTabs,
  nextReviewRefill,
  openReview,
  queueReviewRefill,
  retainReview,
  reviewAttempt,
  reviewList,
  reviewRefillStarted,
  submitReview,
} from "../../src/background/yolo/reviewTabs";

let contexts: Map<number, { key: string; ready: boolean }>;
let pump = vi.fn<() => void>();
const a = () =>
  ApplicationSchema.parse({
    key: "job",
    url: "https://example.com/job",
    company: "Acme",
    status: "review",
    review: { reasons: ["All YOLO applications"], preparedAt: 100 },
    guesses: [{ q: "Deadline?", a: "No" }],
    notes: ["Original note"],
    at: 100,
  });

beforeEach(async () => {
  installChromeMock();
  contexts = new Map();
  const events = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  Object.assign(chrome, {
    tabs: {
      onRemoved: events(),
      onUpdated: events(),
      get: vi.fn(async (id: number) => ({ id, windowId: 1, groupId: 1, active: false })),
      update: vi.fn(async () => undefined),
      ungroup: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      group: vi.fn(async () => 1),
      sendMessage: vi.fn(async (id: number, m: { type: string; key: string; ready: boolean }) => {
        if (m.type === "YOLO_REVIEW_CONTEXT") contexts.set(id, { key: m.key, ready: m.ready });
        return { ready: contexts.get(id)?.key === m.key && contexts.get(id)?.ready };
      }),
    },
    windows: { update: vi.fn(async () => undefined) },
    tabGroups: { query: vi.fn(async () => []), update: vi.fn(async () => undefined) },
  });
  pump = vi.fn();
  await initReviewTabs(pump);
  await recordApplication(a());
});

describe("retained review tabs", () => {
  it("focuses the live filled document without opening or reloading a page", async () => {
    await retainReview("job", 7, "original-document");
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.anything(), {
      frameId: 0,
      documentId: "original-document",
    });
    expect((await reviewList()).live).toEqual(["job"]);
    expect(await openReview("job")).toBe(true);
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(7, { active: true });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it("survives a worker restart but never claims a restored empty document is filled", async () => {
    await retainReview("job", 7);
    await initReviewTabs(pump);
    expect((await reviewList()).live).toEqual(["job"]);
    contexts.clear(); // Browser reload: the old document's in-memory review context is gone.
    expect((await reviewList()).live).toEqual([]);
    expect(await openReview("job")).toBe(false);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
  });
  it("coalesces refill requests and retains pending records after browser-session state is lost", async () => {
    await Promise.all([queueReviewRefill("job"), queueReviewRefill("job")]);
    expect((await reviewList()).refilling).toEqual(["job"]);
    expect((await nextReviewRefill())?.key).toBe("job");
    await queueReviewRefill("job");
    await reviewRefillStarted();
    expect(await nextReviewRefill()).toBeNull();
    await chrome.storage.session.clear();
    await initReviewTabs(pump);
    expect((await reviewList()).live).toEqual([]);
    expect((await chrome.storage.local.get("applications")).applications).toEqual([a()]);
  });
  it("serializes simultaneous preparation and manual submission without losing records or review metadata", async () => {
    await retainReview("job", 7);
    await Promise.all([
      submitReview("job", "https://example.com/thanks"),
      recordApplication({ ...a(), key: "another" }),
    ]);
    const apps = (await chrome.storage.local.get("applications")).applications;
    expect(apps).toHaveLength(2);
    expect(apps).toContainEqual({
      ...a(),
      status: "submitted",
      submittedBy: "user",
      doneUrl: "https://example.com/thanks",
      reason: "",
      at: expect.any(Number),
    });
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(pump).toHaveBeenCalled();
  });
  it("dismisses and closes a review without forgetting the application", async () => {
    await retainReview("job", 7);
    await dismissReview("job");
    expect(chrome.tabs.remove).toHaveBeenCalledWith(7);
    expect((await chrome.storage.local.get("applications")).applications).toContainEqual(
      expect.objectContaining({ key: "job", status: "skipped", review: a().review }),
    );
    expect((await reviewList()).live).toEqual([]);
  });
  it("ignores duplicate confirmation events after recording a manual review submission", async () => {
    await retainReview("job", 7);
    const sender = { tab: { id: 7 }, url: "https://example.com/job" } as chrome.runtime.MessageSender;
    await reviewAttempt(sender); // trusted submission, followed by two independent confirmations
    await reviewAttempt(sender, "https://example.com/thanks");
    expect(await reviewAttempt(sender, "https://example.com/thanks")).toBe(true);
    expect(await reviewAttempt({ ...sender, url: "https://example.com/another-job" })).toBe(false);
    expect((await chrome.storage.local.get("applications")).applications).toHaveLength(1);
  });
});
