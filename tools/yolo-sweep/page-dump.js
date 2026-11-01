// Evaluated in the job page (CDP Runtime.evaluate): every visible control with its label and current value,
// plus the page's visible error messages. Returns JSON text; run.mjs turns it into the compact report.
(() => {
  const all = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.matches("input,select,textarea,[role=combobox],[contenteditable=true],button[aria-haspopup=listbox]"))
        all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return (r.width > 0 || r.height > 0) && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const clean = (s, n) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, n);
  const CONTROLS = "input:not([type=hidden]),select,textarea,button[aria-haspopup=listbox]";
  // The question beside a dropdown button (Workday's aria-label is just "Select One Required").
  const fieldLabel = (el) => {
    let n = el.parentElement;
    for (let i = 0; i < 5 && n && [...n.querySelectorAll(CONTROLS)].filter(vis).length < 2; i++, n = n.parentElement) {
      const l = n.querySelector("label,legend");
      if (l && !l.contains(el) && l.innerText.trim()) return l.innerText;
    }
    return "";
  };
  const lab = (el) => {
    if (el.labels?.[0]) return el.labels[0].innerText;
    if (el.tagName === "BUTTON" && fieldLabel(el)) return fieldLabel(el);
    const lb = el.getAttribute("aria-labelledby");
    if (lb)
      return lb
        .split(" ")
        .map((i) => document.getElementById(i)?.innerText ?? "")
        .join(" ");
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    let n = el.parentElement;
    for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
      const t = (n.innerText || "").trim();
      if (t.length > 2 && t.length < 300) return t;
    }
    return el.name || el.id || el.placeholder || "";
  };
  const rows = [];
  const seen = new Set();
  for (const el of all) {
    if (el.type === "hidden" || (!vis(el) && el.type !== "file" && el.type !== "radio" && el.type !== "checkbox"))
      continue;
    const req =
      el.required ||
      el.getAttribute("aria-required") === "true" ||
      /\bRequired$/.test(el.getAttribute("aria-label") ?? "");
    let v;
    let label = lab(el);
    if (el.type === "radio") {
      if (seen.has(el.name)) continue;
      seen.add(el.name);
      const group = el.closest("fieldset,[role=radiogroup]");
      if (group) label = group.querySelector("legend")?.innerText ?? clean(group.innerText, 160);
      const c = [...document.getElementsByName(el.name)].find((r) => r.checked);
      v = c ? "(•) " + lab(c) : "";
    } else if (el.type === "checkbox") v = el.checked ? "[x]" : "[ ]";
    else if (el.type === "file") v = el.files?.length ? "file:" + el.files[0].name : "";
    else if (el.tagName === "SELECT") v = el.selectedIndex > 0 || el.value ? (el.selectedOptions[0]?.text ?? "") : "";
    else if (el.tagName === "BUTTON") v = el.innerText;
    else v = el.type === "password" ? (el.value ? "***" : "") : (el.value ?? el.innerText ?? "");
    if (!v && el.tagName === "INPUT") {
      // react-select / Workday multiselect values live beside the input.
      let n = el.parentElement;
      // Stop at the first ancestor holding another control: its values are another field's.
      for (
        let i = 0;
        i < 5 && n && n.querySelectorAll("input:not([type=hidden]),select,textarea").length < 2;
        i++, n = n.parentElement
      ) {
        const s = n.querySelectorAll(
          "[class*=single-value],[class*=singleValue],[class*=multi-value__label],[data-automation-id=selectedItem]",
        );
        if (s.length) {
          v = "{" + [...s].map((x) => x.innerText).join(", ") + "}";
          break;
        }
      }
    }
    v = clean(v, 100);
    // Menu buttons with no question (language, settings) and honeypots aren't fields.
    if (el.tagName === "BUTTON" && !req && clean(label, 100) === v) continue;
    if (/robots only|do not enter if you'?re human/i.test(label)) continue;
    const empty = !v || /^(select|choose|--|please select|select one|none selected|\{\})/i.test(v);
    rows.push({
      req,
      empty,
      kind: el.tagName.toLowerCase() + (el.type && el.tagName === "INPUT" ? ":" + el.type : ""),
      label: clean(label, 110),
      value: v,
    });
  }
  // Upload widgets that swap their file input for the file's name once a file is attached (Greenhouse, Workday).
  for (const g of document.querySelectorAll(
    "[class*=file-upload],[class*=fileUpload],[class*=dropzone],[data-automation-id*=attachments]",
  )) {
    if (
      !vis(g) ||
      g.parentElement?.closest(
        "[class*=file-upload],[class*=fileUpload],[class*=dropzone],[data-automation-id*=attachments]",
      )
    )
      continue;
    const label = clean(g.querySelector("[class*=label],label,legend")?.innerText ?? lab(g), 110);
    const v = clean(g.innerText.replace(label, ""), 100);
    rows.push({
      req: g.getAttribute("aria-required") === "true" || /\*/.test(label),
      empty: !/\.(pdf|docx?|txt|rtf)\b/i.test(v),
      kind: "upload",
      label,
      value: v,
    });
  }
  const errors = [
    ...new Set(
      [
        ...document.querySelectorAll(
          "[role=alert],[aria-live=assertive],[class*=error],[class*=Error],[data-automation-id*=error]",
        ),
      ]
        .filter((e) => vis(e) && e.children.length < 6)
        .map((e) => clean(e.innerText, 160))
        .filter((t) => t.length > 3 && !/success|uploaded/i.test(t)),
    ),
  ].slice(0, 8);
  const buttons = [...document.querySelectorAll("button,[role=button],input[type=submit]")]
    .filter(vis)
    .map((b) => clean(b.innerText || b.value, 25))
    .filter(Boolean);
  const step = /current step \d+ of \d+/i.exec(clean(document.body?.innerText, 1e5))?.[0] ?? "";
  return JSON.stringify({
    title: document.title,
    url: location.href,
    step,
    heading: clean(document.querySelector("h1,h2")?.innerText, 80),
    errors,
    buttons: [...new Set(buttons)].slice(0, 15),
    rows,
    text: clean(document.body?.innerText, 1500),
  });
})();
