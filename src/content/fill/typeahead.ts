// §14.6 typeahead: type, wait for suggestions, pick by safe local match or the AI.
import { collapse, normalize } from "../../shared/normalize";
import { localMatch } from "../match/localMatch";
import type { FieldHandle } from "../scan/fields";
import {
  busy,
  closeDropdown,
  findOptionsContainer,
  optText,
  optionElements,
  PAGE_MAX_MS,
  settle,
  snapshot,
  submitSearch,
} from "./dropdown";
import { blur, focus, key, realClick, setNativeValue, sleep, typeText, waitFor } from "./events";
import type { FillResult } from "./native";
import { dropdownText, sameValue } from "./verify";
import { isVisible } from "../scan/visibility";

/** The pick a combobox shows beside its emptied search box: react-select's single value (Epic Games). */
function shownBeside(input: HTMLElement): string {
  // Up to the question's label; not a screen-reader copy (select2 3.x keeps one beside its keyboard proxy).
  const question = (p: Element) =>
    [...p.querySelectorAll("label")].some((l) => !/offscreen|sr-only|visually-hidden/.test(l.className));
  let p = input.parentElement;
  for (let i = 0; i < 4 && p && !question(p); i++, p = p.parentElement) {
    const clone = p.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('input,svg,script,style,[aria-live],[class*="placeholder" i],[class*="a11y" i]')
      .forEach((n) => n.remove());
    const t = collapse(clone.textContent ?? "");
    if (t) return t;
  }
  return "";
}

/** "BC" for British Columbia, "QC" for Quebec: a 2–3 letter code whose letters run in order from the name's first. */
export function abbreviates(code: string, name: string): boolean {
  const n = normalize(name);
  if (!/^[A-Z]{2,3}$/.test(code.trim()) || n.length <= 3) return false;
  const c = code.trim().toLowerCase();
  let j = 0;
  for (const ch of n) if (ch === c[j]) j++;
  return n[0] === c[0] && j === c.length;
}

const plainLists = (h: FieldHandle) => [...h.container.querySelectorAll<HTMLElement>("ul,ol")];

export async function fillTypeahead(
  h: FieldHandle,
  query: string,
  intended: string,
  choose: (options: string[]) => Promise<number | null>,
): Promise<FillResult> {
  const input = (h.searchInput ?? h.el) as HTMLInputElement;
  if (normalize(input.value) && normalize(input.value) === normalize(intended))
    return { outcome: "ok", shown: input.value };
  // The site's own code for the name, set by another pick: Oracle's city sets Province "BC", which lists no "British
  // Columbia" to type.
  if (abbreviates(input.value, intended)) return { outcome: "ok", shown: input.value };
  let typed = query || intended;
  const suggest = async () => {
    const before = snapshot();
    const shown = new Set(plainLists(h).filter(isVisible));
    focus(input);
    // An input event with nothing to clear already opens some lists (select2 3.x), taking focus before we type.
    if (input.value) setNativeValue(input, "");
    await typeText(input, typed);
    if (h.searchInput) submitSearch(input);
    // A plain list beside the box that shows up naming what was typed (legacy Greenhouse's place search).
    const word = normalize(typed).split(" ")[0];
    const plain = () =>
      plainLists(h).find(
        (l) => !shown.has(l) && isVisible(l) && optionElements(l).some((o) => normalize(optText(o)).includes(word)),
      ) ?? null;
    let c = await waitFor(() => findOptionsContainer(h, before) ?? plain(), 2000);
    // A slow suggestion search (Lever's location lookup) shows its spinner meanwhile: wait it out.
    if (!c && busy([h.container])) {
      await waitFor(() => findOptionsContainer(h, before) || !busy([h.container]), PAGE_MAX_MS);
      c = findOptionsContainer(h, before);
    }
    if (c) await settle(c);
    return c;
  };
  let c = await suggest();
  // A place search may find nothing for "Vancouver, BC" and plenty for "Vancouver" (SmartRecruiters). An address
  // search finds "7396 202 Street Langley", not the full address or its street alone (Teamtailor): street and city
  // first, then the first part.
  const parts = typed.split(",").map((p) => p.trim());
  const first = normalize(parts[0]).split(" ").slice(0, 2).join(" "); // "7396 202" lists as "7396 202 St"
  const lists = (box: HTMLElement | null) =>
    !!box && optionElements(box).some((o) => normalize(optText(o)).includes(first));
  for (const next of new Set([parts.length > 2 ? `${parts[0]} ${parts[1]}` : parts[0], parts[0]])) {
    if (next === typed.trim() || lists(c)) continue;
    // Closed first, so the reopened list reads as new.
    await closeDropdown(h, c);
    typed = next;
    c = await suggest();
  }
  // A country-only picker finds nothing for the city (Airwallex's Ashby "Location" lists "Canada", not "Langley").
  const places = intended.split(",").map((p) => p.trim());
  const country = places.length > 1 ? places[places.length - 1] : "";
  // Not a field asking the city: Oracle's City, slow to list "Langley" in the hidden frame, listed "Canada Creek, NS".
  if (country && !/\bcity\b/i.test(h.desc.label) && normalize(country) !== normalize(typed) && !lists(c)) {
    await closeDropdown(h, c);
    typed = country;
    c = await suggest();
  }
  if (!c) {
    // A dropdown's search box only filters its list: text left there selects nothing.
    if (h.desc.kind === "dropdown") {
      setNativeValue(input, "");
      key(input, "Escape");
    }
    blur(input);
    await sleep(50);
    return input.value
      ? { outcome: "ok", shown: input.value, note: "No suggestion list; typed value" }
      : { outcome: "flag", note: "No suggestions appeared" };
  }
  let els = optionElements(c);
  let texts = els.map(optText);
  const q = normalize(typed);
  let i = localMatch(intended, texts);
  // Suggestions for an earlier keystroke may still show, the search for the whole query pending (select2's delay).
  if (i === null) {
    const stale = texts.join("\n");
    const box = c;
    if (await waitFor(() => box.isConnected && optionElements(box).map(optText).join("\n") !== stale, 600)) {
      await settle(box);
      els = optionElements(box);
      texts = els.map(optText);
      i = localMatch(intended, texts);
    }
  }
  if (i === null && texts.length === 1 && normalize(texts[0]).startsWith(q)) i = 0;
  if (i === null) i = await choose(texts);
  if (i === null || !els[i]) {
    await closeDropdown(h, c);
    return { outcome: "flag", note: `No suggestion matched "${intended}"` };
  }
  const want = texts[i];
  let el: HTMLElement | undefined = els[i];
  // The AI takes seconds to choose; another fill taking focus meanwhile closes the list, detaching the option.
  if (!el.isConnected || optText(el) !== want) {
    const again = await suggest();
    el = again ? optionElements(again).find((o) => optText(o) === want) : undefined;
    if (!el) {
      await closeDropdown(h, again);
      blur(input);
      return { outcome: "failed", note: `Could not select "${want}"` };
    }
  }
  const open = input.getAttribute("aria-expanded") === "true";
  realClick(el);
  await sleep(40);
  // Our click closed the list while the box keeps only the pick's leading part: Oracle's city shows "Langley" for
  // "Langley, BC", its postal code "V2Y 3C7" for "V2Y 3C7, Langley, BC".
  const leading = () =>
    open &&
    input.getAttribute("aria-expanded") === "false" &&
    !!input.value &&
    normalize(want).startsWith(normalize(input.value));
  // A place pick may look up its details before the box shows it (Teamtailor's address, ~1.5 s).
  if (
    h.desc.kind !== "dropdown" &&
    normalize(input.value) === normalize(typed) &&
    normalize(want) !== normalize(typed) &&
    !leading()
  )
    await waitFor(() => normalize(input.value) !== normalize(typed), 3000);
  const kept = leading();
  blur(input);
  // A dropdown's search box empties once an option is picked; the widget shows the pick.
  if (h.desc.kind === "dropdown")
    return sameValue(want, dropdownText(h), "contains")
      ? { outcome: "ok", shown: want }
      : { outcome: "mismatch", note: `Expected "${want}", shows "${dropdownText(h)}"` };
  const v = normalize(input.value || h.el.textContent || shownBeside(input));
  // Our own query left in the box ("Langley" of "Langley, BC") means the pick did not register.
  const picked = kept || v.includes(normalize(want)) || (normalize(want).includes(v) && v !== normalize(typed));
  if (!v) return { outcome: "failed", note: `Expected "${want}", but the selection was cleared` };
  return picked
    ? { outcome: "ok", shown: want }
    : { outcome: "mismatch", note: `Expected "${want}", shows "${input.value}"` };
}
