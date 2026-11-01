import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBody, stubLayout } from "./dom";
import { addEntries, expandSections, resumeEntries, saveEntries, trimEntries } from "../../src/content/fill/sections";
import { newScanState, scan } from "../../src/content/scan/fields";
import type { EntryCounts } from "../../src/shared/types";

beforeAll(stubLayout);
beforeEach(() => setBody(""));

const none: EntryCounts = { experience: 0, education: 0, certifications: 0, languages: 0, projects: 0, websites: 0 };

// Workday "My Experience" (no <form>, buttons without a type): each Add renders a numbered entry asynchronously;
// the first Education entry is always open.
function workdaySection(title: string, open = 0) {
  const entry = (n: number) =>
    `<div role="group"><h5>${title} ${n}</h5>${n > 1 ? "<button>Delete</button>" : ""}<input></div>`;
  return `<div role="group" data-title="${title}"><h4>${title}</h4>${Array.from({ length: open }, (_, i) => entry(i + 1)).join("")}
    <button data-automation-id="add-button">${open ? "Add Another" : "Add"}</button></div>`;
}

function wireAdds() {
  const clicks: Record<string, number> = {};
  for (const g of document.querySelectorAll<HTMLElement>("[data-title]")) {
    const title = g.dataset.title!;
    g.querySelector("button[data-automation-id=add-button]")!.addEventListener("click", (e) => {
      clicks[title] = (clicks[title] ?? 0) + 1;
      const btn = e.currentTarget as HTMLElement;
      setTimeout(() => {
        const n = g.querySelectorAll("h5").length + 1;
        btn.insertAdjacentHTML(
          "beforebegin",
          `<div role="group"><h5>${title} ${n}</h5><button>Delete</button><input></div>`,
        );
        btn.textContent = "Add Another";
      }, 30);
    });
  }
  return clicks;
}

const entries = (title: string) => document.querySelectorAll(`[data-title="${title}"] h5`).length;

describe("addEntries", () => {
  it("opens only the entries the profile has", async () => {
    setBody(
      `<h3>My Experience</h3>${workdaySection("Work Experience")}${workdaySection("Education", 1)}` +
        `${workdaySection("Certifications")}${workdaySection("Languages")}<h4>Resume/CV</h4><button>Select files</button>`,
    );
    const clicks = wireAdds();
    await addEntries({ ...none, experience: 2, education: 1, languages: 1 }, new AbortController().signal);
    expect([entries("Work Experience"), entries("Education"), entries("Certifications"), entries("Languages")]).toEqual(
      [2, 1, 0, 1],
    );
    expect(clicks).toEqual({ "Work Experience": 2, Languages: 1 });
  });

  it("labels each new entry's fields with its numbered section", async () => {
    setBody(workdaySection("Work Experience"));
    wireAdds();
    await addEntries({ ...none, experience: 2 }, new AbortController().signal);
    expect(scan(newScanState()).handles.map((h) => h.desc.section)).toEqual(["Work Experience 1", "Work Experience 2"]);
  });

  it("adds to a section that already has entries", async () => {
    setBody(workdaySection("Education", 1));
    wireAdds();
    await addEntries({ ...none, education: 3 }, new AbortController().signal);
    expect(entries("Education")).toBe(3);
  });

  it("does nothing when the profile has no entries", async () => {
    setBody(workdaySection("Work Experience"));
    const clicks = wireAdds();
    await addEntries(none, new AbortController().signal);
    expect(clicks).toEqual({});
  });

  it("never repeats an Add click that added nothing countable", async () => {
    setBody(`<form><h4>Work Experience</h4><button type="button" id="b">Add</button></form>`);
    let clicks = 0;
    document.getElementById("b")!.addEventListener("click", () => clicks++);
    await addEntries({ ...none, experience: 3 }, new AbortController().signal);
    expect(clicks).toBe(1);
  });

  it("never clicks an Add button that would submit its form", async () => {
    setBody(`<form><h4>Work Experience</h4><button id="b">Add</button></form>`);
    let clicks = 0;
    document.getElementById("b")!.addEventListener("click", () => clicks++);
    await addEntries({ ...none, experience: 1 }, new AbortController().signal);
    expect(clicks).toBe(0);
  });

  it("ignores Add buttons of unrelated sections", async () => {
    setBody(
      `<form><h4>Skills</h4><button type="button" id="b">Add</button><h4>Work Experience</h4><button type="button" id="f">Add file</button></form>`,
    );
    let clicks = 0;
    for (const b of document.querySelectorAll("button")) b.addEventListener("click", () => clicks++);
    await addEntries({ ...none, experience: 1 }, new AbortController().signal);
    expect(clicks).toBe(0);
  });
});

// SuccessFactors: every section but the first collapsed (display:none, Add button included) behind a type=submit
// toggle in its <h2>; Add (a div[role=button] behind an icon-font glyph) appends a row with its own Remove.
describe("expandSections", () => {
  function successFactors() {
    const section = (title: string, body: string) =>
      `<div><h2><button aria-expanded="false">${title}</button></h2><div style="display:none">${body}</div></div>`;
    setBody(
      `<form>${section("Profile Information", "<label>First Name <input></label>")}` +
        `${section("Work Experience", `<div role="button" id="add"><span role="presentation">\uE1F6</span> Add</div>`)}` +
        `${section("Benefits", "<p>Free lunch</p>")}</form>`,
    );
    const opened: string[] = [];
    for (const t of document.querySelectorAll<HTMLButtonElement>("h2 button"))
      t.addEventListener("click", (e) => {
        e.preventDefault();
        opened.push(t.textContent!);
        t.setAttribute("aria-expanded", "true");
        t.parentElement!.nextElementSibling!.removeAttribute("style");
      });
    const add = document.getElementById("add")!;
    add.addEventListener("click", () =>
      add.insertAdjacentHTML("beforebegin", `<div><input><div role="button">Remove</div></div>`),
    );
    return opened;
  }

  it("opens the collapsed sections holding fields, then adds entries to them", async () => {
    const opened = successFactors();
    await expandSections(new AbortController().signal);
    await addEntries({ ...none, experience: 2 }, new AbortController().signal);
    expect(opened).toEqual(["Profile Information", "Work Experience"]);
    expect(scan(newScanState()).handles.map((h) => h.desc.label)).toHaveLength(3);
  });
});

// SmartRecruiters: shadow-DOM buttons and headings whose text comes through <slot>s; each Add opens an editor beside
// the heading's wrapper with its own Save (type=button); Save turns it into a card with "Delete experience …".
function srButton(host: Element, text: string, onClick: () => void) {
  const b = host.attachShadow({ mode: "open" });
  b.innerHTML = `<button type="button"><slot></slot></button>`;
  host.textContent = text;
  b.querySelector("button")!.addEventListener("click", onClick);
}
function smartRecruiters() {
  setBody(`<form><section id="exp"><div><h3>Experience</h3><x-btn id="add"></x-btn></div><div id="list"></div></section>
    <section><h3>Message to the Hiring Team</h3><textarea></textarea></section>
    <x-btn id="next"></x-btn><button>Save and continue</button></form>`);
  const list = document.getElementById("list")!;
  const saved: string[] = [];
  srButton(document.getElementById("add")!, "Add", () => {
    const editor = document.createElement("div");
    editor.innerHTML = `<label>Title <input class="title"></label><x-btn class="cancel"></x-btn><x-btn class="save"></x-btn>`;
    list.append(editor);
    srButton(editor.querySelector(".cancel")!, "Cancel", () => editor.remove());
    srButton(editor.querySelector(".save")!, "Save", () => {
      const title = editor.querySelector<HTMLInputElement>(".title")!.value;
      saved.push(title);
      editor.outerHTML = `<div><b>${title}</b><button aria-label="Delete experience ${title}"></button></div>`;
    });
  });
  let next = 0;
  srButton(document.getElementById("next")!, "Next", () => next++);
  return { saved, nexts: () => next };
}

describe("entry editors with their own Save (SmartRecruiters)", () => {
  it("opens one editor per profile entry, saves only those, and never presses Next", async () => {
    const sr = smartRecruiters();
    const saves = await addEntries({ ...none, experience: 2 }, new AbortController().signal);
    expect(saves).toHaveLength(2);
    const titles = [...document.querySelectorAll<HTMLInputElement>(".title")];
    titles[0].value = "Software Engineer Intern";
    titles[1].value = "IT Technician Intern";
    // The two editors share one heading: their fields are numbered as separate entries for the AI.
    expect(
      scan(newScanState())
        .handles.filter((h) => h.desc.label === "Title")
        .map((h) => h.desc.section),
    ).toEqual(["Experience 1", "Experience 2"]);
    await saveEntries(saves);
    expect(sr.saved).toEqual(["Software Engineer Intern", "IT Technician Intern"]);
    expect(sr.nexts()).toBe(0);
    // A second fill finds the saved entries and adds no more.
    expect(await addEntries({ ...none, experience: 2 }, new AbortController().signal)).toEqual([]);
    expect(document.querySelectorAll(".title")).toHaveLength(0);
  });
});

// Breezy: entries named only by placeholders, each with a Delete link; work and education share one section.
const breezyEntry = (job: boolean, company = "") =>
  `<li><input placeholder="${job ? "Company" : "School"}" value="${company}"><input placeholder="${job ? "Title" : "Field of Study"}">` +
  `<span>Start date</span><input type="date" placeholder="Company"><a href="" class="del">Delete</a></li>`;
function breezy(jobs: string[], schools = 1) {
  setBody(`<div class="section"><h3>Work History</h3><ul>${jobs.map((c) => breezyEntry(true, c)).join("")}</ul>
    <a href="">Add Position</a><h3>Education</h3><ul>${Array.from({ length: schools }, () => breezyEntry(false)).join("")}</ul>
    <a href="">Add Education</a></div>`);
  for (const a of document.querySelectorAll<HTMLElement>(".del"))
    a.addEventListener("click", (e) => {
      e.preventDefault();
      a.closest("li")!.remove();
    });
}
const companies = () =>
  [...document.querySelectorAll<HTMLInputElement>("[placeholder=Company]:not([type])")].map((i) => i.value);
const signal = () => new AbortController().signal;

// iCIMS: each entry a fieldset with its own "Experience (n)" legend and, past the first, a Delete that hides it; an
// "Add more (Experience)" follows each.
function icims(n: number) {
  setBody(
    Array.from(
      { length: n },
      (_, i) => `<div><fieldset><legend>Experience (${i + 1})</legend>${
        i ? `<div><a href="javascript:void(0)" role="button" aria-label="Delete Experience (${i + 1})"></a></div>` : ""
      }<label for="e${i}">Employer</label><input id="e${i}" value="Parsed ${i + 1}"></fieldset>
      <div><a href="javascript:void(0)">Add more (Experience)</a></div></div>`,
    ).join(""),
  );
  for (const a of document.querySelectorAll<HTMLElement>("[aria-label^=Delete]"))
    a.addEventListener("click", () => (a.closest("fieldset")!.style.display = "none"));
}

describe("résumé entries a site's parser wrote", () => {
  it("finds each work and education entry by its Delete, numbered per kind", () => {
    breezy(["Karuta", "FORM Swim", "Langley"]);
    const es = resumeEntries();
    expect(es.map((e) => `${e.kind} ${e.n}`)).toEqual(["experience 1", "experience 2", "experience 3", "education 1"]);
    // Each job is its <li>; the lone school runs to its list, up to the Add link.
    expect(es.map((e) => e.box.tagName)).toEqual(["LI", "LI", "LI", "UL"]);
  });

  it("reads an entry's kind from its labels (Avature), else its Delete's words and number (iCIMS)", () => {
    setBody(`<div><label for="t1">Position Title *</label><input id="t1"><label for="c1">Company *</label><input id="c1">
        <button type="button">REMOVE</button></div>
      <div><label for="t2">Position Title *</label><input id="t2"><label for="c2">Company *</label><input id="c2">
        <button type="button">REMOVE</button></div>
      <button type="button">ADD ANOTHER</button>
      <div><label for="s1">Institution/Program *</label><input id="s1"><button type="button">REMOVE</button></div>
      <button type="button">ADD ANOTHER</button>
      <div><label for="cv">Resume</label><input id="cv" type="file"><button type="button">Remove</button></div>
      <button type="button">Delete File</button>`);
    expect(resumeEntries().map((e) => `${e.kind} ${e.n}`)).toEqual(["experience 1", "experience 2", "education 1"]);
    icims(3);
    const es = resumeEntries();
    expect(es.map((e) => `${e.kind} ${e.n}`)).toEqual(["experience 2", "experience 3"]);
    expect(es.map((e) => e.box.tagName)).toEqual(["FIELDSET", "FIELDSET"]);
  });

  it("deletes the entries past the profile's, latest first, and keeps ours", async () => {
    breezy(["Karuta", "FORM Swim", "Langley", "HabitKicker"], 2);
    const mine = document.querySelectorAll("li")[3];
    await trimEntries({ ...none, experience: 2, education: 1 }, (box) => box === mine, signal());
    expect(companies()).toEqual(["Karuta", "FORM Swim", "HabitKicker"]);
    expect(document.querySelectorAll("[placeholder=School]")).toHaveLength(1);
  });

  it("deletes every entry of a kind the profile has none of, and nothing when counts fit", async () => {
    breezy(["Karuta"], 1);
    await trimEntries({ ...none, experience: 1, education: 1 }, () => false, signal());
    expect(companies()).toEqual(["Karuta"]);
    await trimEntries({ ...none, education: 1 }, () => false, signal());
    expect(companies()).toEqual([]);
  });

  it("deletes by the number the page gives each entry, the first having no Delete (iCIMS)", async () => {
    icims(4);
    await trimEntries({ ...none, experience: 2 }, () => false, signal());
    expect([...document.querySelectorAll("fieldset")].map((f) => f.style.display)).toEqual(["", "", "none", "none"]);
  });
});
