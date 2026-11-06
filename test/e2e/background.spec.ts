// A fill must keep running, at full speed, after the user switches tabs. Playwright keeps every page it attaches
// to visible and focused, so this test launches Chromium itself and speaks raw CDP to the extension's service
// worker only: the job tabs stay unattached and get real background behavior (no animation frames, no
// rendering-driven scroll events, 1 s-aligned timers).
import { chromium, test as base, type Page, type Worker } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockGemini } from "../mockGemini";
import { BASE, expect, fillPage, seed } from "./extension";
import { SCHEMA_VERSION } from "../../src/shared/storage";

type Target = { type: string; url: string; webSocketDebuggerUrl: string };
type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

function cdp(url: string) {
  const ws = new WebSocket(url);
  const pending = new Map<number, (m: Msg) => void>();
  const listeners: ((m: Msg) => void)[] = [];
  let id = 0;
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as Msg;
    if (m.id) pending.get(m.id)?.(m);
    else for (const l of listeners) l(m);
  };
  const send = <T = Record<string, unknown>>(method: string, params = {}) =>
    new Promise<T>((resolve, reject) => {
      pending.set(++id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result as T)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const open = new Promise((r) => (ws.onopen = r));
  return { open, send, on: (l: (m: Msg) => void) => listeners.push(l), close: () => ws.close() };
}

const test = base.extend<{ sw: Worker }>({
  sw: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), "autoapply-bg-"));
    const ext = path.resolve("dist");
    const proc = spawn(
      chromium.executablePath(),
      [
        `--user-data-dir=${dir}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
      ],
      { stdio: "ignore" },
    );
    const portFile = path.join(dir, "DevToolsActivePort");
    await expect.poll(() => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n")).toBe(true);
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    // A fresh profile's worker may restart once while the extension installs: attach until it has migrated storage.
    let c: ReturnType<typeof cdp> | undefined;
    await expect
      .poll(
        async () => {
          const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Target[];
          const target = list.find((t) => t.type === "service_worker" && t.url.endsWith("/service-worker-loader.js"));
          if (!target) return false;
          c?.close();
          c = cdp(target.webSocketDebuggerUrl);
          await c.open;
          const r = await Promise.race([
            c.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
              expression: `chrome.storage.local.get("schemaVersion").then((s) => s.schemaVersion)`,
              awaitPromise: true,
              returnByValue: true,
            }),
            new Promise<null>((r) => setTimeout(() => r(null), 2000)),
          ]);
          return r?.result.value === SCHEMA_VERSION;
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const conn = c!;

    // The Gemini mock, on the service worker's own network requests.
    const mock = new MockGemini();
    conn.on((m) => {
      if (m.method !== "Fetch.requestPaused") return;
      const r = m.params!.request as {
        url: string;
        method: string;
        headers: Record<string, string>;
        postData?: string;
      };
      const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const route = {
        request: () => ({
          url: () => r.url,
          method: () => r.method,
          headers: () => headers,
          postDataJSON: () => JSON.parse(r.postData ?? "null"),
        }),
        fulfill: ({ status, body }: { status: number; body: string }) =>
          conn.send("Fetch.fulfillRequest", {
            requestId: m.params!.requestId,
            responseCode: status,
            responseHeaders: [{ name: "content-type", value: "application/json" }],
            body: Buffer.from(body).toString("base64"),
          }),
      };
      void (mock as unknown as { handle: (r: unknown) => Promise<void> }).handle(route);
    });
    await conn.send("Fetch.enable", { patterns: [{ urlPattern: "https://generativelanguage.googleapis.com/*" }] });

    const sw = {
      async evaluate(fn: (arg: unknown) => unknown, arg?: unknown) {
        const r = await conn.send<{ result: { value: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
          expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
          awaitPromise: true,
          returnByValue: true,
        });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
      },
    };
    await use(sw as unknown as Worker);
    conn.close();
    proc.kill();
    await new Promise((r) => proc.once("exit", r));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  },
});

interface Result {
  visibility: string;
  status: string;
  done: number;
  country: string;
  type: string;
  dial: string | null;
  school: string;
  badges: string[];
}

/** Fills custom-dropdown.html in a new tab; with `switchAway`, the user opens another tab right after starting. */
async function run(sw: Worker, switchAway: boolean) {
  const url = `${BASE}custom-dropdown.html?${switchAway ? "bg" : "fg"}`;
  const tabId = (await sw.evaluate(async (url) => {
    const t = await chrome.tabs.create({ url, active: true });
    while ((await chrome.tabs.get(t.id!)).status !== "complete") await new Promise((r) => setTimeout(r, 20));
    return t.id;
  }, url)) as number;
  await fillPage({ url: () => url } as Page, sw);
  if (switchAway) await sw.evaluate(() => chrome.tabs.create({ url: "about:blank", active: true }));
  const read = () =>
    sw.evaluate(async (tabId) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tabId as number },
        func: () => {
          const all = (sel: string) =>
            [...document.querySelectorAll("autoapply-root")].flatMap((h) => [...h.shadowRoot!.querySelectorAll(sel)]);
          const text = (sel: string) => document.querySelector(sel)?.textContent ?? "";
          return {
            visibility: document.visibilityState,
            status: all(".panel .status")[0]?.textContent ?? "",
            done: Number(/done\s+(\d+) ms/.exec(all("pre.timings")[0]?.textContent ?? "")?.[1]),
            country: text("#country .select__single-value"),
            type: text("#type-btn"),
            dial: document.querySelector("#dial")?.getAttribute("data-country"),
            school: text("#school-control .select__single-value"),
            badges: all(".tag").map((t) => `${t.getAttribute("aria-label")} ${t.getAttribute("data-color")}`),
          };
        },
      });
      return result;
    }, tabId) as Promise<Result>;
  await expect.poll(async () => (await read()).status, { timeout: 30_000 }).toMatch(/^Done ·/);
  return read();
}

test("a fill keeps running at full speed after the user switches tabs", async ({ sw }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true, settings: { debugLogging: true } });
  const fg = await run(sw, false);
  const bg = await run(sw, true);
  console.log("done (ms): foreground", fg.done, "background", bg.done);
  expect(bg.visibility).toBe("hidden");
  for (const r of [fg, bg])
    expect(r).toMatchObject({
      country: "Canada",
      type: "Co-op / Internship",
      dial: "Canada",
      school: "University of British Columbia",
    });
  expect(bg.badges).toEqual(fg.badges);
  // Unfixed, hidden-tab timers wake once a second and this fill takes over 30 s; slack is for the tab switch.
  expect(bg.done).toBeLessThanOrEqual(fg.done * 1.25);

  // Once done, the hidden tab asks the service worker for no more timers: nothing keeps running.
  await sw.evaluate(() => {
    const g = globalThis as unknown as { timers: number };
    g.timers = 0;
    const original = setTimeout;
    globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => (
      g.timers++,
      original(...a)
    )) as typeof setTimeout;
  });
  await new Promise((r) => setTimeout(r, 1500)); // waits still pending at Done (≤ 900 ms) run out
  await sw.evaluate(() => ((globalThis as unknown as { timers: number }).timers = 0));
  await new Promise((r) => setTimeout(r, 3000));
  expect(await sw.evaluate(() => (globalThis as unknown as { timers: number }).timers)).toBe(0);
});
