// LaTeX résumé tailoring: the source split into what the AI may touch, and its edits checked and applied.
// The preamble is never sent or changed, so the template's packages and layout stay exactly as they were; the AI
// sees the body as numbered units (sections, entries, bullets, other text lines) and answers with edit operations.

export interface Unit {
  id: string;
  kind: "section" | "entry" | "bullet" | "line";
  /** Body lines [start, end). */
  start: number;
  end: number;
}

export interface Group {
  id: string;
  /** Unit ids in source order; each spans from its start to the next one's (the last: to its own end). */
  items: string[];
}

export interface ParsedTex {
  preamble: string;
  lines: string[];
  tail: string;
  units: Map<string, Unit>;
  groups: Group[];
  /** Control sequences the source uses: the only ones an edit may use. */
  commands: Set<string>;
}

export interface TailorOps {
  edits?: { id: string; text: string }[];
  add?: { after: string; text: string }[];
  remove?: string[];
  order?: { group: string; items: string[] }[];
}

/** Commands an edit may never contain: they read or write files, define macros or change how TeX reads. */
const FORBIDDEN =
  /\\(usepackage|RequirePackage|documentclass|input|include|includeonly|def|edef|gdef|xdef|let|newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|write|immediate|openin|openout|read|catcode|directlua|special|pdfliteral|csname|expandafter|end|begin|section|subsection)\b/;

/** The line without its comment (an unescaped %). */
export const code = (line: string) => line.replace(/(^|[^\\])(\\\\)*%.*$/, (m) => m.replace(/%.*$/, ""));

const lead = (s: string) => /^\s*(\\[a-zA-Z@]+\*?)/.exec(s)?.[1] ?? "";

/** Brace depth change over the line, ignoring escaped braces; NaN when it goes below zero. */
function braceDelta(s: string): number {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "{") d++;
    else if (s[i] === "}" && --d < 0) return NaN;
  }
  return d;
}

/** Top-level brace groups: \resumeItem{x} → 1, \textbf{Languages}{: Java} → 2. */
function groupCount(s: string): number {
  let d = 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "{" && d++ === 0) n++;
    else if (s[i] === "}") d--;
  }
  return n;
}

const SECTION = /^\s*\\(section|cvsection)\*?\s*[[{]/;
const WRAP_OPEN = /^\s*\\(begin\s*\{|[a-zA-Z@]*(Start|Begin)\b)/;
const WRAP_CLOSE = /^\s*\\(end\s*\{|[a-zA-Z@]*End\b)/;
/** A bullet: \item, or a one-argument item macro (\resumeItem, \cvitem, \cvlistitem, \resumeSubItem). */
/** Entry headings of the common templates (Jake's, moderncv), recognized even when a section has only one. */
const ENTRY_CMDS = /^\\(resumeSubheading|resumeSubSubheading|resumeProjectHeading|cventry|cvevent|resumeEntry)$/;
const BULLET = /^\s*\\(item\b|[a-zA-Z@]*[iI]tem[a-zA-Z@]*\*?\s*[[{])/;

export function parseTex(src: string): ParsedTex | null {
  const all = src.replace(/\r\n?/g, "\n").split("\n");
  const begin = all.findIndex((l) => /\\begin\s*\{document\}/.test(code(l)));
  const endAt = all.findIndex((l, i) => i > begin && /\\end\s*\{document\}/.test(code(l)));
  if (begin < 0 || endAt < 0) return null;
  const lines = all.slice(begin + 1, endAt);
  const units = new Map<string, Unit>();
  const groups: Group[] = [];
  const commands = new Set([...src.matchAll(/\\([a-zA-Z@]+)/g)].map((m) => m[1]));
  const codes = lines.map(code);

  /**
   * A unit starting at `i` runs on while its braces are open, while the next lines hold its arguments
   * ("{Company}{City}" under \resumeSubheading), or while an \item's text wraps.
   */
  const unitEnd = (i: number, limit: number) => {
    let depth = braceDelta(codes[i]) || 0;
    let j = i + 1;
    const isItem = /^\s*\\item\b/.test(codes[i]);
    while (j < limit) {
      const c = codes[j];
      if (depth > 0) depth += braceDelta(c) || 0;
      else if (/^\s*[{[]/.test(c)) depth += braceDelta(c) || 0;
      else if (!(isItem && c.trim() && !/^\s*[\\{}%]/.test(c))) break;
      j++;
    }
    return j;
  };

  // Entry commands an earlier section repeated mark entries in later ones too.
  const starters = new Set<string>();
  const sectionStarts = codes.flatMap((c, i) => (SECTION.test(c) ? [i] : []));
  const sectionIds: string[] = [];
  sectionStarts.forEach((s, si) => {
    const sEnd = sectionStarts[si + 1] ?? lines.length;
    const sid = `S${si + 1}`;
    sectionIds.push(sid);
    units.set(sid, { id: sid, kind: "section", start: s, end: sEnd });

    // Entries: spans starting with the line-leading command that repeats in this section (not a bullet or wrapper).
    const counts = new Map<string, number[]>();
    for (let i = s + 1; i < sEnd; i++) {
      const cmd = lead(codes[i]);
      if (!cmd || BULLET.test(codes[i]) || WRAP_OPEN.test(codes[i]) || WRAP_CLOSE.test(codes[i])) continue;
      if (/^\\(vspace|hspace|noindent|par|newline|smallskip|medskip|bigskip|hfill|textbf|small|centering)$/.test(cmd))
        continue;
      counts.set(cmd, [...(counts.get(cmd) ?? []), i]);
    }
    // An entry command seen once (a section with one job) still marks an entry: its heading is names and dates.
    const starter =
      [...counts.entries()]
        .filter(([cmd, v]) => v.length >= 2 || ENTRY_CMDS.test(cmd) || starters.has(cmd))
        .sort((a, b) => a[1][0] - b[1][0])[0]?.[1] ?? [];
    if (starter.length) starters.add(lead(codes[starter[0]]));
    const entryIds: string[] = [];
    starter.forEach((e, ei) => {
      let eEnd = starter[ei + 1] ?? sEnd;
      if (ei === starter.length - 1) {
        // The last entry ends where a wrapper it didn't open closes (\resumeSubHeadingListEnd).
        let open = 0;
        for (let j = e + 1; j < eEnd; j++) {
          if (WRAP_OPEN.test(codes[j])) open++;
          else if (WRAP_CLOSE.test(codes[j]) && --open < 0) {
            eEnd = j;
            break;
          }
        }
      }
      const eid = `${sid}.E${ei + 1}`;
      entryIds.push(eid);
      units.set(eid, { id: eid, kind: "entry", start: e, end: eEnd });
    });
    if (entryIds.length > 1) groups.push({ id: sid, items: entryIds });

    // Bullets, per entry (or per section without entries), in runs of consecutive bullets.
    const parents = entryIds.length ? entryIds.map((id) => units.get(id)!) : [{ id: sid, start: s, end: sEnd } as Unit];
    const taken = new Set<number>();
    for (const p of parents) {
      let run: string[] = [];
      let n = 0;
      let runs = 0;
      const flush = () => {
        if (run.length > 1) groups.push({ id: `${p.id}.R${++runs}`, items: run });
        run = [];
      };
      for (let i = p.start + 1; i < p.end;) {
        if (BULLET.test(codes[i])) {
          const end = Math.min(unitEnd(i, p.end), p.end);
          const id = `${p.id}.B${++n}`;
          units.set(id, { id, kind: "bullet", start: i, end });
          for (let k = i; k < end; k++) taken.add(k);
          run.push(id);
          i = end;
        } else {
          if (codes[i].trim()) flush();
          i++;
        }
      }
      flush();
    }
    // Other text lines after a section's heading and outside its entries' headings: skills, a summary.
    const entryHeads = new Set<number>();
    for (const id of entryIds) {
      const u = units.get(id)!;
      for (let k = u.start; k < unitEnd(u.start, u.end); k++) entryHeads.add(k);
    }
    for (let i = unitEnd(s, sEnd); i < sEnd; i++) {
      if (taken.has(i) || entryHeads.has(i) || WRAP_OPEN.test(codes[i]) || WRAP_CLOSE.test(codes[i])) continue;
      const words = codes[i].replace(/\\[a-zA-Z@]+\*?/g, " ").match(/[A-Za-z]{2,}/g);
      // Not an entry-like line of many arguments (dates, places): only prose and lists like skills.
      if (!words || words.length < 2 || braceDelta(codes[i]) !== 0 || groupCount(codes[i]) >= 3) continue;
      const id = `L${i + 1}`;
      units.set(id, { id, kind: "line", start: i, end: i + 1 });
    }
  });
  if (sectionIds.length > 1) groups.unshift({ id: "sections", items: sectionIds });
  return {
    preamble: all.slice(0, begin + 1).join("\n"),
    lines,
    tail: all.slice(endAt).join("\n"),
    units,
    groups,
    commands,
  };
}

/** The body as the AI sees it: "id| text" for what it may change or move, plain lines for context. */
export function describe(p: ParsedTex): { resume: string; groups: { group: string; items: string[] }[] } {
  const byStart = new Map<number, Unit[]>();
  for (const u of p.units.values()) byStart.set(u.start, [...(byStart.get(u.start) ?? []), u]);
  const out: string[] = [];
  for (let i = 0; i < p.lines.length; i++) {
    const text = p.lines[i].trim();
    if (!text || /^%/.test(text)) continue;
    const here = byStart.get(i) ?? [];
    const edit = here.find((u) => u.kind === "bullet" || u.kind === "line");
    const ids = here.map((u) => u.id).join(" ");
    if (edit) {
      out.push(
        `${ids}| ${p.lines
          .slice(edit.start, edit.end)
          .map((l) => l.trim())
          .join(" ")}`,
      );
      i = edit.end - 1;
    } else out.push(ids ? `${ids}| ${text}` : `  ${text}`);
  }
  return { resume: out.join("\n"), groups: p.groups.map((g) => ({ group: g.id, items: g.items })) };
}

const SPECIALS = ["&", "%", "#", "_", "$"] as const;
const bare = (s: string, ch: string) => (s.match(new RegExp(`(^|[^\\\\])\\${ch}`, "g")) ?? []).length;

/** The edit as one line, made safe, or null when it would change the line's LaTeX structure. */
const RE_HIDING =
  /\\(color|textcolor|colorbox|fcolorbox|pagecolor|phantom|hphantom|vphantom|smash|tiny|scriptsize|fontsize|scalebox|resizebox|rlap|llap|transparent)\b|\{\s*white\s*\}/g;
const hiding = (s: string) => (s.match(RE_HIDING) ?? []).length;

function checkText(p: ParsedTex, original: string, text: string): string | null {
  let t = text.replace(/\s*\n\s*/g, " ").trim();
  if (!t || FORBIDDEN.test(t)) return null;
  for (const ch of SPECIALS) if (!bare(original, ch)) t = t.replace(new RegExp(`(^|[^\\\\])\\${ch}`, "g"), `$1\\${ch}`);
  if (lead(t) !== lead(original) || braceDelta(t) !== 0 || groupCount(t) !== groupCount(original)) return null;
  if ([...t.matchAll(/\\([a-zA-Z@]+)/g)].some((m) => !p.commands.has(m[1]))) return null;
  // Text hidden from a reader (white, tiny, invisible), keyword stuffing recruiters reject on sight: no more of it
  // than the line had.
  if (hiding(t) > hiding(original)) return null;
  // A reworded line stays about as long (the page count is checked after compiling, too).
  if (t.length > original.length * 1.5 + 20) return null;
  return t;
}

export interface Applied {
  tex: string;
  /** Output line (1-based, in the whole file) → the op that wrote it, to undo the edit a compile error points at. */
  origin: Map<number, string>;
  applied: number;
  dropped: number;
}

/**
 * Checks every op on its own and applies the valid ones. `skip`: op keys ("edit:S1.B2", "add:S1.B2#0") to leave out,
 * after a compile error traced to them.
 */
export function applyOps(p: ParsedTex, ops: TailorOps, skip = new Set<string>()): Applied {
  const out: string[][] = p.lines.map((l) => [l]);
  const from: (string | undefined)[][] = p.lines.map(() => [undefined]);
  let applied = 0;
  let dropped = 0;
  const editable = (id: string) => {
    const u = p.units.get(id);
    return u && (u.kind === "bullet" || u.kind === "line") ? u : null;
  };
  const text = (u: Unit) =>
    p.lines
      .slice(u.start, u.end)
      .map((l) => l.trim())
      .join(" ");
  const replace = (u: Unit, lines: string[], key: string) => {
    for (let k = u.start; k < u.end; k++) {
      out[k] = k === u.start ? lines : [];
      from[k] = k === u.start ? lines.map(() => key) : [];
    }
  };

  for (const e of ops.edits ?? []) {
    const key = `edit:${e.id}`;
    const u = editable(e.id);
    const t = u && !skip.has(key) ? checkText(p, text(u), e.text) : null;
    if (!u || !t) {
      dropped++;
      continue;
    }
    const indent = /^\s*/.exec(p.lines[u.start])![0];
    replace(u, [indent + t], key);
    applied++;
  }

  // Removals: bullets only, and never every bullet of a run.
  const removed = new Set<string>();
  for (const id of new Set(ops.remove ?? [])) {
    const u = p.units.get(id);
    const run = p.groups.find((g) => g.items.includes(id));
    const left = run ? run.items.filter((x) => x !== id && !removed.has(x)).length : 0;
    if (!u || u.kind !== "bullet" || skip.has(`remove:${id}`) || left === 0) {
      dropped++;
      continue;
    }
    removed.add(id);
    replace(u, [], `remove:${id}`);
    applied++;
  }

  (ops.add ?? []).forEach((a, i) => {
    const key = `add:${a.after}#${i}`;
    const u = p.units.get(a.after);
    const t = u && u.kind === "bullet" && !skip.has(key) ? checkText(p, text(u), a.text) : null;
    if (!u || !t) return void dropped++;
    const indent = /^\s*/.exec(p.lines[u.start])![0];
    const last = u.end - 1;
    out[last] = [...out[last], indent + t];
    from[last] = [...from[last], key];
    applied++;
  });

  // Orders: complete permutations of a group's items only.
  const order = new Map<string, string[]>();
  for (const o of ops.order ?? []) {
    const g = p.groups.find((x) => x.id === o.group);
    const ok =
      g &&
      !skip.has(`order:${o.group}`) &&
      o.items.length === g.items.length &&
      new Set(o.items).size === g.items.length &&
      o.items.every((x) => g.items.includes(x));
    if (!ok || o.items.every((x, i) => x === g!.items[i])) {
      if (!ok) dropped++;
      continue;
    }
    order.set(g!.id, o.items);
    applied++;
  }

  // Each group's item spans: from an item's start to the next item's start; the last one to its own end.
  const spans = new Map<string, [number, number]>();
  for (const g of p.groups)
    g.items.forEach((id, i) => {
      const next = g.items[i + 1];
      spans.set(id, [p.units.get(id)!.start, next ? p.units.get(next)!.start : p.units.get(id)!.end]);
    });
  const groupAt = new Map(p.groups.map((g) => [p.units.get(g.items[0])!.start, g]));
  const lines: string[] = [];
  const origin: (string | undefined)[] = [];
  // `parent`: the group whose item is being written; its own first item starts where the group does.
  const emit = (start: number, end: number, parent?: string) => {
    for (let i = start; i < end;) {
      const g = groupAt.get(i);
      if (g && g.id !== parent) {
        for (const id of order.get(g.id) ?? g.items) emit(...spans.get(id)!, g.id);
        i = spans.get(g.items.at(-1)!)![1];
      } else {
        lines.push(...out[i]);
        origin.push(...from[i]);
        i++;
      }
    }
  };
  emit(0, p.lines.length);

  const head = p.preamble.split("\n").length;
  const originMap = new Map<number, string>();
  origin.forEach((k, i) => k && originMap.set(head + i + 1, k));
  return { tex: [p.preamble, ...lines, p.tail].join("\n"), origin: originMap, applied, dropped };
}

/** Lines a pdfTeX log blames ("l.42 …"), for the edits to undo. */
export const errorLines = (log: string) => [...log.matchAll(/^l\.(\d+)/gm)].map((m) => Number(m[1]));

/** Pages of the PDF, from pdfTeX's last words: "Output written on main.pdf (2 pages, 41203 bytes)." */
export const pageCount = (log: string) => Number(/\((\d+) pages?, \d+ bytes\)/.exec(log)?.[1] ?? 0);

// ---------- upload checks ----------
const ENGINE_ONLY: Record<string, string> = {
  fontspec: "XeLaTeX/LuaLaTeX only",
  "unicode-math": "XeLaTeX/LuaLaTeX only",
  polyglossia: "XeLaTeX/LuaLaTeX only",
  xltxtra: "XeLaTeX only",
  xunicode: "XeLaTeX only",
  luacode: "LuaLaTeX only",
  luatextra: "LuaLaTeX only",
};

/** The packages and class the source loads that the bundle lacks, as messages. */
export function unsupported(src: string, bundle: { packages: string[]; classes: string[] }): string[] {
  const body = src.split("\n").map(code).join("\n");
  const out: string[] = [];
  const has = (list: string[], n: string) => list.includes(n);
  for (const m of body.matchAll(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const n = m[1].trim();
    if (!has(bundle.classes, n)) out.push(`Unsupported document class: ${n}`);
  }
  for (const m of body.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g))
    for (const n of m[1]
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean))
      if (!has(bundle.packages, n))
        out.push(`Unsupported package: ${n}${ENGINE_ONLY[n] ? ` (${ENGINE_ONLY[n]})` : ""}`);
  return [...new Set(out)];
}

/** What a failed compile's log says, for the person who uploaded the file. */
export function compileErrors(log: string): string[] {
  const missing = [...log.matchAll(/File `([^']+)\.(sty|cls)' not found/g)].map(
    (m) => `Unsupported ${m[2] === "cls" ? "document class" : "package"}: ${m[1]}`,
  );
  if (missing.length) return [...new Set(missing)];
  const files = [...log.matchAll(/I can't find file `([^']+)'/g)].map(
    (m) => `Missing file: ${m[1]} (upload a single self-contained .tex file)`,
  );
  if (files.length) return [...new Set(files)];
  const lines = log.split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (!/^!/.test(l) || out.length >= 6) return;
    out.push(l.replace(/^!\s*/, ""));
    const at = lines.slice(i + 1, i + 8).find((x) => /^l\.\d+/.test(x));
    if (at) out.push(`  at ${at}`);
  });
  return out.length ? out : ["The LaTeX compile failed."];
}
