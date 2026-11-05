// Builds the extension from the current checkout (main tree or the sweep's worktree) for run.mjs.
// usage: node tools/yolo-sweep/build.mjs [--real]   (default: dry build that stops before the final Submit)
import { execFileSync } from "node:child_process";
import path from "node:path";
import { extDir } from "./lib.mjs";

const real = process.argv.includes("--real");
const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const out = extDir(real);
execFileSync(
  process.execPath,
  [path.join(top, "node_modules/vite/bin/vite.js"), "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"],
  {
    cwd: top,
    stdio: "inherit",
    // AA_NATIVE_REQUIRED: nativeMessaging granted up front, so headless runs can use the Claude bridge.
    env: { ...process.env, VITE_YOLO_DRY: real ? "" : "1", AA_NATIVE_REQUIRED: "1" },
  },
);
console.log(`built ${real ? "real" : "dry"} extension from ${top} → ${out}`);
