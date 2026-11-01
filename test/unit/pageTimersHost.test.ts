import { expect, test } from "vitest";

test("Greenhouse's embed script reads the host frame's own address, not the extension's top page", async () => {
  Object.defineProperty(location, "ancestorOrigins", { value: ["chrome-extension://x"], configurable: true });
  await import("../../src/content/pageTimers");
  const w = window as unknown as { Grnhse: { UriHelper: { currentLocation: () => Location } } };
  // As boards.greenhouse.io/embed/job_board/js does it: `var Grnhse = Grnhse || {}`, then its helpers.
  w.Grnhse = w.Grnhse || ({} as typeof w.Grnhse);
  w.Grnhse.UriHelper = {
    currentLocation: () => {
      throw new DOMException("Blocked a frame from accessing a cross-origin frame", "SecurityError");
    },
  };
  expect(w.Grnhse.UriHelper.currentLocation()).toBe(location);
});

test("anti-clickjacking's hidden body shows in the host frame", () => {
  document.head.insertAdjacentHTML("beforeend", `<style id="antiClickjack">body{display:none !important;}</style>`);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  expect(document.getElementById("antiClickjack")).toBeNull();
});
