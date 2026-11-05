import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setBody, stubLayout } from "./dom";
import { newScanState, scan, type FieldHandle } from "../../src/content/scan/fields";
import {
  closeDropdown,
  fillDropdown,
  harvestOptions,
  openDropdown,
  optionElements,
  searchOptions,
} from "../../src/content/fill/dropdown";
import { abbreviates, fillTypeahead } from "../../src/content/fill/typeahead";
import { fill } from "../../src/content/fill/engine";
import { realClick } from "../../src/content/fill/events";
import { fillFile, findDropzones } from "../../src/content/fill/file";
import { dropdownText, readValue } from "../../src/content/fill/verify";

beforeAll(() => {
  stubLayout();
  // happy-dom rejects the case-insensitive attribute flag ([class*=loading i]) that Chrome supports.
  const proto = Element.prototype as unknown as Record<"querySelectorAll" | "matches", (s: string) => unknown>;
  for (const m of ["querySelectorAll", "matches"] as const) {
    const orig = proto[m];
    proto[m] = function (this: Element, s: string) {
      return orig.call(this, s.replace(/ i\]/g, "]"));
    };
  }
});
beforeEach(() => setBody(""));

/** Select2-like widget: mousedown opens a popup (linked by aria-controls) holding `rows`. */
function select2(rows: string) {
  setBody(`<div><label>Country</label>
    <span role="combobox" aria-haspopup="true" aria-expanded="false" aria-controls="res">Select…</span></div>
    <ul id="res" role="listbox" hidden></ul>`);
  const t = document.querySelector<HTMLElement>("[role=combobox]")!;
  const ul = document.getElementById("res")!;
  t.addEventListener("mousedown", () => {
    t.setAttribute("aria-expanded", "true");
    ul.hidden = false;
    ul.innerHTML = rows;
  });
  t.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    t.setAttribute("aria-expanded", "false");
    ul.hidden = true;
  });
  return { h: scan(newScanState()).handles[0], ul };
}

describe("remote dropdowns (Select2 AJAX)", () => {
  it("an opened list that settles empty gives up without the slow fallback", async () => {
    const { h, ul } = select2(`<li role="option" class="select2-results__message">No results found</li>`);
    const t0 = Date.now();
    expect(await openDropdown(h)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(700);
    expect(ul.hidden).toBe(true);
  });

  it("does not read react-select's notice in an empty listbox as an option", async () => {
    const { h, ul } = select2(`<div class="select__menu-notice select__menu-notice--no-options">Start typing...</div>`);
    expect(await openDropdown(h)).toBeNull();
    expect(ul.hidden).toBe(true);
  });

  it("a short harvest skips a list that is still loading more pages", async () => {
    const { h } = select2(
      `<li role="option">Albania</li><li role="option">Algeria</li><li role="option">Loading more results…</li>`,
    );
    expect(await harvestOptions(h, 400)).toBeNull();
    expect(await harvestOptions(h)).toEqual(["Albania", "Algeria"]);
  });

  it("a dropdown search with no suggestions flags and clears the search box instead of keeping the typed text", async () => {
    setBody(`<div><label>Skills</label><span role="combobox" aria-haspopup="true" aria-expanded="false">
      <input type="search" class="select2-search__field"></span></div>`);
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Python programming", "Python programming", async () => null);
    expect(r.outcome).toBe("flag");
    expect(h.searchInput!.value).toBe("");
  });

  it("a remote search dropdown picks the AI's choice even if the list closed while it chose, and verifies the pick", async () => {
    // react-select (Greenhouse location): typing lists suggestions; a pick shows in the control and empties the input.
    setBody(`<div><label>Location (City)</label><div class="select__control"><div class="select__value"></div>
      <input role="combobox" aria-haspopup="true" aria-expanded="false" aria-controls="menu"></div></div>
      <div id="menu" role="listbox" hidden></div>`);
    const h = scan(newScanState()).handles[0];
    const menu = document.getElementById("menu")!;
    const input = h.searchInput!;
    input.addEventListener("input", () => {
      menu.hidden = false;
      menu.innerHTML = `<div role="option">Vancouver, British Columbia, Canada</div><div role="option">Vancouver, Washington, United States</div>`;
    });
    // Delegated like React's handlers: a click on a detached option reaches nothing.
    menu.addEventListener("click", (e) => {
      if (!menu.contains(e.target as Node)) return; // happy-dom still bubbles from detached nodes
      h.el.querySelector(".select__value")!.textContent = (e.target as Element).textContent;
      input.value = "";
      menu.hidden = true;
    });
    // Another fill takes focus while the AI chooses: the list closes and its options are gone.
    const close = () => ((menu.hidden = true), (menu.innerHTML = ""));
    const r = await fillTypeahead(h, "Vancouver", "Vancouver", async () => (close(), 0));
    expect(r).toEqual({ outcome: "ok", shown: "Vancouver, British Columbia, Canada" });
    expect(h.el.textContent!.trim()).toBe("Vancouver, British Columbia, Canada");
  });

  it("a Workday prompt reads as empty, opens from its search box, searches on Enter and picks via the row label", async () => {
    // Another field's chips (Skills) are a listbox too; they must not be mistaken for this prompt's results.
    setBody(`<ul role="listbox" aria-label="Skills"><li role="option">Python</li></ul>
      <div><label for="fos">Field of Study</label><div data-automation-id="multiSelectContainer" tabindex="-1">
        <div data-automation-id="multiselectInputContainer">
          <input id="fos" placeholder="Search" enterkeyhint="search" aria-describedby="fos-sr">
          <div id="fos-sr" aria-hidden="true">0 items selected</div></div></div></div>`);
    const h = scan(newScanState()).handles.find((x) => x.desc.label === "Field of Study")!;
    expect(h.desc.kind).toBe("dropdown");
    expect(h.prefilled).toBe(false);
    expect(h.desc.currentValue).toBeUndefined();

    const all = ["Accounting", "Acting", "Computer Engineering", "Computer Science"];
    const input = h.searchInput!;
    let popup: HTMLElement | null = null;
    const show = (rows: string[]) => {
      popup?.remove();
      popup = document.createElement("div");
      popup.setAttribute("role", "listbox");
      popup.innerHTML = rows
        .map(
          (t) =>
            `<div role="option" aria-setsize="${rows.length}"><div data-automation-id="promptOption">${t}</div></div>`,
        )
        .join("");
      document.body.append(popup);
    };
    // Only the search box opens it; only the row's label takes a pick; Enter re-renders the popup with the hits.
    input.addEventListener("click", () => show(all.slice(0, 2)));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") popup?.remove();
      if (e.key !== "Enter") return;
      popup?.remove();
      setTimeout(() => show(all.filter((t) => t.includes(input.value))), 100);
    });
    document.addEventListener("click", (e) => {
      const label = (e.target as Element).closest?.('[data-automation-id="promptOption"]');
      if (!label) return;
      input.insertAdjacentHTML("afterend", `<div>${label.textContent}</div>`);
      popup?.remove();
    });

    expect(await searchOptions(h, "Computer")).toEqual(["Computer Engineering", "Computer Science"]);
    expect(await fillDropdown(h, ["Computer Science"])).toEqual({ outcome: "ok", shown: "Computer Science" });
  });

  it("searches a Workday prompt for how they heard when its list shows only categories", async () => {
    setBody(`<div><label for="src">How Did You Hear About Us?</label><div data-automation-id="multiSelectContainer">
      <div data-automation-id="multiselectInputContainer"><input id="src" placeholder="Search" enterkeyhint="search">
      </div></div></div>`);
    const h = scan(newScanState()).handles[0];
    const input = h.searchInput!;
    let popup: HTMLElement | null = null;
    const show = (rows: string[]) => {
      popup?.remove();
      popup = document.createElement("div");
      popup.setAttribute("role", "listbox");
      popup.innerHTML = rows
        .map((t) => `<div role="option"><div data-automation-id="promptOption">${t}</div></div>`)
        .join("");
      document.body.append(popup);
    };
    input.addEventListener("click", () => show(["Company Website", "Job Board"]));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") popup?.remove();
      if (e.key === "Enter") show(["Glassdoor", "LinkedIn"].filter((t) => t.includes(input.value)));
    });
    document.addEventListener("click", (e) => {
      const label = (e.target as Element).closest?.('[data-automation-id="promptOption"]');
      if (!label || label.textContent === "Job Board") return;
      input.insertAdjacentHTML("afterend", `<div>${label.textContent}</div>`);
      popup?.remove();
    });
    const chosen: string[][] = [];
    const d = { ...deps(), choose: async (_: unknown, __: string, o: string[]) => (chosen.push(o), [1]) };
    d.harvested.set(h.id, ["Company Website", "Job Board"]);
    expect(await fill(h, { type: "intended", answer: "LinkedIn", query: "LinkedIn" }, d)).toMatchObject({
      outcome: "ok",
      shown: "LinkedIn",
    });
    expect(chosen).toEqual([]);
  });

  it("picks the job-board category of a flat how-they-heard list for a job board (Sun Life's Workday)", async () => {
    setBody(`<div><label>How Did You Hear About Us?</label>
      <div role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="menu">Select One</div></div>
      <ul id="menu" role="listbox" hidden><li role="option">Direct Contact</li><li role="option">Job Board</li>
      <li role="option">Sunlife Career Site</li></ul>`);
    const h = scan(newScanState()).handles[0];
    const ul = document.getElementById("menu")!;
    h.el.addEventListener("mousedown", () => (ul.hidden = false));
    ul.addEventListener("click", (e) => {
      h.el.textContent = (e.target as HTMLElement).textContent;
      ul.hidden = true;
    });
    const d = deps();
    d.harvested.set(h.id, ["Direct Contact", "Job Board", "Sunlife Career Site"]);
    expect(await fill(h, { type: "intended", answer: "LinkedIn" }, d)).toMatchObject({ outcome: "ok" });
    expect(h.el.textContent).toBe("Job Board");
  });

  it("closes a modal menu that hears Escape only from inside it (MUI)", async () => {
    setBody(`<div><label>Where would you like to work from?</label>
      <div role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="menu">Select</div></div>
      <ul id="menu" role="listbox" hidden><li role="option">Remote - Canada</li><li role="option">Vancouver</li></ul>`);
    const h = scan(newScanState()).handles[0];
    const ul = document.getElementById("menu")!;
    h.el.addEventListener("mousedown", () => (ul.hidden = false));
    ul.addEventListener("keydown", (e) => {
      if (e.key === "Escape") ul.hidden = true;
    });
    const c = await openDropdown(h);
    expect(c).toBe(ul);
    await closeDropdown(h, c);
    expect(ul.hidden).toBe(true);
  });

  it("presses no keys into the list a category opened instead of picking", async () => {
    const { h, ul } = select2(`<li role="option">Company Website</li><li role="option">University Co-op</li>`);
    let picked = "";
    let focused = -1;
    ul.addEventListener("click", (e) => {
      // A category opens its own list.
      if ((e.target as Element).textContent === "University Co-op")
        ul.innerHTML = `<li role="option">UBC Science Co-op</li><li role="option">WaterlooWorks</li>`;
    });
    h.el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") focused++;
      if (e.key === "Enter") picked = ul.querySelectorAll("li")[focused]?.textContent ?? "";
    });
    expect((await fillDropdown(h, ["University Co-op"])).outcome).toBe("failed");
    expect(picked).toBe("");
  });

  it("a list too long to harvest is searched from its popup search box", async () => {
    const { h, ul } = select2(`<li role="option">Aalto University</li><li role="option">Loading more results…</li>`);
    ul.insertAdjacentHTML("beforebegin", `<input type="search" aria-controls="res" hidden>`);
    const box = document.querySelector<HTMLInputElement>("input")!;
    h.el.addEventListener("mousedown", () => (box.hidden = false));
    h.el.addEventListener("click", () => box.focus());
    box.addEventListener("input", () => {
      ul.innerHTML = `<li role="option" class="loading-results">Searching…</li>`;
      const q = box.value;
      setTimeout(() => {
        if (box.value !== q) return;
        const hits = ["University of British Columbia", "University of Northern British Columbia"];
        ul.innerHTML = hits.map((t) => `<li role="option">${t}</li>`).join("");
      }, 1000);
    });
    expect(await searchOptions(h, "British Columbia")).toEqual([
      "University of British Columbia",
      "University of Northern British Columbia",
    ]);
    expect(ul.hidden).toBe(true);
  });
});

describe("native selects too long to scan", () => {
  it("a 300+ option select is filled from the AI's choice among the options containing the query (Lever)", async () => {
    const schools = Array.from({ length: 400 }, (_, i) => `<option>School ${i}</option>`).join("");
    setBody(`<label>School <select><option value="">Click Here</option>${schools}
      <option>University of British Columbia - UBC</option><option>University of Northern British Columbia - UNBC</option>
      </select></label>`);
    const h = scan(newScanState()).handles[0];
    expect(h.desc).toMatchObject({ kind: "select", optionsKnown: false });
    const offered: string[][] = [];
    const deps = {
      documents: [],
      getDocument: async () => null,
      choose: async (_: unknown, __: string, options: string[]) => (offered.push(options), [0]),
      checkedByUs: new Set<Element>(),
      harvested: new Map<string, string[]>(),
      signal: new AbortController().signal,
    };
    const op = { type: "intended", answer: "University of British Columbia", query: "British Columbia" } as const;
    expect(await fill(h, op, deps)).toMatchObject({ outcome: "ok" });
    expect(offered).toEqual([
      ["University of British Columbia - UBC", "University of Northern British Columbia - UNBC"],
    ]);
    expect((h.el as HTMLSelectElement).value).toBe("University of British Columbia - UBC");
  });
});

const deps = () => ({
  documents: [],
  getDocument: async () => null,
  choose: async () => null,
  checkedByUs: new Set<Element>(),
  harvested: new Map<string, string[]>(),
  signal: new AbortController().signal,
});

describe("fill engine", () => {
  it("takes a location list's catch-all when the place isn't on it (Signifyd)", async () => {
    setBody(`<label id="ql">Where are you currently located within the United Kingdom?</label>
      <div role="combobox" aria-labelledby="ql" aria-controls="lb" aria-expanded="false" tabindex="0">Select...</div>
      <div role="listbox" id="lb">${["England", "Scotland", "Wales", "Other"].map((o) => `<div role="option">${o}</div>`).join("")}</div>`);
    const box = document.querySelector("[role=combobox]")!;
    for (const o of document.querySelectorAll("[role=option]"))
      o.addEventListener("click", () => (box.textContent = o.textContent));
    const h = scan(newScanState()).handles[0];
    const op = { type: "intended", answer: "Langley, British Columbia, Canada", query: "Langley" } as const;
    expect(await fill(h, op, deps())).toMatchObject({ outcome: "ok" });
    expect(box.textContent).toBe("Other");
  });

  it("clicks Yes/No toggle pills even though they default to type=submit (Ashby)", async () => {
    setBody(`<div><label>Willing to relocate?</label><div>
      <button aria-pressed="false">Yes</button><button aria-pressed="false">No</button></div></div>`);
    for (const b of document.querySelectorAll("button"))
      b.addEventListener("click", () => b.setAttribute("aria-pressed", "true"));
    const h = scan(newScanState()).handles[0];
    expect(await fill(h, { type: "options", texts: ["Yes"] }, deps())).toMatchObject({ outcome: "ok" });
    expect(document.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("picks a Workable radio, whose role=radio wrapper holds the state", async () => {
    const opt = (v: string) =>
      `<div role="radio" aria-checked="false"><label><input type="radio" name="q" aria-hidden="true"><span>${v}</span></label></div>`;
    setBody(
      `<span id="ql">Eligible?</span><fieldset role="radiogroup" aria-labelledby="ql">${opt("YES")}${opt("NO")}</fieldset>`,
    );
    // Workable keeps its hidden radio unchecked and marks the wrapper instead.
    for (const input of document.querySelectorAll("input"))
      input.addEventListener("click", (e) => {
        e.preventDefault();
        input.closest("[role=radio]")!.setAttribute("aria-checked", "true");
      });
    const h = scan(newScanState()).handles[0];
    expect(await fill(h, { type: "options", texts: ["YES"] }, deps())).toMatchObject({ outcome: "ok" });
    expect(readValue(h)).toBe("YES");
  });

  it("a refused click fails that field instead of rejecting the whole fill", async () => {
    setBody(`<div role="radiogroup" aria-label="Relocate?">
      <a href="/next"><span role="radio" aria-checked="false">Yes</span></a><span role="radio" aria-checked="false">No</span></div>`);
    const h = scan(newScanState()).handles[0];
    await expect(fill(h, { type: "options", texts: ["Yes"] }, deps())).resolves.toMatchObject({ outcome: "failed" });
  });
});

describe("read-only input dropdowns (Workable)", () => {
  it("verifies the pick from the trigger input's own value", async () => {
    setBody(`<div><label><span id="l">Notice period</span>
      <input role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="lb" aria-labelledby="l" readonly placeholder="Select an option…"></label>
      <ul id="lb" role="listbox" hidden></ul></div>`);
    const input = document.querySelector("input")!;
    const lb = document.getElementById("lb")!;
    input.addEventListener("mousedown", () => {
      input.setAttribute("aria-expanded", "true");
      lb.hidden = false;
      lb.innerHTML = `<li role="option">Available immediately</li><li role="option">1 week</li>`;
      for (const o of lb.children)
        o.addEventListener("click", () => {
          input.value = o.textContent!;
          lb.hidden = true;
        });
    });
    const h = scan(newScanState()).handles[0];
    expect(h.desc.kind).toBe("dropdown");
    expect(await fillDropdown(h, ["Available immediately"])).toMatchObject({ outcome: "ok" });
  });
});

describe("slow typeahead suggestions", () => {
  it("waits past the usual timeout while the field shows a loading spinner (Lever)", async () => {
    setBody(`<div><label for="loc">Current location</label><input id="loc" role="combobox">
      <div class="loading" hidden>Loading</div><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    const spinner = document.querySelector<HTMLElement>(".loading")!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    input.addEventListener("input", () => {
      spinner.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        spinner.hidden = true;
        document.getElementById("res")!.innerHTML = `<div role="option">Langley, BC, CAN</div>`;
      }, 2600);
    });
    document.getElementById("res")!.addEventListener("click", (e) => {
      input.value = (e.target as HTMLElement).textContent!;
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, BC, CAN", async () => 0);
    expect(r).toMatchObject({ outcome: "ok", shown: "Langley, BC, CAN" });
  }, 10_000);
});

describe("text fills", () => {
  it("accepts a date the widget reformats (SmartRecruiters)", async () => {
    setBody(`<label>To <input id="to"></label>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      const m = /^(\d{4})-(\d{2})$/.exec(input.value);
      if (m) input.value = `${m[2]}/${m[1]}`;
    });
    const h = scan(newScanState()).handles[0];
    expect(await fill(h, { type: "text", value: "2026-08" }, deps())).toMatchObject({
      outcome: "ok",
      shown: "08/2026",
    });
  });

  it("gives a date in numbers to a widget that misreads a month's name (SmartRecruiters)", async () => {
    setBody(`<label>From <input id="from" placeholder="Pick a date"></label>`);
    const input = document.querySelector("input")!;
    // Its month-year picker reads "1/2026" or "2026-01" as January 2026, and any month's name as August 2027.
    const read = () => {
      const v = input.value;
      if (!v) return;
      const num = /^(\d{1,2})\/(\d{4})$/.exec(v);
      const iso = /^(\d{4})-(\d{2})$/.exec(v);
      input.value = num ? `${num[1].padStart(2, "0")}/${num[2]}` : iso ? `${iso[2]}/${iso[1]}` : "08/2027";
    };
    input.addEventListener("change", read);
    input.addEventListener("blur", read);
    const h = scan(newScanState()).handles[0];
    expect(await fill(h, { type: "text", value: "January 2026" }, deps())).toMatchObject({
      outcome: "ok",
      shown: "01/2026",
    });
  });
});

describe("dates split into Month / Day / Year boxes (Workday)", () => {
  const box = (part: string) =>
    `<div><input type="text" role="spinbutton" aria-label="${part}" inputmode="numeric" value=""></div>`;
  it("reads them as one date question and types each part into its box", async () => {
    setBody(`<div><label id="g-label">What is your expected graduation date?</label>
      <div role="group" aria-labelledby="g-label">${box("Month")}${box("Year")}</div></div>
      <div><label id="s-label">Earliest start date</label>
      <div role="group" aria-labelledby="s-label">${box("Month")}${box("Day")}${box("Year")}</div></div>`);
    const [grad, start] = scan(newScanState()).handles;
    expect(scan(newScanState()).handles).toHaveLength(2);
    expect(grad.desc).toMatchObject({
      kind: "date",
      label: "What is your expected graduation date?",
      placeholder: "MM/YYYY",
    });
    expect(start.desc.placeholder).toBe("MM/DD/YYYY");
    expect(await fill(grad, { type: "text", value: "May 2028" }, deps())).toMatchObject({
      outcome: "ok",
      shown: "05/2028",
    });
    expect(await fill(start, { type: "text", value: "2027-01-01" }, deps())).toMatchObject({
      outcome: "ok",
      shown: "01/01/2027",
    });
    expect(readValue(start)).toBe("01/01/2027");
  });

  it("types only the year into a lone Year box", async () => {
    setBody(`<div><label id="f-label">From</label><div role="group" aria-labelledby="f-label">${box("Year")}</div></div>
      <div><label id="t-label">To (Actual or Expected)</label><div role="group" aria-labelledby="t-label">${box("Year")}</div></div>`);
    const [, to] = scan(newScanState()).handles;
    expect(to.desc).toMatchObject({ kind: "date", label: "To (Actual or Expected)", placeholder: "YYYY" });
    expect(await fill(to, { type: "text", value: "May 2028" }, deps())).toMatchObject({ outcome: "ok", shown: "2028" });
    expect(await fill(to, { type: "text", value: "2029" }, deps())).toMatchObject({ outcome: "ok", shown: "2029" });
  });
});

describe("slotted options (SmartRecruiters' spl-select)", () => {
  it("reads options slotted into a listbox from the light DOM, their role in their own shadow root", () => {
    setBody(`<x-select><x-option>May 2028</x-option><x-option>May 2029</x-option></x-select>`);
    const host = document.querySelector("x-select")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<div role="listbox"><slot></slot></div>`;
    for (const o of document.querySelectorAll("x-option"))
      o.attachShadow({ mode: "open" }).innerHTML = `<div role="option"><slot></slot></div>`;
    const lb = host.shadowRoot!.querySelector<HTMLElement>("[role=listbox]")!;
    expect(optionElements(lb).map((o) => o.textContent)).toEqual(["May 2028", "May 2029"]);
  });
});

describe("select2 3.x AJAX search over a hidden input (legacy Greenhouse's school)", () => {
  it("types into its search box once it takes focus, and picks from the results for the whole query", async () => {
    setBody(`<div class="field"><label for="school">School *</label><input type="hidden" id="school" aria-required="true">
      <div class="select2-container" id="s2id_school"><a class="select2-choice"><span class="select2-chosen"
        id="select2-chosen-1">Select a School</span></a><label for="s2id_autogen1" class="select2-offscreen">School</label>
        <input class="select2-focusser select2-offscreen" type="text" aria-labelledby="select2-chosen-1"
          id="s2id_autogen1"></div></div>`);
    const hidden = document.getElementById("school") as HTMLInputElement;
    const focusser = document.getElementById("s2id_autogen1") as HTMLInputElement;
    const chosen = document.getElementById("select2-chosen-1")!;
    const schools = ["University of Alberta", "University of British Columbia", "University of Calgary"];
    let drop: HTMLElement | null = null;
    // The first key opens the list, moves to its search box and is typed there; results come after a short delay,
    // the first ones for that one key.
    focusser.addEventListener("input", () => {
      if (drop) return;
      drop = document.createElement("div");
      drop.innerHTML = `<input class="select2-input" type="text"><ul class="select2-results" role="listbox"></ul>`;
      document.body.append(drop);
      const search = drop.querySelector("input")!;
      const ul = drop.querySelector("ul")!;
      const show = () => {
        const hits = schools.filter((t) => t.toLowerCase().includes(search.value.toLowerCase()));
        ul.innerHTML = hits
          .map(
            (t) =>
              `<li class="select2-result select2-result-selectable"><div class="select2-result-label" role="option">${t}</div></li>`,
          )
          .join("");
        ul.querySelectorAll("li").forEach((li) =>
          li.addEventListener("mouseup", () => {
            hidden.value = li.textContent!;
            chosen.textContent = li.textContent!;
            drop?.remove();
          }),
        );
      };
      search.value = focusser.value;
      focusser.value = "";
      search.focus();
      ul.innerHTML = `<li class="select2-no-results">Please enter 1 or more character</li>`;
      setTimeout(show, 10);
      let t: ReturnType<typeof setTimeout>;
      search.addEventListener("input", () => (clearTimeout(t), (t = setTimeout(show, 300))));
    });
    const h = scan(newScanState()).handles[0];
    expect(h.desc).toMatchObject({ kind: "typeahead", label: "School", required: true });
    const op = {
      type: "intended",
      answer: "University of British Columbia",
      query: "University of British Columbia",
    } as const;
    expect(await fill(h, op, deps())).toMatchObject({ outcome: "ok", shown: "University of British Columbia" });
    expect(hidden.value).toBe("University of British Columbia");
  });
});

describe("clicks", () => {
  it("land inside a custom element's shadow root, where its listener is (SmartRecruiters)", () => {
    setBody(`<x-option></x-option>`);
    const host = document.querySelector<HTMLElement>("x-option")!;
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `<style></style><div role="option">Langley</div>`;
    let clicked = 0;
    sr.querySelector("div")!.addEventListener("click", () => clicked++);
    realClick(host);
    expect(clicked).toBe(1);
  });
});

describe("listbox kept inside the widget (Carvana)", () => {
  it("reads a closed list as no value", () => {
    setBody(`<div data-testid="Select"><button type="button" aria-haspopup="listbox"><div>Select answer</div>
      <span id="sel"></span></button><div role="listbox" style="display:none"><div role="option">Yes</div>
      <div role="option">No</div></div></div>`);
    const el = document.querySelector<HTMLElement>("[data-testid=Select]")!;
    const h = { el, desc: { kind: "dropdown" } } as unknown as FieldHandle;
    expect(dropdownText(h)).toBe("Select answer");
    document.getElementById("sel")!.textContent = "Yes";
    expect(dropdownText(h)).toBe("Select answer Yes");
  });
});

describe("typeahead verification", () => {
  it("does not take the typed query left in the box for the pick", async () => {
    setBody(`<div><label for="c">City</label><input id="c" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      document.getElementById("res")!.innerHTML = `<div role="option">Langley, BC, Canada</div>`;
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, BC, Canada", async () => 0);
    expect(r.outcome).toBe("mismatch");
  });

  it("picks from a suggestion grid that keeps only the pick's leading part (Oracle)", async () => {
    setBody(`<div><label for="c">City</label><input id="c" role="combobox" aria-controls="g" aria-expanded="false">
      <div role="grid" id="g"></div></div><div><label for="r">Province</label><input id="r" value="BC"></div>`);
    const input = document.querySelector<HTMLInputElement>("#c")!;
    const grid = document.getElementById("g")!;
    input.addEventListener("input", () => {
      input.setAttribute("aria-expanded", "true");
      grid.innerHTML = `<div role="row"><div role="gridcell">Langley Twp, BC</div></div>
        <div role="row"><div role="gridcell">Langley, BC</div></div>`;
    });
    grid.addEventListener("click", () => {
      input.value = "Langley";
      input.setAttribute("aria-expanded", "false");
      grid.replaceChildren();
    });
    const [h, region] = scan(newScanState()).handles;
    const r = await fillTypeahead(h, "Langley", "Langley, BC", async () => null);
    expect(r).toMatchObject({ outcome: "ok", shown: "Langley, BC" });
    // The province the city set, as a code: kept, not typed over.
    expect(await fillTypeahead(region, "British Columbia", "British Columbia", async () => null)).toMatchObject({
      outcome: "ok",
      shown: "BC",
    });
    expect(
      ["QC", "ON", "NL", "CA"].map((c, i) =>
        abbreviates(c, ["Quebec", "Ontario", "Newfoundland and Labrador", "California"][i]),
      ),
    ).toEqual([true, true, true, true]);
    expect([
      abbreviates("BC", "Alberta"),
      abbreviates("bc", "British Columbia"),
      abbreviates("Langley", "Langley"),
    ]).toEqual([false, false, false]);
  });

  it("searches a City field for the city only, never the country", async () => {
    setBody(`<div><label for="c">City</label><input id="c" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      document.getElementById("res")!.innerHTML = /^canada/i.test(input.value)
        ? `<div role="option">Canada Creek, NS</div>`
        : "";
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, British Columbia, Canada", async () => 0);
    expect(input.value).not.toMatch(/canada/i);
    expect(r.shown ?? "").not.toMatch(/canada/i);
  });

  it("fails instead of marking a cleared selection for review", async () => {
    setBody(`<div><label for="c">City</label><input id="c" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      document.getElementById("res")!.innerHTML = `<div role="option">Langley, BC, Canada</div>`;
    });
    document.getElementById("res")!.addEventListener("click", () => {
      // Some async widgets clear their search box before they commit the selected value.
      input.value = "";
      document.getElementById("res")!.replaceChildren();
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, BC, Canada", async () => 0);
    expect(r).toMatchObject({ outcome: "failed" });
  });

  it("reads the pick shown beside an emptied search box (react-select without classes, Epic Games)", async () => {
    setBody(`<div><label for="c">Country</label><div><div><div class="css-1-placeholder">Select</div><div>
      <input id="c" aria-autocomplete="list"></div></div><div id="menu"></div></div></div>`);
    const input = document.querySelector("input")!;
    input.addEventListener("input", () => {
      document.getElementById("menu")!.innerHTML =
        `<div id="react-select-2-option-38"><svg><title>Canada</title></svg><span>Canada</span><span>+1</span></div>`;
      document.getElementById("react-select-2-option-38")!.addEventListener("click", () => {
        input.value = "";
        document.getElementById("menu")!.innerHTML = "";
        document
          .querySelector(".css-1-placeholder")!
          .replaceWith(Object.assign(document.createElement("div"), { textContent: "Canada+1" }));
      });
    });
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Canada", "Canada", async () => null);
    expect(r).toMatchObject({ outcome: "ok", shown: "Canada+1" });
  });
});

describe("how-heard typeaheads", () => {
  it('pick "Other" when the profile\'s source lists nothing (1Password)', async () => {
    setBody(`<div><label for="c">What brought you to this job posting</label><input id="c" role="combobox">
      <div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    let picked = "";
    input.addEventListener("input", () => {
      const hits = ["LinkedIn Jobs", "Other", "Otta"].filter((o) =>
        o.toLowerCase().startsWith(input.value.toLowerCase()),
      );
      document.getElementById("res")!.innerHTML = hits.map((o) => `<div role="option">${o}</div>`).join("");
      for (const o of document.querySelectorAll("[role=option]"))
        o.addEventListener("click", () => (input.value = picked = o.textContent!));
    });
    // Text that picks nothing is cleared.
    input.addEventListener("blur", () => (input.value = picked));
    const h = scan(newScanState()).handles[0];
    const r = await fill(h, { type: "intended", answer: "Company website" }, deps());
    expect(r).toMatchObject({ outcome: "ok", shown: "Other" });
  });
});

describe("slotted dropdown values", () => {
  it("reads a shadow-root trigger's value through its slot (SmartRecruiters' phone country)", () => {
    setBody(`<x-select><span slot="p">+1</span></x-select>`);
    const host = document.querySelector("x-select")!;
    host.attachShadow({ mode: "open" }).innerHTML =
      `<button role="combobox" aria-haspopup="listbox" aria-label="Country code"><!--lit--><slot name="p"></slot></button>`;
    const [h] = scan(newScanState()).handles;
    expect(h.desc).toMatchObject({ kind: "dropdown", label: "Country code", currentValue: "+1" });
  });
});

describe("file uploads", () => {
  const meta = {
    id: "cv",
    label: "CV",
    kind: "resume",
    fileName: "Ada.pdf",
    mimeType: "application/pdf",
    size: 1,
    isPrimaryResume: true,
    uploadedAt: 0,
  } as const;

  it("count as done when the widget lists the file inside its shadow root (SmartRecruiters)", async () => {
    setBody(`<div><label for="r">Resume</label><x-drop><input type="file" id="r"></x-drop></div>`);
    const drop = document.querySelector("x-drop")!;
    const list = drop.attachShadow({ mode: "open" });
    list.innerHTML = `<style>.ok::after{content:"uploaded"}</style><slot></slot>`;
    const input = document.querySelector<HTMLInputElement>("input")!;
    // The widget takes the file, empties its input and shows the name in its shadow root.
    input.addEventListener("change", () => {
      const name = input.files![0].name;
      input.value = "";
      list.append(Object.assign(document.createElement("span"), { textContent: name }));
    });
    const h = scan(newScanState()).handles[0];
    expect(await fillFile(h, meta, btoa("%PDF"))).toMatchObject({ outcome: "ok" });
  });

  it("set a dropzone's input kept on <body> without opening the file picker (Dropzone.js, Disney)", async () => {
    setBody(`<div class="upload-area"><button type="button">Upload Resume</button><span>PDF or DOCX</span></div>`);
    const input = Object.assign(document.createElement("input"), { type: "file" });
    document.body.append(input);
    let picker = false;
    input.addEventListener("click", (e) => (picker = !e.defaultPrevented));
    document.querySelector("button")!.addEventListener("click", () => input.click());
    input.addEventListener("change", () => (document.querySelector("span")!.textContent = input.files![0].name));
    const st = newScanState();
    const [h] = findDropzones(scan(st).handles, st);
    expect(await fillFile(h, meta, btoa("%PDF"))).toMatchObject({ outcome: "ok" });
    expect(picker).toBe(false);
  });

  it("attaches a legacy Greenhouse résumé through its Attach box, whose file input sits in a separate upload form", async () => {
    setBody(`<form id="application_form"><div class="field" id="resume_fieldset" aria-required="true">
      <label id="resume_label">Resume/CV <span class="asterisk">*</span></label><div class="attach-or-paste">
      <div class="link-container"><button type="button" data-source="attach">Attach</button> or <a href="#">enter manually</a></div>
      <span class="filename"></span></div></div></form>
      <form id="s3_upload_for_resume" style="display:none"><input type="file" name="file"></form>`);
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    document.querySelector("button")!.addEventListener("click", () => input.click());
    input.addEventListener("change", () => (document.querySelector(".filename")!.textContent = input.files![0].name));
    const st = newScanState();
    const [h] = findDropzones(scan(st).handles, st);
    expect(h.desc).toMatchObject({ kind: "file", required: true });
    expect(h.desc.label).toMatch(/^Resume\/CV/);
    expect(await fillFile(h, meta, btoa("%PDF"))).toMatchObject({ outcome: "ok" });
  });
});

describe("place typeaheads", () => {
  it("search again by the place name when the full place finds nothing (SmartRecruiters)", async () => {
    setBody(`<div><label for="o">Office location</label><input id="o" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    const res = document.getElementById("res")!;
    input.addEventListener("input", () => {
      res.innerHTML =
        input.value === "Vancouver"
          ? `<div role="option">Vancouver, British Columbia, Canada</div>`
          : `<div role="option">Cannot find your city? Click here to fill in manually</div>`;
    });
    res.addEventListener("click", (e) => (input.value = (e.target as HTMLElement).textContent!));
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Vancouver, BC", "Vancouver, BC", async () => 0);
    expect(r).toMatchObject({ outcome: "ok", shown: "Vancouver, British Columbia, Canada" });
    expect(input.value).toBe("Vancouver, British Columbia, Canada");
  });

  it("pick a place from a plain list beside the box, which keeps its coordinates (legacy Greenhouse)", async () => {
    setBody(`<div class="field"><label for="loc">Location (City) *</label>
      <input id="loc" name="job_application[location]"><input type="hidden" name="job_application[latitude]">
      <ul class="pelias-results" style="display:none"></ul></div>`);
    const input = document.querySelector<HTMLInputElement>("#loc")!;
    const lat = document.querySelector<HTMLInputElement>("[type=hidden]")!;
    const ul = document.querySelector("ul")!;
    input.addEventListener("input", () => {
      ul.innerHTML =
        input.value.length > 2 ? "<li>Langley, British Columbia, Canada</li><li>Langley, Washington</li>" : "";
      ul.style.display = ul.innerHTML ? "" : "none";
      ul.querySelectorAll("li").forEach((li) =>
        li.addEventListener(
          "mousedown",
          () => ((input.value = li.textContent!), (lat.value = "49.1"), (ul.style.display = "none")),
        ),
      );
    });
    const h = scan(newScanState()).handles[0];
    expect(h.desc.kind).toBe("typeahead");
    const r = await fillTypeahead(h, "Langley", "Langley, British Columbia, Canada", async () => null);
    expect(r).toMatchObject({ outcome: "ok", shown: "Langley, British Columbia, Canada" });
    expect(lat.value).toBe("49.1");
  });

  it("search by the country when the picker lists only countries (Airwallex)", async () => {
    setBody(`<div><label for="o">Location</label><input id="o" role="combobox"><div id="res"></div></div>`);
    const input = document.querySelector("input")!;
    const res = document.getElementById("res")!;
    input.addEventListener("input", () => {
      res.innerHTML = /^canada$/i.test(input.value) ? `<div role="option">Canada</div>` : "";
    });
    res.addEventListener("click", (e) => (input.value = (e.target as HTMLElement).textContent!));
    const h = scan(newScanState()).handles[0];
    const r = await fillTypeahead(h, "Langley", "Langley, British Columbia, Canada", async () => 0);
    expect(r).toMatchObject({ outcome: "ok", shown: "Canada" });
  }, 15000);
});

describe("typeText", () => {
  it("follows focus onward to a popup's box, never to another field", async () => {
    const { typeText } = await import("../../src/content/fill/events");
    setBody(`<input id="prev"><input id="cur"><input id="next"><input id="popup" style="display:none">`);
    const [prev, cur, next, popup] = ["prev", "cur", "next", "popup"].map(
      (id) => document.getElementById(id) as HTMLInputElement,
    );
    cur.focus();
    // A page handing focus back to an earlier field mid-word (Eightfold's selects in the hidden frame).
    cur.addEventListener("input", () => prev.focus(), { once: true });
    await typeText(cur, "Asian", 0);
    expect([prev.value, cur.value]).toEqual(["", "Asian"]);
    cur.value = "";
    cur.focus();
    // Or on to the next field (Eightfold's John Deere form).
    cur.addEventListener("input", () => next.focus(), { once: true });
    await typeText(cur, "Not a veteran", 0);
    expect([cur.value, next.value]).toEqual(["Not a veteran", ""]);
    cur.value = "";
    cur.focus();
    // select2 3.x moves focus, with the first key, to its list's search box.
    cur.addEventListener(
      "input",
      () => {
        popup.style.display = "";
        popup.focus();
      },
      { once: true },
    );
    await typeText(cur, "UBC", 0);
    expect([cur.value, popup.value]).toEqual(["U", "BC"]);
  });
});

describe("showsWord", () => {
  it("reads a short answer as picked only when the box shows it as a word", async () => {
    const { showsWord } = await import("../../src/content/fill/dropdown");
    expect(showsWord("No", "No")).toBe(true);
    expect(showsWord("No ×", "No")).toBe(true);
    expect(showsWord("NoRemove", "No")).toBe(true);
    expect(showsWord("Not applicable", "No")).toBe(false);
    expect(showsWord("None", "No")).toBe(false);
    expect(showsWord("Yes, I am", "Yes")).toBe(true);
    expect(showsWord("Canada (+1)", "+1")).toBe(true);
  });
});

describe("fillCheckboxGroup exact", () => {
  it("unticks boxes the page ticked only when the answer is the whole set", async () => {
    const { fillCheckboxGroup } = await import("../../src/content/fill/native");
    setBody(`<fieldset><legend>Contact methods</legend>
      <label><input type="checkbox" name="m" value="e"> Email</label>
      <label><input type="checkbox" name="m" value="s" checked> SMS</label></fieldset>`);
    const h = scan(newScanState()).handles[0];
    await fillCheckboxGroup(h, ["Email"], new Set());
    expect((h.members as HTMLInputElement[]).map((m) => m.checked)).toEqual([true, true]);
    await fillCheckboxGroup(h, ["Email"], new Set(), true);
    expect((h.members as HTMLInputElement[]).map((m) => m.checked)).toEqual([true, false]);
  });
});

describe("ARIA menu selects", () => {
  it("picks from a button's role=menu items (BambooHR's fab-Select), once adopted by the review", async () => {
    const { fillDropdown } = await import("../../src/content/fill/dropdown");
    setBody(`<label for="sel">Province *</label>
      <div class="fab-Select"><button type="button" aria-haspopup="true" aria-expanded="false" aria-label="Province –Select–"><span>–Select–</span></button>
      <select id="sel" aria-hidden="true" hidden><option value=""></option><option>Alberta</option><option>British Columbia</option></select></div>
      <div role="menu" id="menu" hidden></div>`);
    const b = document.querySelector("button")!;
    const menu = document.getElementById("menu")!;
    b.addEventListener("click", () => {
      b.setAttribute("aria-expanded", "true");
      menu.hidden = false;
      menu.innerHTML = `<div role="menuitem">Alberta</div><div role="menuitem">British Columbia</div>`;
      for (const o of menu.children)
        o.addEventListener("click", () => {
          b.querySelector("span")!.textContent = o.textContent;
          menu.hidden = true;
          b.setAttribute("aria-expanded", "false");
        });
    });
    const state = newScanState();
    state.adopted.set(b, { kind: "dropdown", label: "Province", required: true });
    const h = scan(state).handles.find((x) => x.el === b)!;
    expect(h.desc.label).toBe("Province");
    expect(await fillDropdown(h, ["British Columbia"])).toMatchObject({ outcome: "ok" });
    expect(b.textContent).toContain("British Columbia");
  });
});
