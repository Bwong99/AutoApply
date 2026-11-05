import { beforeEach, describe, expect, it } from "vitest";
import { checkFix, reviewForm } from "../../src/background/services/reviewForm";
import type { ServiceCtx } from "../../src/background/services/mapFields";
import { adoption, opForAnswer, revealable } from "../../src/content/review/reconcile";
import { newScanState, scan, type FieldHandle } from "../../src/content/scan/fields";
import { emptyProfile } from "../../src/shared/profileSchema";
import type { ReviewField, ReviewFix } from "../../src/shared/review";
import { defaultSettings } from "../../src/shared/settings";
import type { Profile } from "../../src/shared/types";
import { setBody, stubLayout } from "./dom";

stubLayout();

function profile(): Profile {
  const p = emptyProfile();
  p.personal.firstName = "Ada";
  p.personal.address.country = "Canada";
  p.workAuthorization.entries = [
    {
      ...p.workAuthorization.entries[0],
      country: "Canada",
      authorized: "yes",
      requiresSponsorshipNow: "no",
      requiresSponsorshipFuture: "no",
    },
  ];
  return p;
}

const field = (f: Partial<ReviewField>): ReviewField => ({
  id: "f1",
  question: "Preferred name",
  kind: "text",
  required: false,
  shown: "",
  status: "skipped",
  ...f,
});
const fix = (f: Partial<ReviewFix>): ReviewFix => ({
  fieldId: "f1",
  verdict: "fill",
  answer: "Ada",
  reason: "Profile",
  sources: ["personal.firstName"],
  ...f,
});

describe("review guards (checkFix)", () => {
  it("never changes locked fields or the user's own answers", () => {
    expect(checkFix(fix({}), field({ locked: true }), profile(), false, undefined)).toBeNull();
    expect(checkFix(fix({}), field({ status: "you" }), profile(), false, undefined)).toBeNull();
  });

  it("keeps today's rule for optional fields: the data's answer or nothing", () => {
    expect(checkFix(fix({}), field({}), profile(), false, undefined)?.answer).toBe("Ada");
    expect(checkFix(fix({ sources: [] }), field({}), profile(), false, undefined)).toBeNull();
    expect(checkFix(fix({ sources: ["guess"] }), field({}), profile(), true, undefined)).toBeNull();
    // YOLO guesses optional single choices, as its best guesses do.
    const choice = field({ kind: "radio_group", options: ["Yes", "No"] });
    expect(checkFix(fix({ answer: "No", sources: ["guess"] }), choice, profile(), true, undefined)?.answer).toBe("No");
  });

  it("turns a manual-mode guess for a required field into a suggestion for the user", () => {
    const r = checkFix(fix({ sources: ["guess"] }), field({ required: true }), profile(), false, undefined);
    expect(r).toMatchObject({ verdict: "needs_user", answer: "Ada" });
  });

  it("applies the profile's sponsorship needs and the site a link is asked for", () => {
    const q = field({ question: "Will you require visa sponsorship to work in the United States?", required: true });
    expect(
      checkFix(fix({ answer: "No", sources: ["workAuthorization"] }), q, profile(), true, undefined),
    ).toMatchObject({
      verdict: "needs_user",
      reason: "Sponsorship needed in this country",
    });
    const gh = field({ question: "GitHub profile URL", kind: "url" });
    expect(
      checkFix(
        fix({ answer: "https://linkedin.com/in/ada", sources: ["personal.links.linkedin"] }),
        gh,
        profile(),
        false,
        undefined,
      ),
    ).toBeNull();
  });

  it("drops answers that read as an AI's, and changes nothing a field already shows", () => {
    expect(checkFix(fix({ answer: "As an AI, I cannot" }), field({}), profile(), false, undefined)).toBeNull();
    expect(checkFix(fix({ verdict: "wrong" }), field({ shown: "ada" }), profile(), false, undefined)).toBeNull();
  });

  it("empties only optional fields that hold a value", () => {
    expect(
      checkFix(fix({ verdict: "wrong", answer: "" }), field({ shown: "x" }), profile(), false, undefined),
    ).toMatchObject({
      answer: "",
    });
    expect(
      checkFix(
        fix({ verdict: "wrong", answer: "" }),
        field({ shown: "x", required: true }),
        profile(),
        false,
        undefined,
      ),
    ).toBeNull();
  });
});

describe("reviewForm", () => {
  it("sends the page and fields to the review model and returns checked fixes and missed questions", async () => {
    let spec: { payload: Record<string, unknown>; review?: boolean } | undefined;
    const ctx = {
      ai: {
        call: async (s: never) => {
          spec = s;
          return {
            data: {
              fields: [
                { fieldId: "f1", verdict: "fill", answer: "Ada", reason: "Profile", sources: ["personal.firstName"] },
                { fieldId: "f2", verdict: "ok", sources: [] },
                { fieldId: "f3", verdict: "leave_blank", reason: "No current employer", sources: [] },
                { fieldId: "nope", verdict: "fill", answer: "x", sources: ["resume"] },
              ],
              missed: [
                { refs: ["c4"], question: "Pronouns", kind: "text", required: false, answer: null, sources: [] },
              ],
              reveal: ["c9"],
            },
            usedModel: "m",
            keyLabel: "k",
          };
        },
      },
      settings: defaultSettings(),
      model: "m",
      fallback: null,
    } as unknown as ServiceCtx;
    const r = await reviewForm(ctx, {
      page: "[c1 textbox field=f1]",
      fields: [
        field({}),
        field({ id: "f2", question: "Email" }),
        field({ id: "f3", question: "Current company", shown: "FORM Swim", status: "ai" }),
      ],
      profile: profile(),
      documents: [],
      job: null,
      yolo: false,
      consents: { required: "accept", optional: "decline" },
    });
    expect(spec?.review).toBe(true);
    expect(spec?.payload.page).toBe("[c1 textbox field=f1]");
    expect(r.fixes).toEqual([
      expect.objectContaining({ fieldId: "f1", answer: "Ada" }),
      // "Leave it blank" about a field holding a value empties it.
      expect.objectContaining({ fieldId: "f3", verdict: "wrong", answer: "" }),
    ]);
    expect(r.missed).toEqual([expect.objectContaining({ refs: ["c4"], question: "Pronouns" })]);
    expect(r.reveal).toEqual(["c9"]);
  });
});

describe("reconcile", () => {
  beforeEach(() => setBody(""));
  const handle = (html: string): FieldHandle => {
    setBody(html);
    return scan(newScanState()).handles[0];
  };

  it("turns answers into fills by the field's kind", () => {
    const sel = handle(
      `<label>Province<select><option></option><option>Alberta</option><option>British Columbia</option></select></label>`,
    );
    expect(opForAnswer(sel, "british columbia", sel.desc.options)).toEqual({
      type: "options",
      texts: ["British Columbia"],
    });
    expect(opForAnswer(sel, "BC", sel.desc.options)).toEqual({ type: "intended", answer: "BC" });
    const box = handle(`<label><input type="checkbox"> I agree</label>`);
    expect(opForAnswer(box, "checked")).toEqual({ type: "checked", value: true });
    const text = handle(`<label>City<input></label>`);
    expect(opForAnswer(text, "Vancouver")).toEqual({ type: "text", value: "Vancouver" });
    expect(opForAnswer(text, "")).toEqual({ type: "clear" });
  });

  it("adopts a missed choice group by its options' refs, never a submit button", () => {
    setBody(`<div>Authorized?<span id="y" tabindex="0">Yes</span><span id="n" tabindex="0">No</span></div>
      <form><button id="s">Submit</button></form>`);
    const refs = new Map([
      ["c1", document.getElementById("y")!],
      ["c2", document.getElementById("n")!],
      ["c3", document.getElementById("s")!],
    ]);
    const m = { question: "Authorized?", kind: "radio_group" as const, required: true, answer: "Yes", reason: "" };
    const a = adoption({ ...m, refs: ["c1", "c2"] }, refs);
    expect(a?.[1]).toMatchObject({ kind: "radio_group", label: "Authorized?", required: true });
    expect(a?.[1].members?.map((e) => e.id)).toEqual(["y", "n"]);
    expect(adoption({ ...m, kind: "dropdown", refs: ["c3"] }, refs)).toBeNull();
    expect(revealable(document.getElementById("s")!)).toBe(false);
  });

  it("scans an adopted control as given, with a stable id", () => {
    setBody(`<div>Authorized?<span id="y" tabindex="0">Yes</span><span id="n" tabindex="0">No</span></div>`);
    const state = newScanState();
    expect(scan(state).handles).toHaveLength(0);
    const y = document.getElementById("y")!;
    const n = document.getElementById("n")!;
    state.adopted.set(y, {
      kind: "radio_group",
      label: "Authorized to work in Canada?",
      required: true,
      members: [y, n],
    });
    const [h] = scan(state).handles;
    expect(h.desc).toMatchObject({
      kind: "radio_group",
      label: "Authorized to work in Canada?",
      required: true,
      options: ["Yes", "No"],
    });
    expect(scan(state).handles[0].id).toBe(h.id);
  });
});
