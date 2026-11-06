// A fill must keep running, at full speed, after the user switches tabs. Playwright keeps every page it attaches
// to visible and focused, so this test launches Chromium itself and speaks raw CDP to the extension's service
// worker only. Fill correctness and idle cleanup are always checked; native hidden-tab timing requires the
// browser to report the inactive tab as hidden (some environments keep every renderer visible).
import { chromium, test as base, type Page, type Worker } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockGemini } from "../mockGemini";
import { BASE, expect, fillPage, seed, test as extensionTest } from "./extension";
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
    if (m.id) {
      const reply = pending.get(m.id);
      pending.delete(m.id);
      reply?.(m);
    } else for (const l of listeners) l(m);
  };
  ws.onclose = () => {
    for (const reply of pending.values()) reply({ error: "Browser connection closed" });
    pending.clear();
  };
  const send = <T = Record<string, unknown>>(method: string, params = {}) =>
    new Promise<T>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error("Browser connection is not open"));
      pending.set(++id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result as T)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const open = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("Browser connection failed"));
  });
  return { open, send, on: (l: (m: Msg) => void) => listeners.push(l), close: () => ws.close() };
}

function removeProfile(dir: string) {
  // Delete only the temporary profile this fixture created, including when setup failed.
  if (path.dirname(path.resolve(dir)) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith("autoapply-bg-"))
    throw new Error(`Unexpected browser profile path: ${dir}`);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
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
        "--window-size=1280,900",
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.once("error", () => resolve());
    });
    let c: ReturnType<typeof cdp> | undefined;
    try {
      const portFile = path.join(dir, "DevToolsActivePort");
      await expect.poll(() => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n")).toBe(true);
      const port = readFileSync(portFile, "utf8").split("\n")[0];
      // A fresh profile's worker may restart once while the extension installs: attach until it has migrated storage.
      await expect
        .poll(
          async () => {
            try {
              const list = (await (
                await fetch(`http://127.0.0.1:${port}/json/list`, {
                  signal: AbortSignal.timeout(2000),
                })
              ).json()) as Target[];
              const target = list.find(
                (t) => t.type === "service_worker" && t.url.endsWith("/service-worker-loader.js"),
              );
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
            } catch {
              // DevTools can publish its port before accepting connections, and installation restarts the worker.
              c?.close();
              return false;
            }
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
    } finally {
      c?.close();
      if (proc.exitCode === null) proc.kill();
      await exited;
      removeProfile(dir);
    }
  },
});

interface Result {
  visibility: string;
  hidden: boolean;
  status: string;
  done: number;
  country: string;
  type: string;
  dial: string | null;
  school: string;
  badges: string[];
}

/** Fills custom-dropdown.html in a new tab; with `switchAway`, the user opens another tab right after starting. */
async function run(sw: Worker, switchAway: boolean, simulateHidden = false) {
  const url = `${BASE}custom-dropdown.html?${switchAway ? "bg" : "fg"}`;
  const tabId = (await sw.evaluate(async (url) => {
    const t = await chrome.tabs.create({ url, active: true });
    while ((await chrome.tabs.get(t.id!)).status !== "complete") await new Promise((r) => setTimeout(r, 20));
    return t.id;
  }, url)) as number;
  // Functional coverage may exercise the hidden-tab fallbacks even where Chromium keeps inactive tabs visible.
  // The native timing test never enables this: a simulated state cannot establish real throttling performance.
  if (simulateHidden)
    await sw.evaluate(async (id) => {
      for (const world of ["MAIN", "ISOLATED"] as const)
        await chrome.scripting.executeScript({
          target: { tabId: id },
          world,
          func: () => {
            Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
          },
        });
    }, tabId);
  await fillPage({ url: () => url } as Page, sw);
  if (switchAway) await switchTab(sw, tabId);
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
            hidden: document.hidden,
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

/** Switch within the form's own window, and confirm the form really is the inactive tab. */
async function switchTab(sw: Worker, tabId: number) {
  await sw.evaluate(async (id) => {
    const tab = await chrome.tabs.get(id);
    await chrome.tabs.create({ windowId: tab.windowId, url: "about:blank", active: true });
  }, tabId);
  await expect.poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId)).toBe(false);
}

function expectFilled(fg: Result, bg: Result) {
  for (const [mode, r] of [
    ["foreground", fg],
    ["background", bg],
  ] as const)
    expect(r, `${mode}: ${JSON.stringify(r)}`).toMatchObject({
      country: "Canada",
      type: "Co-op / Internship",
      dial: "Canada",
      school: "University of British Columbia",
    });
  expect(bg.badges).toEqual(fg.badges);
}

extensionTest(
  "hidden-tab fallbacks fill correctly and stop requesting timers after completion",
  async ({ sw, page }) => {
    extensionTest.setTimeout(120_000);
    void page; // Use the usual fixture's install-tab cleanup and rendering setup for the correctness assertions.
    await seed(sw, { caps: true, settings: { debugLogging: true, reviewFills: false } });
    await sw.evaluate(() => {
      const g = globalThis as unknown as { sleeps: number };
      g.sleeps = 0;
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === "SLEEP") g.sleeps++;
      });
    });
    const fg = await run(sw, false);
    const bg = await run(sw, true, true);
    expect(bg.hidden).toBe(true);
    expectFilled(fg, bg);
    const sleeps = () => sw.evaluate(() => (globalThis as unknown as { sleeps: number }).sleeps);
    expect(await sleeps()).toBeGreaterThan(0); // The service-worker timer bridge was actually exercised.

    // Once done, the inactive tab asks the service worker for no more timers: nothing keeps running.
    await new Promise((r) => setTimeout(r, 1500)); // waits still pending at Done (≤ 900 ms) run out
    const before = await sleeps();
    await new Promise((r) => setTimeout(r, 3000));
    expect(await sleeps()).toBe(before);
  },
);

test("a genuinely hidden tab fills at foreground speed", async ({ sw }) => {
  test.setTimeout(120_000);
  await seed(sw, { caps: true, settings: { debugLogging: true, reviewFills: false } });
  const probe = await sw.evaluate(async (url) => {
    const tab = await chrome.tabs.create({ url, active: true });
    return tab.id!;
  }, `${BASE}no-form.html`);
  await expect.poll(() => sw.evaluate(async (id) => (await chrome.tabs.get(id)).status, probe)).toBe("complete");
  await switchTab(sw, probe);
  const visibility = () =>
    sw.evaluate(async (id) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => document.visibilityState,
      });
      return result;
    }, probe);
  // Some environments keep inactive renderers visible. Never pretend they exercised hidden-tab throttling.
  let state = await visibility();
  for (let i = 0; state !== "hidden" && i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    state = await visibility();
  }
  expect(state).toMatch(/^(visible|hidden)$/);
  await sw.evaluate((id) => chrome.tabs.remove(id), probe);
  test.skip(
    state !== "hidden",
    `Chromium reports an inactive tab as ${state}; native hidden-tab timing is unavailable`,
  );
  const fg = await run(sw, false);
  const bg = await run(sw, true);
  console.log("done (ms): foreground", fg.done, "background", bg.done);
  expect(fg.visibility).toBe("visible");
  expect(bg.visibility).toBe("hidden");
  expectFilled(fg, bg);
  // Unfixed, hidden-tab timers wake once a second and this fill takes over 30 s; slack is for the tab switch.
  expect(bg.done).toBeLessThanOrEqual(fg.done * 1.25);
});
