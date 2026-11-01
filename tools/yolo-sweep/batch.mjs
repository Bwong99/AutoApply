// Runs run.mjs over a list of postings, a few at a time, and records them in .yolo-sweep/tested.json.
// usage: node tools/yolo-sweep/batch.mjs <list> <outDir>   list lines: "name url [{json meta: company, title}]"
// env: P (parallel browsers, default 3: more makes typeaheads time out under load), REAL=1, MAXMIN
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { STATE, TOOLS, mkdirp, readJson, writeJson } from "./lib.mjs";

const [list, outDir] = process.argv.slice(2);
if (!list || !outDir) throw new Error("usage: node tools/yolo-sweep/batch.mjs <list> <outDir>");
mkdirp(outDir);
const jobs = fs
  .readFileSync(list, "utf8")
  .split("\n")
  .map((l) => l.trim().match(/^(\S+)\s+(\S+)\s*(.*)$/))
  .filter(Boolean)
  .map(([, name, url, meta]) => ({ name, url, meta: meta ? JSON.parse(meta) : {} }));
const P = Math.max(1, Number(process.env.P ?? 3));
const testedFile = path.join(STATE, "tested.json");
let port = 9400 + Math.floor(Math.random() * 50) * 10;

function one({ name, url, meta }) {
  const env = { ...process.env, PORT: String(port++), COMPANY: meta.company ?? "", TITLE: meta.title ?? "" };
  if (!meta.company) delete env.COMPANY;
  if (!meta.title) delete env.TITLE;
  return new Promise((res) => {
    const c = spawn(process.execPath, [path.join(TOOLS, "run.mjs"), url, path.join(outDir, name)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", () => {
      const s = readJson(path.join(outDir, `${name}.json`), {
        url,
        name,
        status: "CRASH",
        reason: err.trim().split("\n").slice(-3).join(" ").slice(0, 300),
        flags: 0,
      });
      const tested = readJson(testedFile, {});
      tested[url] = { status: s.status, flags: s.flags, at: new Date().toISOString(), run: path.join(outDir, name) };
      writeJson(testedFile, tested);
      const line = `${s.status.padEnd(9)} flags=${String(s.flags).padEnd(3)} ${name} ${s.reason ? "— " + s.reason.slice(0, 140) : ""}`;
      console.log(line);
      res(line);
    });
  });
}

const queue = [...jobs];
const lines = [];
await Promise.all(
  Array.from({ length: Math.min(P, queue.length) }, async () => {
    while (queue.length) lines.push(await one(queue.shift()));
  }),
);
fs.writeFileSync(path.join(outDir, "summary.txt"), lines.sort().join("\n") + "\n");
