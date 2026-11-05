// Shared by run.mjs (YOLO) and fill.mjs (manual autofill): headless browser with the built extension,
// storage seeded from the user's export, and the compact report's per-page section.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOLS } from "./lib.mjs";

export const DUMP = fs.readFileSync(path.join(TOOLS, "page-dump.js"), "utf8");

/** The export's AI provider, or Gemini when that is the Claude bridge (it needs the native host). */
export const providerFor = (exp) =>
  process.env.AI_PROVIDER ??
  (exp.settings?.aiProvider === "claude" && exp.apiKeys?.length ? "gemini" : exp.settings?.aiProvider);

/** The Claude bridge AutoApply's setup installed (src/native/host.sh), which headless runs reuse. */
const BRIDGE = path.join(
  os.homedir(),
  ".autoapply",
  "claude-bridge",
  process.platform === "win32" ? "host.bat" : "host.sh",
);

/**
 * Registers the installed Claude bridge for this browser profile: Chrome also reads native messaging manifests from
 * `<user-data-dir>/NativeMessagingHosts` (macOS/Linux), and only lets the origins listed there connect.
 */
function registerBridge(profileDir, extId) {
  const dir = path.join(profileDir, "NativeMessagingHosts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "com.autoapply.claude.json"),
    JSON.stringify({
      name: "com.autoapply.claude",
      description: "AutoApply bridge to Claude Code (test harness)",
      path: BRIDGE,
      type: "stdio",
      allowed_origins: [`chrome-extension://${extId}/`],
    }),
  );
}

export async function launch(ext, profileDir, port, say) {
  // A profile of our own, so the Claude bridge can be registered in it (Playwright's own temp profile is unknown).
  // Removed when the process exits: a browser profile is tens of MB, and a sweep runs hundreds.
  if (!profileDir) {
    const tmp = (profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-sweep-")));
    process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
  }
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
  sw.on(
    "console",
    (m) => /AutoApply|YOLO|\[review\]|\[navigate\]/.test(m.text()) && say("SW:", m.text().slice(0, 400)),
  );
  if (fs.existsSync(BRIDGE)) registerBridge(profileDir, new URL(sw.url()).host);
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
      // The LaTeX résumé for AI tailoring, as the options page imports it (routes/Data.tsx).
      const t = exp.tailorResume;
      if (t) {
        docs["doc:tailor-tex"] = { base64: t.tex };
        docs["doc:tailor-pdf"] = { base64: t.pdf };
        if (t.fallbackPdf) docs["doc:tailor-fallback-pdf"] = { base64: t.fallbackPdf };
      }
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
      // Claude bridge calls too: the request's prompts and claude's stream-json reply, decoded.
      const connect = chrome.runtime.connectNative?.bind(chrome.runtime);
      if (connect) {
        const dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
        chrome.runtime.connectNative = (name) => {
          const port = connect(name);
          const entry = { at: Date.now() };
          const post = port.postMessage.bind(port);
          port.postMessage = (m) => {
            if (Array.isArray(m))
              Object.assign(entry, { system: dec(m[0]), req: dec(m[1]), model: m[2], effort: m[3] });
            return post(m);
          };
          port.onMessage.addListener((m) => {
            const out = dec(m.out ?? "");
            const res =
              out
                .split("\n")
                .reverse()
                .find((l) => l.includes('"type":"result"')) ?? out.slice(-4000);
            globalThis.__log.push({ ...entry, ms: Date.now() - entry.at, code: m.code, res });
          });
          return port;
        };
      }
      await chrome.storage.local.set({
        settings: { ...exp.settings, ...settings },
        profile: exp.profile,
        apiKeys: exp.apiKeys,
        keyState: {},
        selectedModel: exp.selectedModel,
        fallbackModel: exp.fallbackModel,
        documentsIndex: (exp.documents ?? []).map((d) => d.meta),
        tailorResume: t?.info ? { ...t.info, fallback: t.fallbackPdf ? t.info.fallback : null } : null,
        // The bridge is registered for this profile (launch): Claude is as set up as in the user's browser.
        claudeReady: (settings?.aiProvider ?? exp.settings?.aiProvider) === "claude",
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

/** The AI review's and the navigator's calls in a run's AI log, one line each: what they changed and why. */
export function reviewLines(log = []) {
  const out = [];
  const json = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  for (const e of log) {
    // Claude entries carry the prompts; Gemini's carry the request body.
    const body = e.system === undefined ? json(e.req) : null;
    const system = e.system ?? body?.systemInstruction?.parts?.[0]?.text ?? "";
    const kind = system.startsWith("You review") ? "review" : system.startsWith("You navigate") ? "navigate" : "";
    if (!kind) continue;
    const req = body ? json(body.contents?.[0]?.parts?.[0]?.text ?? "") : json(e.req);
    let text = e.res ?? "";
    const r = json(text);
    text = r?.result ?? r?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? text;
    const reply = json(String(text).slice(String(text).indexOf("{"), String(text).lastIndexOf("}") + 1));
    const head = `  ${kind}${e.model ? ` (${e.model}${e.ms ? `, ${Math.round(e.ms / 1000)}s` : ""})` : ""}`;
    if (!reply) {
      out.push(`${head}: no reply`);
      continue;
    }
    if (kind === "navigate") {
      out.push(
        `${head}: ${req?.why ?? ""} → ${reply.state} ${reply.action}${reply.ref ? ` ${reply.ref}` : ""}${reply.purpose ? ` (${reply.purpose})` : ""}: ${reply.reason ?? ""}`,
      );
      continue;
    }
    const q = new Map((req?.fields ?? []).map((f) => [f.id, f.question]));
    const verdicts = (reply.fields ?? []).filter((v) => v.verdict !== "ok");
    out.push(
      `${head}: ${(reply.fields ?? []).length} fields, ${verdicts.length} not ok, ${(reply.missed ?? []).length} missed`,
    );
    for (const v of verdicts)
      out.push(
        `    ${v.verdict} ${String(q.get(v.fieldId) ?? v.fieldId).slice(0, 60)}${v.answer != null ? ` → "${String(v.answer).slice(0, 60)}"` : ""}${v.reason ? ` (${v.reason})` : ""}`,
      );
    for (const m of reply.missed ?? [])
      out.push(`    missed ${m.kind} ${m.question.slice(0, 70)}${m.answer ? ` → "${m.answer}"` : ""}`);
  }
  return out;
}
