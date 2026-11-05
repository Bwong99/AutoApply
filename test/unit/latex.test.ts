import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyOps,
  compileErrors,
  describe as describeTex,
  errorLines,
  pageCount,
  parseTex,
  unsupported,
} from "../../src/shared/latex";
import { resumeProblem } from "../../src/shared/resumeMode";
import { DEFAULT_TAILOR_PROMPT, SettingsSchema } from "../../src/shared/settings";
import { YoloSchema } from "../../src/shared/yolo";

const fixture = (f: string) => readFileSync(`test/fixtures/latex/${f}.tex`, "utf8");
const jake = parseTex(fixture("jake"))!;
const body = (tex: string) => tex.slice(tex.indexOf("\\begin{document}"));

describe("parseTex", () => {
  it("numbers Jake's sections, entries, bullets and skills lines; names and dates stay read-only", () => {
    const { resume, groups } = describeTex(jake);
    expect(resume).toContain("S2.E1.B1| \\resumeItem{Developed a REST API using FastAPI");
    expect(resume).toMatch(/L\d+\| \\textbf\{Languages\}\{: Java, Python/);
    // Entry headings (companies, dates) and the header have no id of their own.
    expect(resume).toMatch(/\n {2}\{Southwestern University\}\{Georgetown, TX\}/);
    expect(resume).toMatch(/\n {2}\\textbf\{\\Huge \\scshape Jake Ryan\}/);
    expect(groups).toContainEqual({ group: "sections", items: ["S1", "S2", "S3", "S4"] });
    expect(groups).toContainEqual({ group: "S2", items: ["S2.E1", "S2.E2", "S2.E3"] });
    expect(groups).toContainEqual({ group: "S2.E1.R1", items: ["S2.E1.B1", "S2.E1.B2", "S2.E1.B3"] });
    // The preamble is never part of what the AI sees.
    expect(resume).not.toContain("usepackage");
  });

  it("marks moderncv's \\cventry as an entry even in a section with one, and finds its bullets", () => {
    const { resume, groups } = describeTex(parseTex(fixture("moderncv-classic"))!);
    expect(resume).toContain("S1.E1| \\cventry{2015--2019}");
    expect(resume).toContain("S2.E1.B1| \\item Achievement 1;");
    expect(groups).toContainEqual({ group: "S2.E1.R1", items: ["S2.E1.B1", "S2.E1.B2"] });
  });

  it("returns null without a document body", () => {
    expect(parseTex("\\documentclass{article}\n\\usepackage{x}")).toBeNull();
  });
});

describe("applyOps", () => {
  it("rewords, adds, removes and reorders, leaving everything else byte-identical", () => {
    const r = applyOps(jake, {
      edits: [{ id: "S2.E1.B1", text: "\\resumeItem{Built a REST API in FastAPI & PostgreSQL}" }],
      add: [{ after: "S2.E1.B2", text: "\\resumeItem{Wrote 40% of the test suite}" }],
      remove: ["S2.E3.B6"],
      order: [
        { group: "S2.E1.R1", items: ["S2.E1.B3", "S2.E1.B2", "S2.E1.B1"] },
        { group: "sections", items: ["S2", "S1", "S3", "S4"] },
      ],
    });
    expect(r).toMatchObject({ applied: 5, dropped: 0 });
    const out = body(r.tex);
    // Bare & and % are escaped where the original line had none.
    expect(out).toContain("\\resumeItem{Built a REST API in FastAPI \\& PostgreSQL}");
    expect(out).toContain("\\resumeItem{Wrote 40\\% of the test suite}");
    expect(out).not.toContain("Presented virtually");
    const [b3, b2, added, b1] = [
      "Explored ways to visualize",
      "full-stack web application using Flask, React",
      "Wrote 40",
      "Built a REST API",
    ].map((t) => out.indexOf(t));
    expect(b3).toBeLessThan(b2);
    expect(b2).toBeLessThan(added);
    expect(added).toBeLessThan(b1);
    expect(out.indexOf("\\section{Experience}")).toBeLessThan(out.indexOf("\\section{Education}"));
    // The preamble and every untouched line are as uploaded.
    expect(r.tex.startsWith(fixture("jake").slice(0, fixture("jake").indexOf("\\begin{document}")))).toBe(true);
    expect(out).toContain("{Southwestern University}{Georgetown, TX}");
    expect(r.tex.split("\n").length).toBe(fixture("jake").split("\n").length);
  });

  it("drops edits that change the layout, add commands or packages, or touch read-only lines", () => {
    const r = applyOps(jake, {
      edits: [
        { id: "S2.E1.B1", text: "\\textbf{Developed a REST API}" }, // another leading command
        { id: "S2.E1.B2", text: "\\resumeItem{Built}{extra}" }, // another argument
        { id: "S2.E1.B3", text: "\\resumeItem{\\fancything{Explored}}" }, // a command the résumé lacks
        { id: "S2.E2.B1", text: "\\resumeItem{x}\\usepackage{fontspec}" },
        { id: "S2.E2.B2", text: "\\resumeItem{unbalanced" },
        { id: "S2.E1", text: "\\resumeSubheading" }, // entries can't be edited
        { id: "S9.B1", text: "\\resumeItem{x}" }, // no such unit
      ],
      remove: ["S2.E1"], // not a bullet
      order: [{ group: "S2", items: ["S2.E1", "S2.E2"] }], // not a permutation
    });
    expect(r).toMatchObject({ applied: 0, dropped: 9 });
    expect(r.tex).toBe([jake.preamble, ...jake.lines, jake.tail].join("\n"));
  });

  it("never removes every bullet of a list", () => {
    const r = applyOps(jake, { remove: ["S2.E1.B1", "S2.E1.B2", "S2.E1.B3"] });
    expect(r).toMatchObject({ applied: 2, dropped: 1 });
    expect(body(r.tex)).toContain("Explored ways to visualize");
  });

  it("traces output lines to their op, so a compile error can undo just that edit", () => {
    const r = applyOps(jake, { edits: [{ id: "S2.E1.B2", text: "\\resumeItem{Built a full-stack app}" }] });
    const line = r.tex.split("\n").findIndex((l) => l.includes("Built a full-stack app")) + 1;
    expect(r.origin.get(line)).toBe("edit:S2.E1.B2");
    const undone = applyOps(
      jake,
      { edits: [{ id: "S2.E1.B2", text: "\\resumeItem{Built}" }] },
      new Set(["edit:S2.E1.B2"]),
    );
    expect(undone.applied).toBe(0);
    expect(errorLines("! Undefined control sequence.\nl.88 \\resumeItem{x}\n")).toEqual([88]);
  });
});

describe("upload checks", () => {
  const bundle = { packages: ["geometry", "hyperref", "fontawesome5"], classes: ["article"] };
  it("names packages and classes the bundle lacks, and XeLaTeX-only ones as such", () => {
    const src = "\\documentclass{awesome-cv}\n\\usepackage[margin=1in]{geometry,fontspec}\n% \\usepackage{ignored}\n";
    expect(unsupported(src, bundle)).toEqual([
      "Unsupported document class: awesome-cv",
      "Unsupported package: fontspec (XeLaTeX/LuaLaTeX only)",
    ]);
  });
  it("reads missing packages and LaTeX errors off a log", () => {
    expect(compileErrors("! LaTeX Error: File `tcolorbox.sty' not found.\n")).toEqual([
      "Unsupported package: tcolorbox",
    ]);
    expect(compileErrors("! Undefined control sequence.\n<argument> \\foo\nl.12 \\foo\n")).toEqual([
      "Undefined control sequence.",
      "  at l.12 \\foo",
    ]);
    expect(pageCount("Output written on main.pdf (2 pages, 41203 bytes).")).toBe(2);
  });
});

describe("Upload résumés", () => {
  it("defaults to Variant select and the default prompt, for autofill and YOLO", () => {
    expect(SettingsSchema.parse({})).toMatchObject({ resumeUpload: "variants", tailorPrompt: DEFAULT_TAILOR_PROMPT });
    expect(SettingsSchema.parse({ resumeUpload: "bogus" }).resumeUpload).toBe("variants");
    expect(YoloSchema.parse({}).resumeUpload).toBe("variants");
    expect(YoloSchema.parse({ resumeUpload: "flag" }).resumeUpload).toBe("variants");
  });
  it("blocks a mode without its résumé", () => {
    expect(resumeProblem("tailor", [{ kind: "resume" }], false)).toMatch(/AI tailor is selected for Autofill/);
    expect(resumeProblem("variants", [{ kind: "cover_letter" }], true, "YOLO")).toMatch(
      /Variant select is selected for YOLO, but no résumé/,
    );
    expect(resumeProblem("flag", [], false)).toBe("");
    expect(resumeProblem("tailor", [], true)).toBe("");
  });
});

describe("hidden résumé text", () => {
  it("drops an edit that hides keywords from readers, beyond what the line had", () => {
    const r = applyOps(jake, {
      edits: [{ id: "S2.E1.B1", text: "\resumeItem{Developed a REST API \tiny{kubernetes rust golang}}" }],
    });
    expect(r).toMatchObject({ applied: 0, dropped: 1 });
  });
});
