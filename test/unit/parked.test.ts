import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chromeMock";
import {
  continueParked,
  MAX_PARKED,
  park,
  parkedFull,
  parkedKeys,
  takeContinued,
  takeParked,
  waitingFor,
  waitingText,
} from "../../src/background/yolo/parked";
import type { Run } from "../../src/background/yolo/runner";

let open: Set<number>;
const run = (tabId: number) => ({ id: `r${tabId}`, tabId }) as Run;

beforeEach(() => {
  installChromeMock();
  open = new Set([1, 2, 3, 4]);
  Object.assign(chrome, {
    tabs: {
      get: vi.fn(async (id: number) => (open.has(id) ? { id } : Promise.reject(new Error("No tab")))),
      update: vi.fn(async () => undefined),
    },
  });
});

describe("parked CAPTCHA tabs", () => {
  it("holds up to the limit, counting only tabs still open", async () => {
    for (let i = 1; i <= MAX_PARKED; i++) expect(await park(`job${i}`, run(i))).toBe(true);
    expect(await park("job4", run(4))).toBe(false);
    open.delete(1); // the user closed one
    expect(await park("job4", run(4))).toBe(true);
    expect((await parkedKeys()).sort()).toEqual(["job2", "job3", "job4"]);
    expect(chrome.tabs.update).toHaveBeenCalledWith(4, { autoDiscardable: false });
  });

  it("hands a parked run back once, and lets Chrome discard its tab again", async () => {
    await park("job", run(2));
    expect(await takeParked("job")).toMatchObject({ tabId: 2 });
    expect(await takeParked("job")).toBeNull();
    expect(chrome.tabs.update).toHaveBeenLastCalledWith(2, { autoDiscardable: true });
  });
});

describe("resumed runs waiting for Continue YOLO", () => {
  it("goes on only for a waiting tab the user pressed Continue in, as a plain run", async () => {
    await park("captcha", run(1));
    await park("stuck", run(2), "Acme – Intern: No Next or Submit button");
    expect(await waitingText(2)).toBe("Acme – Intern: No Next or Submit button");
    expect(await waitingFor("stuck")).toEqual({ tabId: 2, waiting: "Acme – Intern: No Next or Submit button" });
    expect(await waitingFor("captcha")).toBeNull();
    expect(await takeContinued()).toBeNull();
    expect(await continueParked(1)).toBeNull(); // a CAPTCHA park is opened from Applications, not continued
    expect(await continueParked(2)).toBe("stuck");
    const go = await takeContinued();
    expect(go).toEqual({ id: "r2", tabId: 2 });
    expect(await parkedKeys()).toEqual(["captcha"]);
  });

  it("forgets a Continue pressed for an earlier wait when the run waits again", async () => {
    await park("stuck", run(2), "first");
    await continueParked(2);
    await park("stuck", run(2), "again");
    expect(await takeContinued()).toBeNull();
    expect(await waitingText(2)).toBe("again");
  });

  it("is full only with that many tabs still open", async () => {
    for (let i = 1; i <= MAX_PARKED; i++) await park(`job${i}`, run(i), "wait");
    expect(await parkedFull()).toBe(true);
    open.delete(2);
    expect(await parkedFull()).toBe(false);
    expect(await parkedKeys()).not.toContain("job2");
  });
});
