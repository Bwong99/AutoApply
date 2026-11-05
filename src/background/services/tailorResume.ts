// AI résumé tailoring: the user's LaTeX résumé edited for one job, compiled in the offscreen document. Every failure
// (no job description, an AI error, edits that don't fit, a compile error, a longer résumé, a timeout) gives the
// untailored PDF made when the .tex was uploaded instead; an application is never held up by it. With the one-page
// limit on (settings.tailorOnePage), the AI also ranks what to cut, the fewest of those cuts that fit are applied, and
// no résumé over one page is ever uploaded: not the tailored one, nor a fallback.
import { applyOps, describe, errorLines, parseTex, planCuts, type TailorOps } from "../../shared/latex";
import type { createStorage } from "../../shared/storage";
import { session } from "../../shared/storage";
import type { DocumentMeta, JobContext, Profile } from "../../shared/types";
import { BadOutputError, BlockedError } from "../gemini/errors";
import { tailorSystem } from "../gemini/prompts";
import { TAILOR_CUT_SCHEMA, TAILOR_SCHEMA, TailorZ } from "../gemini/schemas";
import { releaseOffscreen, useOffscreen } from "../offscreen";
import { jobBrief } from "./jobBrief";
import { compactProfile, type ServiceCtx } from "./mapFields";

export type Compile = (tex: string, timeoutMs: number) => Promise<{ pdf: string; log: string; pages: number }>;

export interface TailorOutcome {
  /** Base64 of the tailored PDF; absent when the fallback is to be used. */
  pdf?: string;
  /** The tailored source the PDF was compiled from, with `pdf`. */
  tex?: string;
  /** Why the fallback was used, or what was changed. */
  note: string;
  /** The failure may not repeat (an AI error, a stop): not remembered for the job. */
  transient?: boolean;
}

const COMPILE_MS = 30_000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The AI's edits to `tex` for `job`, compiled. `onePage`: the result is one page or nothing, the AI's ranked cuts
 * applied as far as needed; otherwise it may be as long as the original (`pages`).
 */
export async function tailor(
  ctx: ServiceCtx,
  input: { tex: string; pages: number; prompt: string; job: JobContext | null; profile: Profile; onePage?: boolean },
  compile: Compile,
): Promise<TailorOutcome> {
  const onePage = !!input.onePage;
  const parsed = parseTex(input.tex);
  if (!parsed?.units.size) return { note: "The résumé's sections couldn't be read" };
  if (!input.job?.text && !input.job?.header) return { note: "No job description found on the page" };
  const { resume, groups } = describe(parsed);
  let ops: TailorOps;
  try {
    const r = await ctx.ai.call(
      {
        system: tailorSystem(onePage),
        // The user's instructions and résumé are the same for every job: ahead of the job, for prompt caching.
        context: { instructions: input.prompt, resume, groups, ...(onePage ? { pages: input.pages } : {}) },
        payload: compactProfile({
          job: { ...jobBrief(input.job), location: input.job.location },
          profileSkills: input.profile.skills.technical,
        }),
        schema: onePage ? TAILOR_CUT_SCHEMA : TAILOR_SCHEMA,
        validate: (d) => TailorZ.parse(d),
        essay: true,
        timeoutMs: ctx.settings.requestTimeoutMs * 2,
        signal: ctx.signal,
      },
      { model: ctx.model, fallback: ctx.fallback },
    );
    ops = r.data;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return { note: "Stopped", transient: true };
    const why =
      e instanceof BlockedError ? "AI declined" : e instanceof BadOutputError ? "AI gave unusable edits" : null;
    return { note: why ?? `AI error: ${(e as Error)?.message ?? e}`, transient: !why };
  }

  let a = applyOps(parsed, ops);
  // A résumé over one page is worth compiling for its cuts alone.
  const cutsOnly = onePage && input.pages > 1 && planCuts(parsed, ops).length > 0;
  if (!a.applied && !cutsOnly)
    return { note: a.dropped ? "None of the AI's edits fit the résumé's format" : "The AI changed nothing" };
  let skip = new Set<string>();
  let c = await compile(a.tex, COMPILE_MS);
  if (!c.pdf) {
    // Undo the edits the error points at, once.
    const blamed = new Set(errorLines(c.log).flatMap((l) => [a.origin.get(l)].filter((k): k is string => !!k)));
    if (!blamed.size) return { note: "The tailored résumé didn't compile" };
    skip = blamed;
    a = applyOps(parsed, ops, blamed);
    if (!a.applied && !cutsOnly) return { note: "The tailored résumé didn't compile" };
    c = await compile(a.tex, COMPILE_MS);
    if (!c.pdf) return { note: "The tailored résumé didn't compile" };
  }
  if (!onePage) {
    if (c.pages > input.pages) return { note: `The tailored résumé ran to ${c.pages} pages instead of ${input.pages}` };
    return { pdf: c.pdf, tex: a.tex, note: `${a.applied} change${a.applied === 1 ? "" : "s"} for this job` };
  }

  let cuts = 0;
  if (c.pages > 1) {
    const plan = planCuts(parsed, ops, skip);
    const fit = await fewestCuts(
      plan.length,
      async (k) => {
        const ak = applyOps(parsed, ops, skip, plan.slice(0, k));
        return { a: ak, c: await compile(ak.tex, COMPILE_MS) };
      },
      ctx.signal,
    );
    if (ctx.signal?.aborted) return { note: "Stopped", transient: true };
    if (!fit)
      return {
        note: `The tailored résumé ran to ${c.pages} pages${plan.length ? ` even after ${plural(plan.length, "cut")}` : ""}, over the one-page limit`,
      };
    ({ a, c } = fit);
    cuts = fit.k;
  }
  const changes = a.applied ? `${plural(a.applied, "change")} for this job` : "";
  const cut = cuts ? `${plural(cuts, "cut")} to fit one page` : "";
  return { pdf: c.pdf, tex: a.tex, note: [changes, cut].filter(Boolean).join("; ") || "Fits on one page as it is" };
}

/**
 * The fewest of `n` ranked cuts whose compile fits on one page, or null when even all of them don't: tries 1, 2, 4…
 * then halves the gap, so a small overflow costs one or two compiles and ten cuts at most six.
 */
async function fewestCuts<T extends { c: { pdf: string; pages: number } }>(
  n: number,
  attempt: (k: number) => Promise<T>,
  signal?: AbortSignal,
): Promise<(T & { k: number }) | null> {
  const fits = (r: T) => !!r.c.pdf && r.c.pages <= 1;
  let lo = 0;
  let best: (T & { k: number }) | null = null;
  for (let k = 1; k <= n && !signal?.aborted; k = k === n ? n + 1 : Math.min(k * 2, n)) {
    const r = await attempt(k);
    if (fits(r)) {
      best = { ...r, k };
      break;
    }
    lo = k;
  }
  while (best && best.k - lo > 1 && !signal?.aborted) {
    const m = (lo + best.k) >> 1;
    const r = await attempt(m);
    if (fits(r)) best = { ...r, k: m };
    else lo = m;
  }
  return best;
}

/** Compiles in the offscreen document, which stays open from the first compile to the `done` call. */
export function offscreenCompiler(): { compile: Compile; done: () => Promise<void> } {
  let opened = false;
  return {
    async compile(tex, timeoutMs) {
      if (!opened) await useOffscreen("latex");
      opened = true;
      const r = await chrome.runtime
        .sendMessage({ type: "LATEX_COMPILE", tex, timeoutMs })
        .catch((e: Error) => ({ pdf: "", log: `! ${e.message}`, pages: 0 }));
      return r ?? { pdf: "", log: "! No compiler answered", pages: 0 };
    },
    done: async () => void (opened && (await releaseOffscreen("latex"))),
  };
}

// ---------- the résumé a fill uploads ----------
type Store = ReturnType<typeof createStorage>;
export const FALLBACK = "tailor-fallback";
const inFlight = new Map<string, Promise<TailoredDoc | { error: string; transient?: boolean }>>();

export interface TailoredDoc {
  meta: DocumentMeta;
  tailored: boolean;
  note: string;
  transient?: boolean;
}

const resumeName = (p: Profile) =>
  `${`${p.personal.firstName} ${p.personal.lastName}`.trim().replace(/\s+/g, "_") || "My"}_Resume.pdf`;

async function digest(...parts: string[]): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\u0000")));
  return [...new Uint8Array(h).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const pdfMeta = (id: string, fileName: string, base64: string): DocumentMeta => ({
  id,
  label: "Résumé",
  kind: "resume",
  fileName,
  mimeType: "application/pdf",
  size: Math.floor((base64.length * 3) / 4),
  isPrimaryResume: false,
  uploadedAt: Date.now(),
});

/** The user's fallback PDF if they uploaded one, else the untailored PDF compiled from the .tex. */
const fallbackPdf = async (store: Store) =>
  (await store.getDoc("tailor-fallback-pdf")) ?? (await store.getDoc("tailor-pdf"));

/** A tailored résumé's PDF, or the fallback, for GET_DOCUMENT. */
export async function tailoredDoc(store: Store, id: string): Promise<{ meta: DocumentMeta; base64: string } | null> {
  if (id !== FALLBACK) return session.get(`tailordoc:${id}`);
  const [base64, profile] = await Promise.all([fallbackPdf(store), store.get("profile")]);
  return base64 ? { meta: pdfMeta(FALLBACK, resumeName(profile), base64), base64 } : null;
}

/**
 * The résumé for `job`. One tailoring per job, résumé and prompt: every frame, Re-run and later page of the
 * application gets the same one, so no tokens are spent twice.
 */
export async function tailoredResume(
  store: Store,
  job: JobContext | null,
  serviceCtx: () => Promise<ServiceCtx | { error: { message: string } }>,
): Promise<TailoredDoc | { error: string }> {
  const [info, tex, settings, profile] = await Promise.all([
    store.get("tailorResume"),
    store.getDoc("tailor-tex"),
    store.get("settings"),
    store.get("profile"),
  ]);
  const own = await store.getDoc("tailor-fallback-pdf");
  const untailored = own ?? (await store.getDoc("tailor-pdf"));
  if (!info || !tex || !untailored) return { error: "No LaTeX résumé is uploaded" };
  const onePage = settings.tailorOnePage;
  // The fallback's pages: an uploaded PDF's are counted in Documents (unknown for one uploaded before that).
  const fallbackPages = own ? info.fallback?.pages : info.pages;
  const key = await digest(
    tex,
    settings.tailorPrompt,
    job?.company ?? "",
    job?.jobTitle ?? "",
    (job?.text ?? "").slice(0, 4000),
    ...(onePage ? ["one page", own ? String(fallbackPages) : ""] : []),
  );
  const cached = await session.get<TailoredDoc | { error: string }>(`tailored:${key}`);
  if (cached) return cached;
  let p = inFlight.get(key);
  if (!p) {
    p = (async () => {
      const fileName = resumeName(profile);
      const fallback = (note: string, transient = false): TailoredDoc | { error: string; transient?: boolean } =>
        // The one-page limit: a fallback over one page (or of unknown length) is never uploaded either.
        onePage && !(fallbackPages !== undefined && fallbackPages <= 1)
          ? {
              error: `Résumé not uploaded: ${note}, and the ${own ? "fallback PDF" : "untailored résumé"} ${fallbackPages ? `is ${plural(fallbackPages, "page")}, over the one-page limit` : "couldn't be read to check the one-page limit"}`,
              ...(transient ? { transient } : {}),
            }
          : {
              meta: pdfMeta(FALLBACK, fileName, untailored),
              tailored: false,
              note,
              ...(transient ? { transient } : {}),
            };
      const ctx = await serviceCtx();
      if ("error" in ctx) return fallback(ctx.error.message, true);
      const c = offscreenCompiler();
      try {
        const source = new TextDecoder().decode(Uint8Array.from(atob(tex), (ch) => ch.charCodeAt(0)));
        const r = await tailor(
          ctx,
          { tex: source, pages: info.pages, prompt: settings.tailorPrompt, job, profile, onePage },
          c.compile,
        );
        if (!r.pdf) return fallback(r.note, r.transient);
        const id = `tailor-${crypto.randomUUID()}`;
        const meta = pdfMeta(id, fileName, r.pdf);
        await Promise.all([
          session.set(`tailordoc:${id}`, { meta, base64: r.pdf }),
          // For the overlay: the job as tailor() gave it to the AI.
          session.set(`docjob:${id}`, { ...jobBrief(job), location: job?.location }),
        ]);
        return { meta, tailored: true, note: r.note };
      } catch (e) {
        return fallback(`Tailoring failed: ${(e as Error)?.message ?? e}`, true);
      } finally {
        await c.done();
      }
    })();
    inFlight.set(key, p);
    void p.finally(() => inFlight.delete(key));
  }
  const r = await p;
  // A passing failure (an AI error, a stopped fill) isn't this job's answer: the next fill tries again.
  if (!r.transient) await session.set(`tailored:${key}`, r);
  return "error" in r ? { error: r.error } : r;
}
