// Where a location line points, down to its region and city, so a wanted country or region covers every place in it.
import { canonicalCountry, canonicalRegion, HUBS, regionCountry } from "../../shared/constants";
import { normalize } from "../../shared/normalize";

/** Normalized names; a missing region or city means the whole country or region. */
export type Place = { country: string; region?: string; city?: string };

/** Built by scripts/make-places.mjs; fetched, not bundled, so the service worker stays small on every wake. */
export const PLACES_FILE = "places.txt";

// Empty until loadPlaces: names then resolve as countries, Canadian provinces, US states and hubs only.
/** First-level regions by line of PLACES_FILE. */
let regions: Place[] = [];
/** "\ncity|region line in base 36" per city, by name then most populous first. */
let cities = "";
/** Where each city line starts, for binary search: the list stays one string instead of 39k objects. */
let starts = new Int32Array(0);

/** Reads PLACES_FILE once per service worker life; a failed read leaves names-only matching and retries next time. */
export async function loadPlaces(
  read = () => fetch(chrome.runtime.getURL(PLACES_FILE)).then((r) => r.text()),
): Promise<void> {
  if (cities) return;
  const text = await read().catch((e: Error) => void console.warn("[AutoApply] Places failed:", e?.message));
  if (!text) return;
  // Regions, a blank line, then the cities, each line led by its "\n".
  const split = text.indexOf("\n\n");
  // Canada's and the US's names are canonicalRegion's already, so "BC" finds British Columbia's cities.
  regions = text
    .slice(0, split)
    .split("\n")
    .map((l) => {
      const [name, cc] = l.split("|");
      const country = canonicalCountry(cc) ?? cc;
      return name ? { country, region: name } : { country };
    });
  const at: number[] = [];
  const list = text.slice(split + 1);
  for (let i = list.indexOf("\n"); i >= 0; i = list.indexOf("\n", i + 1)) at.push(i + 1);
  starts = Int32Array.from(at);
  cities = list;
}

/** Short forms job lists write for a city: Simplify's "SF", "South SF". */
const ALIASES: Record<string, string> = { sf: "san francisco", "south sf": "south san francisco" };
/** "St Paul" is "Saint Paul" in the city list, "St Louis" is "St Louis": a city is looked up both ways. */
const ABBREVIATED: Record<string, string> = {
  st: "saint",
  saint: "st",
  ft: "fort",
  fort: "ft",
  mt: "mount",
  mount: "mt",
};

/** Every place a name may mean, likeliest first: a province or state, a country, another region, a city, a hub. */
function meanings(part: string): Place[] {
  const n = normalize(part);
  const s = ALIASES[n] ?? n;
  if (!s) return [];
  const out: Place[] = [];
  const region = canonicalRegion(s);
  if (region) out.push({ country: regionCountry(s)!, region });
  const country = canonicalCountry(s);
  if (country) out.push({ country });
  // Job lists write Los Angeles as "LA" too: "Northridge, LA", "Woodland Hills, LA".
  if (s === "la") out.push({ country: "united states", region: "california" });
  // Canada's and the US's regions came first, by code or name.
  for (const r of regions) if (r.region === s && r.country !== "canada" && r.country !== "united states") out.push(r);
  // Two letters are codes, not towns.
  if (s.length > 2) {
    const other = s.replace(/^(\w+) /, (m, w: string) => (ABBREVIATED[w] ? `${ABBREVIATED[w]} ` : m));
    for (const name of other === s ? [s] : [s, other]) {
      const before = out.length;
      for (let k = firstCity(name); k < starts.length && cityName(k) === name; k++) {
        const at = starts[k] + name.length + 1;
        const end = cities.indexOf("\n", at);
        out.push({ ...regions[parseInt(cities.slice(at, end < 0 ? undefined : end), 36)], city: name });
      }
      if (out.length > before) break;
    }
  }
  if (HUBS[s]) out.push({ country: HUBS[s] }); // "Bay Area", "NYC"
  // LinkedIn's "Greater Vancouver Metropolitan Area", "Downtown Toronto".
  const bare = s.replace(/\b(greater|downtown|metro(politan)?|area|region)\b/g, "").trim();
  return out.length || bare === s ? out : meanings(bare);
}

const cityName = (k: number) => cities.slice(starts[k], cities.indexOf("|", starts[k]));
/** The first line named s, or where it would be. */
function firstCity(s: string): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cityName(mid) < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const fits = (a: string | undefined, b: string | undefined) => !a || !b || a === b;
/** One place, if a and b can be the same: the more specific of them. */
const merge = (a: Place, b: Place): Place | null =>
  a.country === b.country && fits(a.region, b.region) && fits(a.city, b.city)
    ? { country: a.country, region: a.region ?? b.region, city: a.city ?? b.city }
    : null;

/**
 * What one place ("Kelowna, BC", "Toronto, ON, CA", "Hybrid - San Francisco") may mean, likeliest first. Each part
 * narrows the meanings; a part that fits none is ignored ("Hybrid", "HQ"). A state or country that fits none of the
 * city's meanings outranks them: "Malvern, PA" is in Pennsylvania (the list has only Ontario's and Arkansas's Malvern),
 * "Malta, NY" in New York.
 */
export function resolvePlace(place: string): Place[] {
  let pick: Place[] = [];
  for (const part of place.split(/[,()/]| - /)) {
    const options = meanings(part);
    const both = pick.flatMap((a) => options.flatMap((b) => merge(a, b) ?? []));
    const wider = options.filter((o) => !o.city);
    pick = !pick.length ? options : both.length ? both : wider.length ? wider : pick;
  }
  return pick;
}

/** Whether every part of `inner` lies in `outer`: Kelowna in British Columbia, British Columbia in Canada. */
export const within = (inner: Place, outer: Place): boolean =>
  inner.country === outer.country &&
  (!outer.region || outer.region === inner.region) &&
  (!outer.city || outer.city === inner.city);
