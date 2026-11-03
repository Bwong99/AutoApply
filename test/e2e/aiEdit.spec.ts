import { BASE, badge, expect, fillPage, seed, test, waitDone } from "./extension";

test("edit with AI: a prompt rewrites an answer from the job, and the field changes only on Use this", async ({
  page,
  sw,
  mock,
}) => {
  await seed(sw);
  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);
  const why = page.locator("#why");
  const drafted = await why.inputValue();
  const edit = page.locator("autoapply-root .edit-ai");

  // Not on a field the profile answers.
  await page.locator("#fn").focus();
  await expect(edit).toHaveCount(0);
  await why.focus();
  await edit.click();

  const box = page.getByRole("dialog", { name: "Edit with AI" });
  await box.getByRole("textbox", { name: "What should change" }).fill("Mention robot fleets");
  await box.getByRole("button", { name: "Rewrite" }).click();
  const result = box.getByRole("textbox", { name: "Rewritten answer" });
  await expect(result).toHaveValue("Rewritten: Mention robot fleets");
  await expect(why).toHaveValue(drafted);

  const call = mock.calls_("edit")[0].payload as { current: string; job: { description: string }; maxWords: number };
  expect(call.current).toBe(drafted);
  expect(call.job.description).toContain("robot fleet software");
  expect(call.maxWords).toBe(120);

  // Asked again, it changes the rewrite shown.
  await box.getByRole("textbox", { name: "What should change" }).fill("Shorter");
  await box.getByRole("button", { name: "Try again" }).click();
  await expect(result).toHaveValue("Rewritten: Shorter");
  expect((mock.calls_("edit")[1].payload as { current: string }).current).toBe("Rewritten: Mention robot fleets");

  await box.getByRole("button", { name: "Use this" }).click();
  await expect(box).toHaveCount(0);
  await expect(why).toHaveValue("Rewritten: Shorter");
  await expect(badge(page, "Why do you want to work at Acme Robotics? (max 120 words)")).toHaveAttribute(
    "data-color",
    "purple",
  );

  // Cancelled: the field keeps its answer.
  await page.locator("#fn").focus();
  await why.focus();
  await edit.click();
  await box.getByRole("textbox", { name: "What should change" }).fill("Longer");
  await box.getByRole("button", { name: "Rewrite" }).click();
  await expect(result).toHaveValue("Rewritten: Longer");
  await box.getByRole("button", { name: "Cancel" }).click();
  await expect(box).toHaveCount(0);
  await expect(why).toHaveValue("Rewritten: Shorter");
});
