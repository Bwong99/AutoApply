import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSchema, defaultYolo, type Application } from "../../src/shared/yolo";
import type { Run } from "../../src/background/yolo/runner";
import { installChromeMock } from "./chromeMock";

let coordinator: typeof import("../../src/background/yolo");
let runner: typeof import("../../src/background/yolo/runner");
let reviews: typeof import("../../src/background/yolo/reviewTabs");
const application = (key: string, status: Application["status"] = "needs", review = false) =>
  ApplicationSchema.parse({
    key,
    url: `https://example.com/${key}`,
    company: key,
    status,
    ...(review && { review: { reasons: ["Review requested"], preparedAt: 1 } }),
  });
const request = (status: "needs" | "review" | "failed" = "needs") =>
  coordinator.yoloHandlers.YOLO_RESUME_PENDING!({ type: "YOLO_RESUME_PENDING", status }, {});
const sender = (run: Run) =>
  ({ tab: { id: run.tabId }, frameId: 0, url: run.item.url }) as chrome.runtime.MessageSender;
async function running(key: string) {
  await vi.waitFor(async () => {
    expect(await runner.getRun()).toMatchObject({ item: { key }, tabId: expect.any(Number) });
  });
  return (await runner.getRun())!;
}
async function submitted(run: Run) {
  await coordinator.yoloHandlers.YOLO_RESULT!(
    { type: "YOLO_RESULT", runId: run.id, result: { status: "submitted", doneUrl: `${run.item.url}/thanks` } },
    sender(run),
  );
}

beforeEach(async () => {
  vi.resetModules();
  installChromeMock();
  const events = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  let tabId = 10;
  Object.assign(chrome, {
    tabs: {
      onRemoved: events(),
      onUpdated: events(),
      onCreated: events(),
      create: vi.fn(async () => ({ id: tabId++, windowId: 1 })),
      get: vi.fn(async (id: number) => ({ id, windowId: 1, groupId: 1, active: false })),
      update: vi.fn(async () => undefined),
      ungroup: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      group: vi.fn(async () => 1),
      sendMessage: vi.fn(async () => ({ ready: true })),
    },
    tabGroups: { query: vi.fn(async () => []), update: vi.fn(async () => undefined) },
    alarms: {
      onAlarm: events(),
      get: vi.fn(async () => undefined),
      create: vi.fn(async () => undefined),
      clear: vi.fn(async () => true),
    },
    notifications: { onClicked: events(), create: vi.fn() },
  });
  await chrome.storage.local.set({
    yolo: { ...defaultYolo(), boards: [], feeds: [], submissionReview: { mode: "off", maxPending: 1 } },
    yoloQueue: [{ key: "unrelated", url: "https://example.com/unrelated" }],
  });
  coordinator = await import("../../src/background/yolo");
  runner = await import("../../src/background/yolo/runner");
  reviews = await import("../../src/background/yolo/reviewTabs");
  await coordinator.initYolo({
    logLimit: () => 0,
    serviceCtx: async () => ({ error: { kind: "other", message: "Not needed for explicit resumes" } }),
  });
});

describe("resume all Needs you applications", () => {
  it("resumes only Ready for your review applications into review tabs when asked", async () => {
    await chrome.storage.local.set({ applications: [application("first"), application("ready", "review", true)] });
    expect(await request("review")).toEqual({ ok: true, queued: 1 });
    const ready = await running("ready");
    expect(ready.reviewKey).toBe("ready");
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect((await chrome.storage.session.get("yoloPendingResumes")).yoloPendingResumes).toEqual([]);
  });

  it("resumes only Failed applications when asked", async () => {
    await chrome.storage.local.set({
      applications: [application("first"), application("broke", "failed"), application("done", "submitted")],
    });
    expect(await request("failed")).toEqual({ ok: true, queued: 1 });
    await running("broke");
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect((await chrome.storage.session.get("yoloPendingResumes")).yoloPendingResumes).toEqual([]);
  });

  it("refuses to bulk-resume other outcomes", async () => {
    await chrome.storage.local.set({ applications: [application("done", "submitted")] });
    expect(await request("submitted" as "needs")).toMatchObject({ error: { kind: "other" } });
    expect((await chrome.storage.session.get("yoloPendingResumes")).yoloPendingResumes ?? []).toEqual([]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("resumes only Needs you applications one at a time, even with YOLO off", async () => {
    const untouched = [
      application("submitted", "submitted"),
      application("failed", "failed"),
      application("skipped", "skipped"),
      application("ready", "review", true),
    ];
    await chrome.storage.local.set({ applications: [application("first"), application("second"), ...untouched] });
    expect(await request()).toEqual({ ok: true, queued: 2 });
    const first = await running("first");
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    await submitted(first);
    const second = await running("second");
    expect(chrome.tabs.remove).toHaveBeenCalledWith(first.tabId);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
    await submitted(second);
    await vi.waitFor(async () => expect(await runner.getRun()).toBeNull());
    const stored = await chrome.storage.local.get<{ applications: Application[]; yoloQueue: unknown[] }>([
      "applications",
      "yoloQueue",
    ]);
    expect(stored.applications.filter((a: Application) => untouched.some((u) => u.key === a.key))).toEqual(untouched);
    expect(
      stored.applications
        .filter((a: Application) => ["first", "second"].includes(a.key))
        .map((a: Application) => a.status),
    ).toEqual(["submitted", "submitted"]);
    expect(stored.yoloQueue).toEqual([{ key: "unrelated", url: "https://example.com/unrelated" }]);
  });

  it("coalesces repeated requests, preserves an active run, and skips jobs submitted while waiting", async () => {
    await chrome.storage.local.set({ applications: [application("first"), application("second")] });
    const results = await Promise.all([request(), request()]);
    expect(results).toContainEqual({ ok: true, queued: 2 });
    expect(results).toContainEqual({ ok: true, queued: 0 });
    const first = await running("first");
    expect(await request()).toEqual({ ok: true, queued: 0 });
    expect((await runner.getRun())?.id).toBe(first.id);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    await chrome.storage.local.set({ applications: [application("first"), application("second", "submitted")] });
    await submitted(first);
    await vi.waitFor(async () =>
      expect((await chrome.storage.session.get("yoloPendingResumes")).yoloPendingResumes).toEqual([]),
    );
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("preserves live review documents and their edits", async () => {
    await chrome.storage.local.set({ applications: [application("ready", "review", true)] });
    await reviews.retainReview("ready", 7);
    expect(await request()).toEqual({ ok: true, queued: 0 });
    expect((await reviews.reviewList()).live).toEqual(["ready"]);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(chrome.tabs.ungroup).not.toHaveBeenCalled();
  });

  it("manual marking removes queued retries and stops only the matching active resume", async () => {
    await chrome.storage.local.set({
      applications: [application("first"), application("second"), application("third")],
      yoloQueue: [
        { key: "first", url: "https://example.com/first", postedAt: Number.MAX_SAFE_INTEGER },
        { key: "alias", listing: "second", url: "https://example.com/second", postedAt: Number.MAX_SAFE_INTEGER },
        { key: "unrelated", url: "https://example.com/unrelated" },
      ],
    });
    await request();
    const first = await running("first");
    const mark = (key: string) =>
      coordinator.yoloHandlers.YOLO_MARK_SUBMITTED!({ type: "YOLO_MARK_SUBMITTED", key }, {});
    expect(await mark("second")).toEqual({ ok: true });
    expect((await runner.getRun())?.id).toBe(first.id);
    expect(await mark("first")).toEqual({ ok: true });
    const third = await running("third");
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
    // A delayed result from the stopped run must not overwrite the user's submission.
    await coordinator.yoloHandlers.YOLO_RESULT!(
      { type: "YOLO_RESULT", runId: first.id, result: { status: "failed", reason: "Late failure" } },
      sender(first),
    );
    expect((await runner.getRun())?.id).toBe(third.id);
    const stored = await chrome.storage.local.get<{ applications: Application[]; yoloQueue: { key: string }[] }>([
      "applications",
      "yoloQueue",
    ]);
    for (const key of ["first", "second"]) {
      expect(stored.applications.find((a) => a.key === key)).toMatchObject({
        status: "submitted",
        submittedBy: "user",
      });
    }
    expect(stored.yoloQueue.map((i) => i.key)).toEqual(["unrelated"]);
    expect(await mark("second")).toEqual({ ok: true });
    expect((await chrome.storage.local.get("applications")).applications).toEqual(stored.applications);
    expect(await mark("unknown")).toMatchObject({ error: { message: "Unknown application" } });
  });

  it("manual marking releases retained review tracking and preserves application metadata", async () => {
    const original = {
      ...application("ready", "review", true),
      notes: ["Original note"],
      guesses: [{ q: "Start?", a: "May" }],
    };
    await chrome.storage.local.set({ applications: [original] });
    await reviews.retainReview("ready", 7);
    expect(
      await coordinator.yoloHandlers.YOLO_MARK_SUBMITTED!({ type: "YOLO_MARK_SUBMITTED", key: "ready" }, {}),
    ).toEqual({ ok: true });
    expect((await reviews.reviewList()).live).toEqual([]);
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get("applications")).applications).toEqual([
      {
        ...original,
        status: "submitted",
        submittedBy: "user",
        reason: "Marked submitted by you",
        at: expect.any(Number),
      },
    ]);
  });

  it("refills missing review tabs without submitting and continues when the review tab limit frees up", async () => {
    await chrome.storage.local.set({
      applications: [application("first", "needs", true), application("second", "needs", true)],
    });
    expect(await request()).toEqual({ ok: true, queued: 2 });
    const first = await running("first");
    expect(
      await coordinator.yoloHandlers.YOLO_BEFORE_SUBMIT!(
        { type: "YOLO_BEFORE_SUBMIT", runId: first.id, hasGuessedAnswers: false, guesses: [] },
        sender(first),
      ),
    ).toEqual({ action: "held" });
    await vi.waitFor(async () =>
      expect(
        (await chrome.storage.local.get<{ yoloState: { pauseReason: string } }>("yoloState")).yoloState.pauseReason,
      ).toContain("Review tab limit reached (1)"),
    );
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect((await reviews.reviewList()).live).toEqual(["first"]);
    expect(
      (await chrome.storage.local.get<{ applications: Application[] }>("applications")).applications.find(
        (a) => a.key === "first",
      )?.status,
    ).toBe("review");
    await coordinator.yoloHandlers.YOLO_REVIEW_MARK_SUBMITTED!(
      { type: "YOLO_REVIEW_MARK_SUBMITTED", key: "first" },
      {},
    );
    const second = await running("second");
    expect(second.reviewKey).toBe("second");
    expect(second.reviewPolicy?.mode).toBe("all");
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  });

  it("keeps rate-limited resumes queued until the existing cooldown ends", async () => {
    await chrome.storage.local.set({ applications: [application("first")] });
    await request();
    const first = await running("first");
    await coordinator.yoloHandlers.YOLO_RESULT!(
      {
        type: "YOLO_RESULT",
        runId: first.id,
        result: { status: "needs", reason: "Quota", retryAt: Date.now() + 60_000 },
      },
      sender(first),
    );
    expect((await chrome.storage.session.get("yoloPendingResumes")).yoloPendingResumes).toEqual(["first"]);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(1);
    const listener = vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0][0];
    listener({ name: "yolo-resume", scheduledTime: Date.now(), persistAcrossSessions: false });
    const retried = await running("first");
    expect(retried.id).not.toBe(first.id);
    expect(chrome.tabs.create).toHaveBeenCalledTimes(2);
  });
});
