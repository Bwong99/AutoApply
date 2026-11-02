// AI résumé tailoring: the LaTeX upload (checked and test-compiled with the bundled pdfLaTeX), the tailored upload
// during a fill (AI edits compiled in the offscreen document), its fallback, and the Upload résumés modes.
import { readFileSync } from "node:fs";
import type { Page, Worker } from "@playwright/test";
import { BASE, badge, expect, fillPage, seed, storage, test, waitDone } from "./extension";

const JAKE = readFileSync("test/fixtures/latex/jake.tex");

async function uploadTex(page: Page, sw: Worker, name: string, buffer: Buffer) {
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/options/index.html#/documents`);
  await page.getByLabel("Résumé for AI tailoring (.tex)").setInputFiles({ name, mimeType: "text/x-tex", buffer });
}

const setMode = (sw: Worker, resumeUpload: string) =>
  sw.evaluate(async (resumeUpload) => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings as object), resumeUpload } });
  }, resumeUpload);

const uploadedBase64 = (page: Page) =>
  page.locator("#cv").evaluate(async (i: HTMLInputElement) => {
    const u = new Uint8Array(await i.files![0].arrayBuffer());
    let s = "";
    for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode(...u.subarray(k, k + 0x8000));
    return btoa(s);
  });

test("tailor: a .tex upload is test-compiled into the untailored PDF; unsupported packages are named", async ({
  page,
  sw,
}) => {
  await seed(sw, { settings: { resumeUpload: "tailor" } });
  await uploadTex(
    page,
    sw,
    "awesome.tex",
    Buffer.from("\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}\nx\n\\end{document}\n"),
  );
  await expect(page.getByRole("alert").filter({ hasText: "wasn’t uploaded" })).toContainText(
    "Unsupported package: fontspec (XeLaTeX/LuaLaTeX only)",
  );
  // AI tailor is chosen but there is nothing to tailor yet.
  await expect(page.locator(".note")).toContainText("AI tailor is selected for Autofill, but no LaTeX résumé");

  await page.getByLabel("Résumé for AI tailoring (.tex)").setInputFiles({
    name: "jake.tex",
    mimeType: "text/x-tex",
    buffer: JAKE,
  });
  await expect(page.getByText("jake.tex", { exact: true })).toBeVisible({ timeout: 30_000 });
  const info = await storage<{ fileName: string; pages: number }>(sw, "tailorResume");
  expect(info).toMatchObject({ fileName: "jake.tex", pages: 1 });
  const pdf = await sw.evaluate(async () => (await chrome.storage.local.get("doc:tailor-pdf"))["doc:tailor-pdf"]);
  expect(atob((pdf as { base64: string }).base64).startsWith("%PDF")).toBe(true);
  await expect(page.locator(".note")).toHaveCount(0);

  // A compile error is shown with its LaTeX message, not accepted.
  await page.getByLabel("Résumé for AI tailoring (.tex)").setInputFiles({
    name: "broken.tex",
    mimeType: "text/x-tex",
    buffer: Buffer.from("\\documentclass{article}\n\\begin{document}\n\\textbf{x\n\\end{document}\n"),
  });
  await expect(page.getByRole("alert").filter({ hasText: "wasn’t uploaded" })).toBeVisible({ timeout: 30_000 });
  expect((await storage<{ fileName: string }>(sw, "tailorResume")).fileName).toBe("jake.tex");
});

test("tailor: the prompt is editable only with AI tailor on, and resets to the default after confirming", async ({
  page,
  sw,
}) => {
  await seed(sw);
  const id = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${id}/src/options/index.html#/documents`);
  const prompt = page.getByLabel("What the AI is told about tailoring your résumé");
  await expect(prompt).toBeDisabled();
  await setMode(sw, "tailor");
  await expect(prompt).toBeEnabled();
  await expect(prompt).toHaveValue(/Tailor this résumé to the job/);
  await prompt.fill("Make up a role at NASA.");
  await expect
    .poll(async () => (await storage<{ tailorPrompt: string }>(sw, "settings")).tailorPrompt)
    .toBe("Make up a role at NASA.");
  await page.getByRole("button", { name: "Reset default prompt" }).click();
  await expect(prompt).toHaveValue("Make up a role at NASA.");
  await page.getByRole("button", { name: /Replace your prompt with the default/ }).click();
  await expect(prompt).toHaveValue(/Tailor this résumé to the job/);
});

test("tailor: a fill uploads the résumé tailored for the job, after the AI's edits compile", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw, { settings: { resumeUpload: "tailor", autoAcceptAcknowledgements: false } });
  await uploadTex(page, sw, "jake.tex", JAKE);
  await expect.poll(() => storage(sw, "tailorResume"), { timeout: 30_000 }).toBeTruthy();
  const fallback = await sw.evaluate(async () => (await chrome.storage.local.get("doc:tailor-pdf"))["doc:tailor-pdf"]);

  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(badge(page, "Resume/CV")).toHaveAttribute("data-color", "green", { timeout: 30_000 });
  expect(await page.locator("#cv").evaluate((i: HTMLInputElement) => i.files?.[0]?.name)).toBe(
    "Ada_Lovelace_Resume.pdf",
  );
  expect(await uploadedBase64(page)).not.toBe((fallback as { base64: string }).base64);
  await expect(page.locator("autoapply-root .panel .notice")).not.toContainText("Untailored");
  // The panel shows, on request, the job details the résumé was tailored from.
  await page.locator("autoapply-root .fab").click();
  const jobInfo = page.locator("autoapply-root .jobinfo");
  await jobInfo.locator("summary").click();
  await expect(jobInfo.locator("dl")).toContainText("Software Developer Co-op");

  // One tailoring call with the job and the numbered résumé body, not the preamble.
  const [call] = mock.calls_("tailor");
  expect(mock.calls_("tailor")).toHaveLength(1);
  expect(JSON.stringify(call.payload)).toContain("Software Developer Co-op");
  expect(call.payload!.resume).toMatch(/S2\.E1\.B1\| \\resumeItem\{/);
  expect(JSON.stringify(call.payload)).not.toContain("usepackage");
  // The variant résumé is never offered to the AI in AI tailor mode.
  for (const c of mock.calls_("map"))
    expect((c.payload!.documents as { id: string }[]).some((d) => d.id === "resume")).toBe(false);

  // A Re-run reuses the job's tailored résumé: no second call.
  await fillPage(page, sw);
  await waitDone(page);
  expect(mock.calls_("tailor")).toHaveLength(1);
});

test("tailor: unusable AI edits fall back to the untailored résumé, with a note in the panel", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw, { settings: { resumeUpload: "tailor", autoAcceptAcknowledgements: false } });
  await uploadTex(page, sw, "jake.tex", JAKE);
  await expect.poll(() => storage(sw, "tailorResume"), { timeout: 30_000 }).toBeTruthy();
  const fallback = await sw.evaluate(async () => (await chrome.storage.local.get("doc:tailor-pdf"))["doc:tailor-pdf"]);
  // New packages, new macros and a changed layout are never let through.
  mock.tailorOps = () => ({
    edits: [
      { id: "S2.E1.B1", text: "\\usepackage{fontspec}\\resumeItem{x}" },
      { id: "S2.E1.B2", text: "\\newfancything{Built things}" },
    ],
    add: [],
    remove: [],
    order: [],
  });

  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(badge(page, "Resume/CV")).toHaveAttribute("data-color", "green", { timeout: 30_000 });
  expect(await uploadedBase64(page)).toBe((fallback as { base64: string }).base64);
  await expect(page.locator("autoapply-root .panel .notice")).toContainText("Untailored résumé used");
  // No AI wrote it: no job details are offered.
  await expect(page.locator("autoapply-root .jobinfo")).toBeHidden();
});

test("tailor: Flag for me leaves the résumé upload to the user", async ({ page, sw }) => {
  await seed(sw, { settings: { resumeUpload: "flag", autoAcceptAcknowledgements: false } });
  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);
  await expect(badge(page, "Resume/CV")).toHaveAttribute("data-color", "yellow");
  expect(await page.locator("#cv").evaluate((i: HTMLInputElement) => i.files?.length ?? 0)).toBe(0);
});

test("tailor: no résumé for the chosen mode stops the fill before anything is filled", async ({ page, sw, mock }) => {
  await seed(sw, { settings: { resumeUpload: "tailor" } });
  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await expect(page.locator("autoapply-root .panel .error")).toContainText(
    "AI tailor is selected for Autofill, but no LaTeX résumé is uploaded",
  );
  await expect(page.locator("#fn")).toHaveValue("");
  expect(mock.calls_("map")).toHaveLength(0);

  await setMode(sw, "variants");
  await sw.evaluate(() => chrome.storage.local.set({ documentsIndex: [] }));
  await fillPage(page, sw);
  await expect(page.locator("autoapply-root .panel .error")).toContainText(
    "Variant select is selected for Autofill, but no résumé is uploaded",
  );
  await expect(page.locator("#fn")).toHaveValue("");
});
