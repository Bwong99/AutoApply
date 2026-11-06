// Maintainer-only update. Never fetched by the running extension.
import { writeFile } from "node:fs/promises";
const source = "https://fortune.com/ranking/fortune500/";
const response = await fetch(source);
if (!response.ok) throw new Error(`Fortune returned ${response.status}`);
const html = await response.text();
const embedded = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
if (!embedded) throw new Error("Fortune page format changed");
const page = JSON.parse(embedded[1]).props.pageProps;
const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) =>
  JSON.parse(m[1]),
);
const list = blocks.find((b) => b.itemListElement?.length === 1000)?.itemListElement;
const companies = list?.map((c) => ({ rank: Number(c.position), name: c.item.name }));
// Equal revenues can produce tied ranks; preserve Fortune's ranks rather than renumbering them.
if (
  !companies ||
  companies.length !== 1000 ||
  new Set(companies.map((c) => c.name)).size !== 1000 ||
  companies.some(
    (c, i) =>
      !Number.isInteger(c.rank) || c.rank < 1 || c.rank > 1000 || !c.name || (i && c.rank < companies[i - 1].rank),
  )
)
  throw new Error("Expected 1,000 unique companies in rank order");
const year = Number(page.franchiseSearch.year);
if (!Number.isInteger(year) || year < 2026) throw new Error("Invalid ranking year");
await writeFile(
  new URL("../src/background/yolo/fortune.json", import.meta.url),
  JSON.stringify({ year, source, verifiedAt: new Date().toISOString().slice(0, 10), companies }, null, 2) + "\n",
);
console.log(`Verified ${companies.length} companies for ${year}`);
