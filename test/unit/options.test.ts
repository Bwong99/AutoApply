import { describe, expect, it } from "vitest";
import { installChromeMock } from "./chromeMock";
installChromeMock();
const { completeness, leaves, setPath, getPath, newEntries } = await import("../../src/options/store");
const { statusText } = await import("../../src/popup/Popup");
const { emptyProfile } = await import("../../src/shared/profileSchema");

describe("options helpers", () => {
  it("completeness counts personal, work-auth, first education and preferences", () => {
    const p = emptyProfile();
    expect(completeness(p)).toBe(0);
    p.personal.firstName = "Ada";
    p.preferences.willingToRelocate = "yes";
    const c = completeness(p);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(10);
  });
  it("leaves treats arrays as leaves; paths round-trip", () => {
    const o = { a: { b: "x", c: [1, 2] } };
    expect(leaves(o)).toEqual([
      ["a.b", "x"],
      ["a.c", [1, 2]],
    ]);
    setPath(o, "a.b", "y");
    expect(getPath(o, "a.b")).toBe("y");
  });
  it("newEntries keeps only résumé list entries the profile lacks", () => {
    const have = [{ name: "AutoApply", description: "mine" }];
    const found = [
      { name: "auto-apply", description: "résumé" },
      { name: "Chess AI" },
      { name: "Chess AI" },
      { name: "" },
    ];
    expect(newEntries("projects", have, found)).toEqual([{ name: "Chess AI" }]);
    expect(newEntries("skills.technical", ["TypeScript"], ["typescript", "Go"])).toEqual(["Go"]);
    const job = { company: "Acme", title: "SWE" };
    expect(newEntries("experience", [job], [job, { ...job, title: "Intern" }])).toEqual([{ ...job, title: "Intern" }]);
  });
});

describe("popup status line", () => {
  const frame = (counts: Partial<Record<string, number>>, extra = {}) => ({
    frameId: 0,
    running: false,
    needsYou: [],
    counts: {
      total: 0,
      filled: 0,
      aiMatched: 0,
      aiDrafted: 0,
      needsYou: 0,
      failed: 0,
      prefilled: 0,
      skipped: 0,
      ...counts,
    },
    ...extra,
  });
  const r = (frames: object[]) => ({
    status: { frames: Object.fromEntries(frames.map((f, i) => [i, f])), updatedAt: 0 },
    model: "m",
    keysTotal: 1,
    keysHealthy: 1,
  });
  it("summarizes frames", () => {
    expect(statusText(null)).toBe("Not a job form");
    expect(statusText(r([frame({ total: 22, filled: 18, needsYou: 3 })]) as never)).toBe("Filled 18/22 · 3 need you");
    expect(statusText(r([frame({ total: 2 }, { running: true })]) as never)).toBe("Working…");
    expect(statusText(r([frame({ total: 2 }, { error: "All keys exhausted" })]) as never)).toBe(
      "Error: All keys exhausted",
    );
  });
});
