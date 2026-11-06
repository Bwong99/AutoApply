// Playwright fixtures: a persistent Chromium context with the unpacked extension from dist/,
// the Gemini mock routed in, and helpers to seed storage through the service worker.
import { test as base, chromium, expect, type BrowserContext, type Page, type Worker } from "@playwright/test";
import path from "node:path";
import { MockGemini } from "../mockGemini";
import { SCHEMA_VERSION } from "../../src/shared/storage";

export const BASE = "http://localhost:5501/jobs/";
const EXT = path.resolve("dist");

// A tiny but valid one-page PDF.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj " +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
).toString("base64");

export const PROFILE = {
  personal: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    phone: { countryCode: "+1", number: "6045551234", type: "mobile" },
    address: { city: "Vancouver", region: "British Columbia", regionCode: "BC", country: "Canada", countryCode: "CA" },
    links: { linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada" },
  },
  workAuthorization: {
    entries: [
      {
        country: "Canada",
        authorized: "yes",
        status: "Citizen",
        requiresSponsorshipNow: "no",
        requiresSponsorshipFuture: "no",
      },
    ],
    over18: "yes",
  },
  education: [
    {
      school: "University of British Columbia",
      degree: "BSc",
      major: "Computer Science",
      expectedGraduation: "2028-05",
    },
  ],
  preferences: { willingToRelocate: "yes", workArrangement: ["hybrid", "remote"], earliestStartDate: "2027-05-01" },
  demographics: { gender: "decline", veteranStatus: "decline", raceEthnicity: ["decline"] },
  resumeText: "Ada Lovelace — Computer Science student at UBC. Built analytics tooling in TypeScript.",
  learnedAnswers: [],
};

export interface SeedOptions {
  settings?: Record<string, unknown>;
  keys?: number;
  selectedModel?: string | null;
  fallbackModel?: string | null;
  profile?: Record<string, unknown>;
  /** Pre-probed model capabilities, so the first Gemini call is the real request (no validation probe). */
  caps?: boolean;
  /** A real API key (live smoke test); replaces the fake keys. */
  apiKey?: string;
}

export async function seed(sw: Worker, o: SeedOptions = {}) {
  await sw.evaluate(
    async ({ o, profile, pdf, schemaVersion }) => {
      // Wait for the worker's startup migration so it cannot overwrite the seed.
      while ((await chrome.storage.local.get("schemaVersion")).schemaVersion !== schemaVersion)
        await new Promise((r) => setTimeout(r, 20));
      const keys = o.apiKey
        ? [{ id: "live", label: "Live", key: o.apiKey, addedAt: 0 }]
        : Array.from({ length: o.keys ?? 3 }, (_, i) => ({
            id: `k${i + 1}`,
            label: `Key ${i + 1}`,
            key: `test-key-${i + 1}`,
            addedAt: i,
          }));
      await chrome.storage.local.set({
        settings: { ...o.settings },
        profile: o.profile ?? profile,
        apiKeys: keys,
        keyState: {},
        selectedModel: o.selectedModel === undefined ? "gemini-2.5-flash-lite" : o.selectedModel,
        fallbackModel: o.fallbackModel ?? null,
        documentsIndex: [
          {
            id: "resume",
            label: "Résumé",
            kind: "resume",
            fileName: "ada-resume.pdf",
            mimeType: "application/pdf",
            size: 200,
            isPrimaryResume: true,
            uploadedAt: 1,
          },
        ],
        "doc:resume": { base64: pdf },
      });
      if (o.caps) {
        const caps = {
          thinking: { kind: "level", value: "minimal" },
          schema: "responseSchema",
          verifiedAt: Date.now(),
        };
        await chrome.storage.local.set({
          modelCapabilities: Object.fromEntries(
            [o.selectedModel ?? "gemini-2.5-flash-lite", o.fallbackModel].filter(Boolean).map((m) => [m, caps]),
          ),
        });
      }
    },
    { o, profile: PROFILE, pdf: PDF, schemaVersion: SCHEMA_VERSION },
  );
}

export const test = base.extend<{
  useMock: boolean;
  mock: MockGemini;
  context: BrowserContext;
  sw: Worker;
  page: Page;
}>({
  useMock: [true, { option: true }],
  mock: async ({}, use) => use(new MockGemini()),
  context: async ({ mock, useMock }, use) => {
    // Playwright's bundled Chromium in the new headless mode supports extensions (no xvfb needed).
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    if (useMock) await mock.install(context);
    await use(context);
    await context.close();
  },
  sw: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    await use(sw);
  },
  page: async ({ context, sw }, use) => {
    void sw;
    // The install-time options tab must not keep the test page in the background (no rAF there).
    const isSetup = (p: Page) => p.url().includes("options/index.html");
    if (!context.pages().some(isSetup))
      await context.waitForEvent("page", { predicate: isSetup, timeout: 5000 }).catch(() => null);
    for (const p of context.pages()) await p.close();
    const page = await context.newPage();
    await page.bringToFront();
    await use(page);
  },
});

export { expect };

/** Badge tag for a field, by the field's label (badges live in <autoapply-root>'s open shadow root). */
export const badge = (page: Page, label: string) => page.locator(`autoapply-root .tag[aria-label^="${label}:"]`);

/** Same as the popup's Fill this page: TRIGGER_FILL to every frame of the page's tab, once each frame is listening. */
export async function fillPage(page: Page, sw: Worker) {
  await sw.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
    if (tab?.id === undefined) throw new Error(`No tab for ${url}`);
    const tabId = tab.id;
    const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => 0 });
    await Promise.all(
      frames.map(async ({ frameId }) => {
        // A content script answers only after it has loaded its config.
        for (let i = 0; i < 100; i++) {
          const msg = { type: "TRIGGER_FILL", force: true };
          if (await chrome.tabs.sendMessage(tabId, msg, { frameId }).catch(() => null)) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`Frame ${frameId} never answered TRIGGER_FILL`);
      }),
    );
  }, page.url());
}

export async function waitDone(page: Page) {
  await expect(page.locator("autoapply-root .panel .status")).toHaveText(/^Done ·/, { timeout: 20_000 });
}

export const forbidden = (page: Page) =>
  page.evaluate(() => (window as unknown as { __forbidden: string[] }).__forbidden);

export async function storage<T>(sw: Worker, key: string): Promise<T> {
  return sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key) as Promise<T>;
}
