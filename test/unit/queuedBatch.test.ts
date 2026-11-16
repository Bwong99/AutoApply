import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceCtx } from "../../src/background/services/mapFields";
import type { Run } from "../../src/background/yolo/runner";
import { ApplicationSchema, defaultYolo, QueueItemSchema, type Yolo, type YoloState } from "../../src/shared/yolo";
import { installChromeMock } from "./chromeMock";

let coordinator: typeof import("../../src/background/yolo");
let runner: typeof import("../../src/background/yolo/runner");
let discovery: typeof import("../../src/background/yolo/discover");
const job = (key: string, postedAt = 1) =>
  QueueItemSchema.parse({ key, url: `https://example.com/${key}`, company: key, postedAt });
const request = () => coordinator.yoloHandlers.YOLO_APPLY_QUEUED!({ type: "YOLO_APPLY_QUEUED" }, {});
const status = () => coordinator.yoloHandlers.YOLO_STATUS!({ type: "YOLO_STATUS" }, {});
const sender = (run: Run) =>
  ({
    url: run.item.url,
    ...(run.tabId === undefined ? {} : { tab: { id: run.tabId } }),
  }) as chrome.runtime.MessageSender;

async function setup(config: Partial<Yolo> = {}, state = {}, ctx = {} as ServiceCtx) {
  await chrome.storage.local.set({
    yolo: {
      ...defaultYolo(),
      queries: ["Engineer"],
      boards: ["indeed"],
      jobright: ["recommendations"],
      batchSize: 2,
      intervalMin: 120,
      ...config,
    },
    yoloQueue: [job("first", 3), job("second", 2), job("third")],
    yoloState: { lastCheckAt: 123, ...state },
    documentsIndex: [
      {
        id: "resume",
        label: "Résumé",
        kind: "resume",
        fileName: "resume.pdf",
        mimeType: "application/pdf",
        size: 1,
        isPrimaryResume: true,
        uploadedAt: 1,
      },
    ],
  });
  discovery = await import("../../src/background/yolo/discover");
  vi.spyOn(discovery, "discover").mockResolvedValue(0);
  coordinator = await import("../../src/background/yolo");
  runner = await import("../../src/background/yolo/runner");
  await coordinator.initYolo({ logLimit: () => 0, serviceCtx: async () => ctx });
}

async function running(key: string) {
  await vi.waitFor(async () => expect(await runner.getRun()).toMatchObject({ item: { key } }));
  return (await runner.getRun())!;
}

async function submitted(run: Run) {
  await coordinator.yoloHandlers.YOLO_RESULT!(
    { type: "YOLO_RESULT", runId: run.id, result: { status: "submitted", doneUrl: `${run.item.url}/thanks` } },
    sender(run),
  );
}

beforeEach(() => {
  vi.resetModules();
  installChromeMock();
  vi.stubGlobal("fetch", vi.fn());
  const events = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  const alarms = new Map<string, chrome.alarms.Alarm>();
  let tabId = 10;
  Object.assign(chrome, {
    tabs: {
      onRemoved: events(),
      onUpdated: events(),
      onCreated: events(),
      create: vi.fn(async () => ({ id: tabId++, windowId: 1 })),
      get: vi.fn(async (id: number) => ({ id, windowId: 1, active: false })),
      update: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      group: vi.fn(async () => 1),
      sendMessage: vi.fn(async () => ({ ready: true })),
    },
    tabGroups: { query: vi.fn(async () => []), update: vi.fn(async () => undefined) },
    alarms: {
      onAlarm: events(),
      get: vi.fn(async (name: string) => alarms.get(name)),
      create: vi.fn(async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        alarms.set(name, {
          name,
          scheduledTime: info.when ?? Date.now() + (info.delayInMinutes ?? 0) * 60_000,
          periodInMinutes: info.periodInMinutes,
          persistAcrossSessions: true,
        });
      }),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
      clearAll: vi.fn(async () => (alarms.clear(), true)),
    },
    notifications: { onClicked: events(), create: vi.fn(), clear: vi.fn(async () => true) },
    offscreen: {
      hasDocument: vi.fn(async () => false),
      createDocument: vi.fn(async () => undefined),
      closeDocument: vi.fn(async () => undefined),
    },
    declarativeNetRequest: { updateSessionRules: vi.fn(async () => undefined) },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("apply queued jobs", () => {
  it("stops and requeues an active application when the discovery relevance check hits a usage limit", async () => {
    // Import after resetModules, so the coordinator and test use the same error class.
    const { ClaudeLimitError } = await import("../../src/background/gemini/errors");
    const until = Date.now() + 300_000;
    await setup({ enabled: true, aiRelevanceCheck: true }, {}, {
      ai: {
        call: async () => {
          throw new ClaudeLimitError(until);
        },
      },
      settings: {},
      model: "m",
      fallback: null,
    } as unknown as ServiceCtx);
    await request();
    await running("first");
    vi.mocked(discovery.discover).mockImplementationOnce(async (d) => {
      await d.relevance!([job("candidate")]);
      return 0;
    });
    await coordinator.yoloHandlers.YOLO_CHECK_NOW!({ type: "YOLO_CHECK_NOW" }, {});
    await vi.waitFor(async () => expect((await status()).paused).toBe("AI usage limit reached"));
    await vi.waitFor(async () => expect(await runner.getRun()).toBeNull());
    expect(
      (await chrome.storage.local.get<{ yoloQueue: { key: string }[] }>("yoloQueue")).yoloQueue.map((j) => j.key),
    ).toEqual(["first", "second", "third"]);
    expect((await chrome.storage.local.get("applications")).applications ?? []).toEqual([]);
    expect((await chrome.storage.local.get<{ yoloState: YoloState }>("yoloState")).yoloState.pausedUntil).toBe(until);
    // A later scheduled check retains the warning while the limit is active.
    await coordinator.yoloHandlers.YOLO_CHECK_NOW!({ type: "YOLO_CHECK_NOW" }, {});
    await vi.waitFor(() => expect(discovery.discover).toHaveBeenCalledTimes(2));
    expect((await status()).paused).toBe("AI usage limit reached");
  });

  it.each([false, true])(
    "starts without source checks with YOLO enabled=%s and respects the batch limit",
    async (enabled) => {
      await setup({ enabled });
      expect(await request()).toEqual({ ok: true });
      const first = await running("first");
      const { yoloState } = await chrome.storage.local.get<{ yoloState: YoloState }>("yoloState");
      expect(await status()).toMatchObject({ enabled: true, batchSize: 2, queueOnlyBatch: true });
      expect(yoloState).toMatchObject({ lastCheckAt: 123, queueOnlyBatch: true });
      expect(await chrome.alarms.get("yolo")).toMatchObject({
        scheduledTime: yoloState.batchAt + 120 * 60_000,
        periodInMinutes: 120,
      });
      await submitted(first);
      await submitted(await running("second"));
      await vi.waitFor(async () => expect((await status()).paused).toBe("Batch done"));
      expect(await runner.getRun()).toBeNull();
      expect((await chrome.storage.local.get("yoloQueue")).yoloQueue).toEqual([job("third")]);
      expect(discovery.discover).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("never tops up a queue shorter than the batch, including after a worker restart", async () => {
    await setup();
    await chrome.storage.local.set({ yoloQueue: [job("first")] });
    await request();
    const first = await running("first");
    // Modules reload while local and session storage survive, as they do when Chrome restarts the worker.
    vi.resetModules();
    discovery = await import("../../src/background/yolo/discover");
    vi.spyOn(discovery, "discover").mockResolvedValue(0);
    coordinator = await import("../../src/background/yolo");
    runner = await import("../../src/background/yolo/runner");
    await coordinator.initYolo({ logLimit: () => 0, serviceCtx: async () => ({}) as ServiceCtx });
    await submitted(first);
    await vi.waitFor(() =>
      expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [9001] }),
    );
    expect(await runner.getRun()).toBeNull();
    expect((await status()).queueOnlyBatch).toBe(true);
    expect((await chrome.storage.local.get("yoloQueue")).yoloQueue).toEqual([]);
    expect(discovery.discover).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves an in-flight application and an active AI usage pause", async () => {
    await setup({ enabled: true });
    await request();
    const first = await running("first");
    const pausedUntil = Date.now() + 60_000;
    const { yoloState } = await chrome.storage.local.get<{ yoloState: YoloState }>("yoloState");
    await chrome.storage.local.set({ yoloState: { ...yoloState, pausedUntil, pauseReason: "AI usage limit reached" } });
    await request();
    expect((await runner.getRun())?.id).toBe(first.id);
    expect((await chrome.storage.local.get("yoloState")).yoloState).toMatchObject({
      pausedUntil,
      pauseReason: "AI usage limit reached",
      queueOnlyBatch: true,
    });
    expect(chrome.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(discovery.discover).not.toHaveBeenCalled();
  });

  it.each(["scheduled", "forced"])("returns to normal discovery for the next %s batch", async (next) => {
    await setup();
    await request();
    await running("first");
    if (next === "forced") {
      await coordinator.yoloHandlers.YOLO_FORCE_BATCH!({ type: "YOLO_FORCE_BATCH" }, {});
    } else {
      const alarm = (await chrome.alarms.get("yolo"))!;
      vi.mocked(chrome.alarms.onAlarm.addListener).mock.calls[0][0]({ ...alarm, scheduledTime: Date.now() });
    }
    await vi.waitFor(() => expect(discovery.discover).toHaveBeenCalledTimes(1));
    expect((await status()).queueOnlyBatch).toBe(false);
  });

  it.each(["empty queue", "zero batch size", "missing résumé", "missing search"])(
    "refuses %s without enabling YOLO",
    async (problem) => {
      await setup(
        problem === "zero batch size" ? { batchSize: 0 } : problem === "missing search" ? { queries: [] } : {},
      );
      if (problem === "empty queue") await chrome.storage.local.set({ yoloQueue: [] });
      if (problem === "missing résumé") await chrome.storage.local.set({ documentsIndex: [] });
      expect(await request()).toHaveProperty("error.message");
      expect((await status()).enabled).toBe(false);
      expect(await chrome.alarms.get("yolo")).toBeUndefined();
      expect(await runner.getRun()).toBeNull();
      expect(discovery.discover).not.toHaveBeenCalled();
    },
  );

  it("retains duplicate protection and submission-review limits", async () => {
    await setup({ submissionReview: { ...defaultYolo().submissionReview, mode: "all", maxPending: 1 } });
    await chrome.storage.local.set({
      applications: [ApplicationSchema.parse({ ...job("first"), status: "submitted" })],
    });
    await request();
    const second = await running("second");
    expect(second.reviewPolicy?.mode).toBe("all");
    await coordinator.yoloHandlers.YOLO_BEFORE_SUBMIT!(
      { type: "YOLO_BEFORE_SUBMIT", runId: second.id, hasGuessedAnswers: false, guesses: [] },
      sender(second),
    );
    await vi.waitFor(async () => expect((await status()).paused).toContain("Review limit reached"));
    expect(discovery.discover).not.toHaveBeenCalled();
  });
});
