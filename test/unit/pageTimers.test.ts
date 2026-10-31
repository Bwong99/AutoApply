import { expect, test, vi } from "vitest";

test("page timers are fired early only during a fill in a hidden tab", async () => {
  const native = window.setTimeout;
  await import("../../src/content/pageTimers");
  expect(window.setTimeout).toBe(native); // patched only during a fill: bot checks look for patched built-ins
  const asked: string[] = [];
  document.addEventListener("autoapply-timer", (e) => asked.push((e as CustomEvent<string>).detail));
  const fire = (detail: string) => document.dispatchEvent(new CustomEvent("autoapply-timer-fire", { detail }));
  Object.defineProperty(document, "hidden", { value: true, configurable: true });

  const idle = vi.fn();
  setTimeout(idle, 300);
  expect(asked).toEqual([]); // no fill running

  document.dispatchEvent(new Event("autoapply-fill-start"));
  const ran = vi.fn();
  const id = setTimeout(ran, 300, "arg");
  expect(asked).toEqual([`${id}:300`]);
  fire(String(id));
  fire(String(id));
  expect(ran).toHaveBeenCalledExactlyOnceWith("arg");

  const cleared = vi.fn();
  const id2 = setTimeout(cleared, 50);
  clearTimeout(id2);
  fire(String(id2));
  setTimeout(vi.fn(), 5000); // long timers are left to the page
  expect(asked).toHaveLength(2);

  document.dispatchEvent(new Event("autoapply-fill-end"));
  expect(window.setTimeout).toBe(native);
  await new Promise((r) => setTimeout(r, 350));
  expect(ran).toHaveBeenCalledOnce(); // the page's own fallback timer was cancelled
  expect(cleared).not.toHaveBeenCalled();
  expect(idle).toHaveBeenCalledOnce();
});
