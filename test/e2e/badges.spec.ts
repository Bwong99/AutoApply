import { BASE, badge, expect, fillPage, seed, test, waitDone } from "./extension";

test("badges: outlines stay on their fields through window and inner-container scrolling", async ({ page, sw }) => {
  await page.setViewportSize({ width: 900, height: 400 });
  await seed(sw);
  await page.goto(BASE + "plain.html");
  await page.evaluate(() => {
    const f = document.querySelector("form")!;
    const s = document.createElement("div");
    s.style.cssText = "height: 300px; overflow: auto";
    f.before(s);
    s.append(f);
    document.body.style.height = "3000px";
  });
  await fillPage(page, sw);
  await waitDone(page);
  await expect(badge(page, "Email")).toHaveAttribute("data-color", "green");
  await page.evaluate(() => {
    scrollTo(0, 50);
    document.querySelector("form")!.parentElement!.scrollTop = 120;
  });
  // Chrome moves anchored boxes for a scroll at the next frame: measure after it, not mid-way.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Each box is CSS-anchored (no scroll handler involved) and sits 3px outside its field on every side.
  const offsets = await page.evaluate(() =>
    [...document.querySelector("autoapply-root")!.shadowRoot!.querySelectorAll<HTMLElement>(".box")].map((b) => {
      const t = [...document.querySelectorAll<HTMLElement>("[style*=anchor-name]")].find((e) =>
        e.style.getPropertyValue("anchor-name").includes(`--${b.part[0]}`),
      )!;
      const [br, tr] = [b.getBoundingClientRect(), t.getBoundingClientRect()];
      return [br.left - tr.left, br.top - tr.top, br.width - tr.width, br.height - tr.height].map(Math.round);
    }),
  );
  expect(offsets.length).toBe(9);
  for (const o of offsets) expect(o).toEqual([-3, -3, 6, 6]);
});

test("badges: page popups paint over both the outline and the tag", async ({ page, sw }) => {
  await seed(sw);
  await page.goto(BASE + "plain.html");
  await fillPage(page, sw);
  await waitDone(page);
  const tag = badge(page, "Email");
  await expect(tag).toHaveAttribute("data-color", "green");
  const box = (await tag.boundingBox())!;
  const top = await page.evaluate(
    ({ x, y }) => {
      const pop = Object.assign(document.createElement("div"), { id: "popup" });
      pop.style.cssText = "position: fixed; inset: 0; z-index: 10; background: #fff";
      document.body.append(pop);
      return document.elementFromPoint(x, y)?.id;
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(top).toBe("popup");
});
