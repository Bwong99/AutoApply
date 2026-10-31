import { expect, test, vi } from "vitest";

test("page scroll calls are blocked only while locked", async () => {
  const spy = vi.fn();
  Element.prototype.scrollIntoView = spy;
  await import("../../src/content/scrollLock");
  const el = document.createElement("div");

  document.dispatchEvent(new Event("autoapply-scroll-lock"));
  el.scrollIntoView();
  expect(spy).not.toHaveBeenCalled();

  document.dispatchEvent(new Event("autoapply-scroll-unlock"));
  el.scrollIntoView();
  expect(spy).toHaveBeenCalledOnce();
  // Unlocked, the page has its own functions back (bot checks look for patched ones).
  expect(Element.prototype.scrollIntoView).toBe(spy);
});
