// Shared by run.mjs (YOLO) and fill.mjs (manual autofill): headless browser with the built extension,
// storage seeded from the user's export, and the compact report's per-page section.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { TOOLS } from "./lib.mjs";

export const DUMP = fs.readFileSync(path.join(TOOLS, "page-dump.js"), "utf8");

/** The export's AI provider, or Gemini when that is the Claude bridge (it needs the native host). */
export const providerFor = (exp) =>
  process.env.AI_PROVIDER ??
  (exp.settings?.aiProvider === "claude" && exp.apiKeys?.length ? "gemini" : exp.settings?.aiProvider);

export async function launch(ext, profileDir, port, say) {
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1366, height: 900 },
    args: [
      ...(port ? [`--remote-debugging-port=${port}`] : []),
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--disable-blink-features=AutomationControlled",
      // A normal Chrome UA gets past several bot walls (SmartRecruiters, Cloudflare) that flag HeadlessChrome.
      "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    ],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  sw.on("console", (m) => /AutoApply|YOLO/.test(m.text()) && say("SW:", m.text().slice(0, 400)));
  return { ctx, sw };
}

/** Profile, settings, keys and documents from the export, plus `extra` storage keys; logs AI calls. */
export async function seed(sw, exp, settings, extra) {
  await sw.evaluate(
    async ({ exp, settings, extra }) => {
      while ((await chrome.storage.local.get("schemaVersion")).schemaVersion === undefined)
        await new Promise((r) => setTimeout(r, 20));
      const docs = {};
      for (const d of exp.documents ?? []) docs[`doc:${d.meta.id}`] = { base64: d.base64 };
      globalThis.__log = [];
      const f = globalThis.fetch;
      globalThis.fetch = async (...a) => {
        const r = await f(...a);
        if (String(a[0]).includes("generativelanguage"))
          r.clone()
            .text()
            .then((t) => globalThis.__log.push({ req: a[1]?.body, res: t }));
        return r;
      };
      await chrome.storage.local.set({
        settings: { ...exp.settings, ...settings },
        profile: exp.profile,
        apiKeys: exp.apiKeys,
        keyState: {},
        selectedModel: exp.selectedModel,
        fallbackModel: exp.fallbackModel,
        documentsIndex: (exp.documents ?? []).map((d) => d.meta),
        ...docs,
        ...extra,
      });
    },
    { exp, settings, extra },
  );
}

/** Report lines for each page's dump; `flags` counts rows that point at a bug. */
export function pageLines(pages, checks) {
  const lines = [];
  let flags = 0;
  const bad = (s) => {
    lines.push(s);
    flags++;
  };
  for (const p of pages) {
    lines.push(`--- PAGE ${p.step || p.heading || p.title} | ${p.url.slice(0, 120)}`);
    for (const e of p.errors) bad(`  ! ERROR ${e}`);
    const ok = [];
    for (const r of p.rows) {
      const c = checks.find(([re]) => re.test(r.label));
      const head = `${r.kind} | ${r.label} = ${r.value}`;
      if (r.empty && r.req) bad(`  ! BLANK* ${head}`);
      else if (r.empty) lines.push(`  ? empty ${head}`);
      else if (
        c &&
        !(c[2] ?? ((v, e) => v.trim().toLowerCase() === String(e).trim().toLowerCase()))(
          r.value.replace(/^\{(.*)\}$/, "$1"),
          String(c[1]),
        )
      )
        bad(`  ! SUS ${head}   (profile: ${c[1]})`);
      else if (c) ok.push(r.label.slice(0, 30));
      else lines.push(`    ${head}`);
    }
    if (ok.length) lines.push(`  profile-ok ${ok.length}: ${ok.join("; ")}`);
  }
  return { lines, flags };
}
