import type { Page, Worker } from "@playwright/test";
import { BASE, badge, expect, seed, test } from "./extension";

/** What the background sends for the context menu's Fill with AutoApply (or, `key`, its shortcut). */
async function pick(page: Page, sw: Worker, via: "menu" | "key") {
  await sw.evaluate(
    async ({ url, via }) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
      if (tab?.id === undefined) throw new Error(`No tab for ${url}`);
      for (let i = 0; i < 100; i++) {
        const sent = await chrome.tabs
          .sendMessage(tab.id, { type: "PICK_FIELD", via }, { frameId: 0 })
          .catch(() => null);
        if (sent) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("The page never answered PICK_FIELD");
    },
    { url: page.url(), via },
  );
}

const card = (page: Page) => page.getByRole("dialog", { name: "Fill with AutoApply" });

test("fill this field: blank answers from the Profile, with no AI call", async ({ page, sw, mock }) => {
  await seed(sw, { caps: true });
  await page.goto(BASE + "semantic.html");
  await page.locator("#fn").dispatchEvent("contextmenu");
  await pick(page, sw, "menu");
  await expect(card(page)).toContainText('"First name"');
  await card(page).getByRole("button", { name: "Generate" }).click();
  await expect(card(page)).toContainText("Filled");
  await expect(page.locator("#fn")).toHaveValue("Ada");
  await expect(badge(page, "First name")).toHaveAttribute("data-color", "green");
  // Only that field: nothing else on the page was touched.
  await expect(page.locator("#em")).toHaveValue("");
  expect(mock.calls_("map")).toHaveLength(0);
});

test("fill this field: an instruction is the answer, sent only with that field", async ({ page, sw, mock }) => {
  await seed(sw, { caps: true });
  await page.goto(BASE + "semantic.html");
  const Q = "What is your favourite programming language?";
  // Right-clicking the question, not its box, picks the field too.
  await page.locator('label[for="lang"]').dispatchEvent("contextmenu");
  await pick(page, sw, "menu");
  await card(page).getByRole("textbox").fill("TypeScript");
  await card(page).getByRole("textbox").press("Enter");
  await expect(card(page)).toContainText("Filled by AI");
  await expect(page.locator("#lang")).toHaveValue("TypeScript");
  const calls = mock.calls_("map");
  expect(calls).toHaveLength(1);
  expect(calls[0].payload!.candidateInstruction).toBe("TypeScript");
  expect((calls[0].payload!.fields as { label: string }[]).map((f) => f.label)).toEqual([Q]);
  // The card stays for the next instruction; Escape closes it.
  await card(page).getByRole("textbox").press("Escape");
  await expect(card(page)).toHaveCount(0);
});

test("fill this field: the shortcut picks the focused field", async ({ page, sw }) => {
  await seed(sw, { caps: true });
  await page.goto(BASE + "semantic.html");
  await page.locator("#em").focus();
  await pick(page, sw, "key");
  await expect(card(page)).toContainText('"Email"');
  await expect(card(page).getByRole("textbox")).toBeFocused();
});
