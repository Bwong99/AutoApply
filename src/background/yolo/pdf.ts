// A plain-text PDF (Helvetica, US Letter) for a generated cover letter: no PDF library in the bundle.
import { ONE_PAGE_WORDS } from "../../shared/constants";
import { wordCount } from "../../shared/essay";

const PUNCT: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  "•": "-",
};

/** Latin-1 only (Helvetica's WinAnsi encoding covers it), with typographic punctuation made plain. */
const latin1 = (s: string) => s.replace(/[‘’“”–—…•]/g, (c) => PUNCT[c]).replace(/[^\n\x20-\xff]/g, "");
const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");

export function wrap(text: string, width = 90): string[] {
  return latin1(text)
    .split("\n")
    .flatMap((para) => {
      const out: string[] = [];
      let line = "";
      for (const w of para.split(/\s+/).filter(Boolean)) {
        if (line && line.length + 1 + w.length > width) {
          out.push(line);
          line = w;
        } else line = line ? `${line} ${w}` : w;
      }
      return [...out, line];
    });
}

/** Lines on a page: 11 pt type on 15 pt leading from 1" below the top to 5/6" above the bottom. */
export const LINES_PER_PAGE = 44;
/** How many lines the text takes in textPdf: over LINES_PER_PAGE runs to a second page. */
export const textLines = (text: string) => wrap(text).length;

/** Base64 of the PDF. */
export function textPdf(text: string): string {
  const lines = wrap(text);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    `<</Type/Pages/Kids[${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(" ")}]/Count ${pages.length}>>`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
  ];
  pages.forEach((p, i) => {
    const stream = `BT /F1 11 Tf 15 TL 72 720 Td ${p.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objs.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + 2 * i} 0 R>>`,
      `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    );
  });
  let pdf = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj${o}endobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return btoa(pdf);
}

/**
 * The cover letter's text, drafted for `target` words. With the one-page limit (settings.coverLetterOnePage) the target
 * is at most ONE_PAGE_WORDS, and a letter whose PDF would still run past one page is written once more, shorter by as
 * much as it ran over; one that still doesn't fit is an error, never uploaded.
 */
export async function letterText(
  draft: (words: number) => Promise<{ text: string | null; note?: string } | undefined>,
  target: number,
  onePage: boolean,
): Promise<{ text: string } | { error: string }> {
  let e = await draft(onePage ? Math.min(target, ONE_PAGE_WORDS) : target);
  if (!e?.text) return { error: e?.note ?? "No cover letter drafted" };
  if (!onePage || textLines(e.text) <= LINES_PER_PAGE) return { text: e.text };
  const words = Math.floor(((wordCount(e.text) * LINES_PER_PAGE) / textLines(e.text)) * 0.85);
  e = await draft(Math.max(10, words));
  if (!e?.text) return { error: e?.note ?? "No cover letter drafted" };
  return textLines(e.text) <= LINES_PER_PAGE
    ? { text: e.text }
    : { error: "The cover letter ran over the one-page limit" };
}
