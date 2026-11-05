// Résumé text extraction with pdf.js (bundled worker; pdf.js 6 never uses eval).
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export async function pdfText(data: ArrayBuffer): Promise<string> {
  const task = getDocument({ data });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(
      content.items
        .map((it) => ("str" in it ? it.str + (it.hasEOL ? "\n" : "") : ""))
        .join("")
        .trim(),
    );
  }
  await task.destroy();
  return pages.join("\n");
}

/** The PDF's page count, for the one-page limit on AI tailor's fallback PDF. */
export async function pdfPages(data: ArrayBuffer): Promise<number> {
  const task = getDocument({ data });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}
